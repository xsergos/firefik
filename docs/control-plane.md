# Control plane (gRPC protocol reference)

Firefik's central control plane is a **gRPC-only** service.

## Topology

```
  ┌──────────────────┐       gRPC bidi stream (TLS 1.3 + mTLS)
  │   firefik-back   │ ───────────────────────────────────────▶  ┌────────────────┐
  │     (agent)      │                                           │ firefik-server │
  └──────────────────┘       HTTP (/healthz + /v1/enroll)        │ (control plane)│
                      ───────────────────────────────────────▶  └────────────────┘
```

- gRPC listener (default `:8444`) — all operational traffic (register,
  stream events, commands, acks).
- HTTP listener (default `:8443`) — bootstrap only. Serves `/healthz`
  and `/v1/enroll` (cert issuance).

## TLS posture

- TLS 1.3, mutual auth. Agents present a client cert signed by the
  control-plane CA.
- The embedded mini-CA (`firefik-server mini-ca`) issues short-lived
  SPIFFE-compatible certs. External CAs (cert-manager, step-ca) are also
  supported via `--client-ca` on the server + `FIREFIK_CONTROL_PLANE_CLIENT_CERT`
  / `_CLIENT_KEY` on the agent.
- Optional: set `FIREFIK_CP_TRUST_DOMAIN=spiffe://<domain>/` on the
  server to reject any peer cert whose URI SAN is not under that trust
  domain. Metric: `firefik_controlplane_mtls_rejected_total{reason}`.

## Bootstrap (mini-CA flow)

1. On the control-plane host:
   ```
   firefik-server mini-ca init --state-dir /var/lib/firefik-server/ca \
                               --trust-domain spiffe://prod.corp/
   ```
   Generates a root + issuing CA under the state dir. Idempotent.
2. Start `firefik-server` — the CA is picked up automatically and the
   `/v1/enroll` endpoint becomes available.
3. On each agent:
   ```
   firefik-admin enroll --control-plane=https://cp.example:8443 \
                        --token=$CP_BOOTSTRAP_TOKEN \
                        --agent-id=host-a \
                        --out=/var/lib/firefik/control-plane
   ```
   Drops `client.crt`, `client.key`, `ca-bundle.pem`. Agent-side env:
   - `FIREFIK_CONTROL_PLANE_GRPC=cp.example:8444`
   - `FIREFIK_CONTROL_PLANE_CA_CERT=/var/lib/firefik/control-plane/ca-bundle.pem`
   - `FIREFIK_CONTROL_PLANE_CLIENT_CERT=/var/lib/firefik/control-plane/client.crt`
   - `FIREFIK_CONTROL_PLANE_CLIENT_KEY=/var/lib/firefik/control-plane/client.key`
4. Rotate near expiry:
   ```
   firefik-admin enroll --renew --renew-window=72h ...
   ```

## Edge enrollment (one-time token)

For Portainer-edge-style self-enrollment without distributing the static
bearer to every host, the panel issues a single-use enrollment token and
the new host exchanges it for a short-lived mTLS cert.

1. Operator opens **Add agent** in the panel (or POSTs
   `/v1/enrollment-tokens` directly):
   ```bash
   curl -fsSL -H "Authorization: Bearer $CP_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"agent_id":"host-prod-01","ttl_seconds":900}' \
        https://cp.example:8443/v1/enrollment-tokens
   # → {"token":"f5a9…","agent_id":"host-prod-01","expires_at":"…","issued_at":"…"}
   ```
2. The panel renders a bash one-liner with the freshly issued token. The
   operator copies it and runs it as root on the new host:
   ```bash
   curl -fsSL "https://cp.example:8443/v1/enroll" \
        -X POST -H 'Content-Type: application/json' \
        -d '{"agent_id":"host-prod-01","enrollment_token":"f5a9…"}' \
        > /tmp/firefik-enroll.json && \
   mkdir -p /etc/firefik && \
   jq -r .cert_pem   /tmp/firefik-enroll.json > /etc/firefik/cert.pem && \
   jq -r .key_pem    /tmp/firefik-enroll.json > /etc/firefik/key.pem  && \
   jq -r .bundle_pem /tmp/firefik-enroll.json > /etc/firefik/bundle.pem && \
   chmod 600 /etc/firefik/key.pem && rm /tmp/firefik-enroll.json
   ```
3. Operator brings up the agent container — env vars point at the freshly
   minted cert/key/bundle. Within ~30s the agent appears in `/v1/agents`
   with status `healthy`.

Token semantics:
- Single-use — the `consumed_at` column is set in the same SQLite tx that
  reads it; concurrent attempts get `409 enrollment token already used`.
- TTL-bounded — expired tokens are rejected with `401 enrollment token
  expired`; expired rows stay in the table for audit.
- `agent_id` is bound at issue time. If the consumer sends a different
  `agent_id` in the enroll body, the request is rejected with `403
  agent_id does not match enrollment token`.
- Issuance and consumption (with consumer IP) are audited
  (`enrollment_token_created`). The `issued_by` column reflects the
  actual operator: SSO-proxy headers (`X-Auth-Subject`,
  `X-Forwarded-User`, `X-Auth-Request-User`, `X-Forwarded-Email`) win,
  otherwise it falls back to `bearerFingerprint(token)@client_ip`
  (first hop of `X-Forwarded-For` or `RemoteAddr`).
- The store has a `RevokeEnrollmentToken` method (sets `consumed_at` so the
  token can no longer be exchanged); no public HTTP endpoint yet — let the
  TTL expire or delete the row out-of-band.

## Self-renewal flow (gRPC, mTLS-only)

Agent-driven cert rotation runs entirely over the existing mTLS gRPC
channel on `:8444`. No HTTP endpoint, no operator bearer involved.

```
agent (CertRenewer)                     firefik-server (gRPC)
─────────────────────                   ─────────────────────
  loop every CERT_RENEW_INTERVAL
    if remaining < CERT_RENEW_BEFORE
      load existing private key
      build CSR  (CN = agent_id, key = existing)
      ControlPlane.RenewCert(...)  ── mTLS handshake ──▶
        { agent_id, ttl_seconds, csr_pem }
                                              tls.RequireAndVerifyClientCert + SPIFFE check
                                              extract agent_id from peer SAN
                                              reject if revoked.json contains peer serial
                                              reject if remaining > renew-window (default 72h)
                                              reject if peer serial saw a renew within
                                                 min-renew-interval (default 5m)
                                              parse CSR; require csr.pubkey == peer.pubkey
                                              ca.IssueFromCSR(csr, agent_id, ttl)
                                              record (peer_serial -> now) for rate-limit
                                              audit "cert_renewed"
      ◀── { cert_pem, bundle_pem, serial, expires_unix }
      atomic write cert (key untouched);
      atomic write ca-bundle.pem if it changed (mini-CA root rotation
        propagates here — agents pick up the new trust bundle without
        any operator action)
      gRPC client picks up rotated cert at next handshake via
        tls.Config.GetClientCertificate (mtime-cached loader)
```

Key properties:

- **Single machine surface.** `:8444` (mTLS gRPC) is the only auth path
  for machine APIs — `RenewCert`, `Stream`, `Register`, `Ack`,
  templates. The public HTTP listener (`:8443`) is bootstrap-only
  (`/v1/enroll`, `/healthz`) and runs `tls.NoClientCert`. Reverse-
  proxies that terminate TLS on `:8443` no longer break renewal,
  because renewal does not flow through them.
- **No operator bearer involved.** Privilege-escalation surface (`enroll
  any agent_id`) eliminated — peer cert SAN is the binding identity.
  `RenewCert` is bypassed by the gRPC bearer interceptor.
- **Private key never rotates.** Agent reuses its enroll-time ECDSA-P256
  key for every CSR. Server signs the CSR and returns no key material.
- **Revocation closes the loop.** `firefik-server mini-ca revoke
  --serial <hex>` writes to `<state-dir>/revoked.json`; subsequent
  `RenewCert` from that cert returns `PermissionDenied` + the
  `cert_renew_rejected` audit event.
- <a id="renew-window"></a>**Renew window.** Two settings control when
  a cert is renewed:
  - agent `FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE` (seconds, default
    `259200` = 72h): the agent starts calling `RenewCert` once the cert
    has less than this left;
  - server `--renew-window` / `FIREFIK_CP_CERT_RENEW_WINDOW` (seconds
    or a Go duration, default 72h): `RenewCert` is rejected with
    `FailedPrecondition` while the peer cert has more than this left.

  **Rule: CP window ≥ agent renew-before.** With the defaults the agent
  renews on its first tick below 72h. If the CP window is shorter, the
  first attempt fails with `reason="outside_window"`, the agent reads
  the window from the error, waits until the cert is inside it and
  resets after the next successful renewal. The server logs a warning
  at startup when its window is below the 72h agent default.
- **Rate-limit per peer serial.** `--min-renew-interval` (default 5m)
  prevents a buggy or runaway agent from hot-looping the issuing path.
  The server records `{ peer_serial → last_renew_at }` in the SQLite
  `cert_renew_history` table.
- **Bundle rollover.** Every `RenewCert` response carries the current
  trust bundle. The agent atomically replaces its `ca-bundle.pem` only
  when content changes (`firefik_agent_bundle_rotated_total` ticks),
  so a mini-CA root rotation propagates to the fleet automatically.
- **Hot-reload, no agent restart.** gRPC client TLS config uses
  `GetClientCertificate` callback that re-reads the cert file when its
  mtime changes.
- **`firefik-admin enroll --renew`** remains as an operator-driven
  break-glass path (when the agent's cert is past expiry and self-
  renewal can no longer authenticate).

## Server certificate lifecycle

The control plane's own server certificate (the cert the agent talks to
on `:8443`/`:8444`) is auto-issued by the embedded mini-CA, hot-reloaded
from disk, and rotated daily without operator action.

| Stage | Trigger | Outcome |
|---|---|---|
| Auto-issue at startup | `--cert`/`--key` not set, files missing or invalid | mini-CA signs `<ca-state-dir>/cp-server.{crt,key}` with DNS SAN list (`--server-name`) and IP SAN `127.0.0.1` |
| Hot-reload | mtime change on `cp-server.crt` or `.key` | next TLS handshake serves the new keypair (`tls.Config.GetCertificate` callback) |
| Daily rotation | goroutine ticking every 24h | re-issue when `remaining < --server-cert-renew-before` (default 30 days), SAN list mismatch, or issuer cert rotation in mini-CA |
| Manual rotation | `firefik-server cert rotate [--force]` | atomic rewrite + audit `server_cert_rotated{reason="manual"}` |

`--cert`/`--key` remain available as an explicit operator override; when
both are set, auto-issue and daily rotation are disabled and rotation is
left to whatever process writes those files (the file-watcher still
hot-reloads on mtime change). Backup includes the `cp-server.{crt,key}`
in default layout because they live under `--ca-state-dir`.

## Endpoints (HTTP, bootstrap-only)

The HTTP listener serves only the bootstrap surface:

- `GET /healthz` — liveness probe.
- `POST /v1/enroll` — bearer or one-time enrollment token; issues cert
  and private key for new agents that don't have a cert yet.

Renewal is gRPC-only.

## gRPC service surface

Defined in [controlplane.proto](../backend/proto/controlplane/v1/controlplane.proto).

```proto
service ControlPlane {
  rpc Register(RegisterRequest) returns (RegisterAck);
  rpc Stream(stream AgentEvent) returns (stream ServerCommand);
  rpc Ack(CommandAck) returns (AckReply);

  rpc ListTemplates(ListTemplatesRequest) returns (ListTemplatesResponse);
  rpc GetTemplate(GetTemplateRequest) returns (PolicyTemplate);
  rpc PublishTemplate(PublishTemplateRequest) returns (PublishTemplateResponse);
}
```

- **Register** — one-shot on agent startup. Returns heartbeat cadence.
- **Stream** — bidirectional. Agent sends `AgentEvent` (Snapshot /
  Audit / Heartbeat); server pushes `ServerCommand` within
  single-digit ms of enqueue.
- **Ack** — out-of-band ack after stream drop; safe idempotent.
- **ListTemplates / GetTemplate / PublishTemplate** (v0.12+) — fleet-
  wide policy template library. Agent's `TemplateSyncer` pulls every
  `FIREFIK_TEMPLATE_SYNC_INTERVAL` (default 60s).

## HTTP REST surface (operator UI / approval flow)

In addition to the bootstrap `GET /healthz` + `POST /v1/enroll`, the
HTTP listener serves an operator-side REST API once an operator
bearer is set (`--operator-token-file`, env
`FIREFIK_SERVER_OPERATOR_TOKEN`, or the deprecated `--token-file`
fallback) **or** panel session auth is enabled
(`FIREFIK_PANEL_USERNAME` + `FIREFIK_PANEL_PASSWORD_HASH`). Either
authentication path satisfies the middleware:

| Method + Path | Purpose |
|---|---|
| `GET /v1/templates` | List published templates. |
| `POST /v1/templates` | Publish (insert or version-bump). Body fields auto-fill `publisher = sha256(bearer)[:8]`. |
| `GET /v1/templates/{name}` | Single template, latest version. |
| `GET /v1/approvals?status=pending|approved|rejected` | List pending-approval rows. Empty status = all. |
| `POST /v1/approvals` | Open a pending approval. `requester_fingerprint` always derived from caller's bearer; body field is ignored. |
| `GET /v1/approvals/{id}` | Single approval. |
| `POST /v1/approvals/{id}/approve` | 4-eyes approve. Returns `403 self-approve forbidden` if `approver_fingerprint == requester_fingerprint`; `409 not pending` if status changed. Atomic via `RowsAffected`. |
| `POST /v1/approvals/{id}/reject` | Same guards as approve; body `comment` optional. |
| `GET /v1/agents` | List enrolled agents. Returns `agent_dto[]` with `status: healthy\|stale\|dead\|unknown` based on `last_seen` (thresholds: 90s healthy, 5m stale, dead beyond). |
| `GET /v1/agents/{id}` | Single agent record. |
| `GET /v1/agents/{id}/snapshot` | Latest reported snapshot (containers, firewall_status, default_policy, sources, rule_set_count). Empty `snapshot` field if the agent has not pushed yet. |
| `POST /v1/agents/{id}/commands` | Enqueue a command. Body `{"action": "apply\|disable\|reconcile\|token_rotate", "container_id": "..."}`. `apply`/`disable` require `container_id`; `reconcile`/`token_rotate` are agent-wide. Returns `202 {"id","agent_id","action"}`. Audited as `agent_command`. |
| `GET /v1/agents/{id}/logs` | **WebSocket** — live tail of nflog forwarded by the agent. `Authorization: Bearer …` required on the upgrade request. Server sends `LogLine` JSON (`agent`, `at`, `level`, `source`, `line`, `fields`) and PINGs every 30s. |
| `GET /v1/enrollment-tokens` | List active (unconsumed) enrollment tokens. `?include_used=1` includes consumed/revoked. |
| `POST /v1/enrollment-tokens` | Issue a one-time enrollment token. Body `{"agent_id": "host-prod-01", "ttl_seconds": 900}`. `agent_id` must match `[a-z0-9-]{3,63}`; TTL defaults to 15 min, capped at 24 h. Returns `201 {"token","agent_id","expires_at","issued_at"}`. The token is single-use — `POST /v1/enroll` consumes it atomically. |
| `GET /v1/agent-tokens` | List active agent gRPC tokens (panel-managed, long-lived bearer that each agent uses on its `Stream` RPC). `?include_revoked=1` includes revoked rows. **Plaintext is never returned** — only metadata + `last_used_at` / `last_used_ip`. |
| `POST /v1/agent-tokens` | Issue a new agent token. Body `{"name":"prod-host-01","description":"primary"}`. Plaintext is shown **once** in the response (`token` field) and never again. Token is `agt_<hex32>`; SHA-256 hashed in the CP database. |
| `DELETE /v1/agent-tokens/{id}` | Revoke. Agents using the revoked token start failing gRPC auth immediately. Idempotent: re-revoking a revoked id returns `404`. |
| `POST /v1/login` | Panel session auth. Body `{"username","password"}`. On match, sets a `firefik_session` HttpOnly Secure SameSite=Lax cookie and returns `{"username","expires_at"}`. Available only when `FIREFIK_PANEL_USERNAME` + `FIREFIK_PANEL_PASSWORD_HASH` are set on `firefik-server`. |
| `POST /v1/logout` | Clear the `firefik_session` cookie and revoke the underlying session. `204 No Content`. |
| `GET /v1/whoami` | Returns `{"username","auth_kind":"session\|bearer"}` for the current request. `401` if neither cookie nor matching bearer is present. Used by the panel's AuthGate. |

### Fleet-aggregated panel surface

The panel build (`VITE_PANEL_MODE=fleet`) talks directly to the
control plane, not to a single agent's firefik-back. CP exposes
fleet-wide reads sourced from the `Registry` store, plus pull-style
RPC endpoints that round-trip through the existing agent↔CP
bidi-stream (`Stream(stream AgentEvent) returns (stream ServerCommand)`)
with a 5 s ack deadline.

| Method + Path | Purpose |
|---|---|
| `GET /v1/stats` | Fleet aggregator. Returns `{agents:{total,healthy,stale,dead,unknown}, containers:{total,running,enabled}}` computed over latest snapshots. |
| `GET /v1/containers` | Flatten of `snapshots[].containers` across the fleet. Each row carries `agent_id`, `agent_hostname`, plus the standard container fields (id/name/status/firewallStatus/defaultPolicy/labels). |
| `GET /v1/rules` | Same shape as `/v1/containers` but filtered to entries with `firewallStatus == active` or `rule_set_count > 0`. Detailed rule sets are *not* expanded — use `/v1/agents/{id}/snapshot` for per-container detail. |
| `GET /v1/audit/history?agent_id=&limit=` | Fleet audit log read from `store.audit_events` (which is fed by `AgentEvent.audit` push). Optional `agent_id` filter; `limit` defaults to 100, capped at 1000. |
| `GET /v1/policies` | List policies in `store.policy_versions` (latest version per name). Includes `sha`, `committedAt`, derived `rules` count via `policy.Compile`. |
| `GET /v1/policies/{name}` | Single policy detail with parsed `ruleSets` (rendered through `policy.Compile`). |
| `PUT /v1/policies/{name}` | Save a new version. Body `{"dsl","comment","author"}`. DSL is parsed by `internal/policy.Parse` before commit; rejects with `400` on parse error. |
| `POST /v1/policies/{name}/validate` | Parse-only DSL validator. Body `{"dsl"}`. Returns `{ok, errors[]}`. |
| `POST /v1/policies/{name}/simulate` | Render the (request-supplied or stored) DSL through `policy.Compile`. Body `{"dsl,containerID,labels"}`. Returns `{policy, container, defaultPolicy, ruleSets[], warnings[], errors[]}`. |
| `GET /v1/autogen/proposals` | Read pushed proposals (`AgentEvent.AutogenProposals`) flattened across the fleet, with `agent_id`/`agent_hostname` columns. |
| `POST /v1/autogen/proposals/{cid}/approve` | Body `{"agent_id","mode":"labels|policy"}`. Enqueues `COMMAND_KIND_AUTOGEN_APPROVE` on the agent, awaits ack with 5 s deadline. On success removes the proposal from CP's store. If `agent_id` omitted, CP resolves it from the proposals table. |
| `POST /v1/autogen/proposals/{cid}/reject` | Body `{"agent_id","reason"}`. Same flow as approve, with `COMMAND_KIND_AUTOGEN_REJECT`. |
| `GET /v1/agents/{id}/stats` | Live per-agent stats. CP enqueues `COMMAND_KIND_STATS_COLLECT`; agent's `engineDispatcher` builds `{containers,traffic,rules_active_containers,at}` and acks via `result_payload` (`Struct`). 5 s deadline → `504 Gateway Timeout`. Agent failure → `502 Bad Gateway`. |
| `POST /v1/containers/{id}/apply` | Enqueue `COMMAND_KIND_APPLY` for the containing agent, await ack (5 s). Body `{"agent_id"}` optional — CP can resolve from snapshots. |
| `POST /v1/containers/{id}/disable` | Same as apply, with `COMMAND_KIND_DISABLE`. |
| `POST /v1/containers/bulk` | Body `{"actions":[{"id","action","agent_id?"}]}`. Multi-target, returns `{results, summary{total,applied,disabled,failed}}`. |
| `GET /v1/logs?agent_id=` | **WebSocket** — multiplexed log tail from `Registry.logHub` across the whole fleet. `agent_id` query param filters to one agent; omitted = all. |

All routes require `Authorization: Bearer <token>`. The agent-side
firefik-back exposes proxy endpoints under `/api/templates*` and
`/api/approvals*` — single-agent UI talks to firefik-back, which
forwards operator's bearer onto firefik-server. The panel build
(`VITE_PANEL_MODE=fleet`) bypasses firefik-back entirely and proxies
`/api/*` straight to CP via Caddy (`Caddyfile.panel`).

#### Pull-style RPC contract via the existing bidi stream

The new ack-bearing commands re-use the agent↔CP `Stream` channel:

1. CP HTTP handler enqueues a `Command` via `Registry.Enqueue(agentID, cmd)` and registers a waiter in `Registry.ackWaiters[cmd.ID]`.
2. Agent's `GRPCClient` polls and dispatches the command through `engineDispatcher.Dispatch`. The dispatcher returns a `CommandAck` with `Success` and an optional `result_payload` (Go `map[string]any` ↔ proto `Struct`).
3. Agent's `Ack(CommandAck)` lands at CP's `Registry.recordAck`, which signals the waiter channel.
4. The HTTP handler unblocks (or hits its 5 s deadline → `504`).

This is how `STATS_COLLECT`, `AUTOGEN_APPROVE`, `AUTOGEN_REJECT`, and the new `APPLY`/`DISABLE` panel routes round-trip without a second TCP listener on the agent.

### Approval audit fan-out

Every successful create / approve / reject is recorded via
`store.RecordAudit` AND fanned out through the configured
`SinkFanOut`. Default sinks:

- `WebhookSink` if `FIREFIK_WEBHOOK_URL` is set. HMAC-SHA256 over
  `action\ntimestamp\nbody`; `X-Firefik-Timestamp` header for replay
  protection.
- `OTelSink` if `FIREFIK_OTEL_LOGS_ENABLED=true`. Severity by action
  (`*_rejected` → WARN, default INFO).

## Metrics (server-side)

| Metric | Type | Labels |
|--------|------|--------|
| `firefik_controlplane_grpc_agents_connected` | gauge | — |
| `firefik_controlplane_transport_requests_total` | counter | `transport` |
| `firefik_controlplane_audit_events_total` | counter | — |
| `firefik_controlplane_db_bytes` | gauge | — |
| `firefik_controlplane_commands_enqueued_total` | counter | `kind` |
| `firefik_controlplane_mtls_rejected_total` | counter | `reason` |
| `firefik_controlplane_ca_certs_issued_total` | counter | — |

## SPIRE compatibility

Agents deployed under SPIRE can skip the embedded mini-CA. Point
`FIREFIK_CONTROL_PLANE_CLIENT_CERT` / `_CLIENT_KEY` at the SPIRE-rotated
SVID paths (typically `/run/spire/agent/svid.pem` + `svid.key`), and
make sure the trust bundle is wired via `FIREFIK_CONTROL_PLANE_CA_CERT`.
Server-side `FIREFIK_CP_TRUST_DOMAIN` must match the SPIRE trust domain.
