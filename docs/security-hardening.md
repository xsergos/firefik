# Firefik — Security hardening checklist

Production-oriented checklist. Each item includes **why**, **how to
verify**, and **how to remediate**. Items are ordered from "must have"
to "good to have".

---

## 1 — Transport security

### 1.1 mTLS with TLS 1.3 mandatory (control plane)

- **Why.** `firefik-server` gRPC transport demands client certs; a
  misconfigured server with `--client-ca` unset accepts any cert the
  public CA chain would validate.
- **Verify.**
  ```bash
  openssl s_client -connect firefik-server:8444 -tls1_3 -verify_return_error
  # Then attempt with invalid client cert:
  openssl s_client -connect firefik-server:8444 -tls1_3 -cert bad.pem -key bad.key
  # Should reject with "certificate verify failed".
  ```
- **Remediate.** Set `--client-ca /path/to/ca-bundle.pem` and confirm
  `firefik_controlplane_mtls_rejected_total` increments on unauthorised
  connects (see [metrics-guide.md](metrics-guide.md)).

### 1.2 SPIFFE trust-domain enforcement

- **Why.** Without `--trust-domain` / `FIREFIK_CP_TRUST_DOMAIN`, a valid
  cert from a *different* SPIFFE domain can still authenticate.
- **Verify.**
  ```bash
  # Forge a cert with URI SAN from wrong domain, attempt connect:
  # firefik-server should log "mtls reject: wrong trust domain" and
  # increment firefik_controlplane_mtls_rejected_total{reason="trust_domain"}.
  ```
- **Remediate.** `FIREFIK_CP_TRUST_DOMAIN=spiffe://your.tld` on server.

### 1.3 Agent API: Unix socket + peer-cred

- **Why.** Default `FIREFIK_LISTEN_ADDR=unix:///run/firefik/api.sock` +
  `FIREFIK_SOCKET_MODE=0o660` + `FIREFIK_SOCKET_GROUP=firefik` scopes
  access to members of a specific group.
- **Verify.**
  ```bash
  ls -la /run/firefik/api.sock
  # Expect: srw-rw---- root:firefik
  # Members of 'firefik' group; root override works:
  sudo -u otheruser curl --unix-socket /run/firefik/api.sock http://localhost/api/containers
  # Expect 403.
  ```
- **Remediate.** Add `FIREFIK_ALLOWED_UIDS` for a strict allowlist that
  overrides group membership.

---

## 2 — Authentication

### 2.1 Bearer-token rotation (file-backed)

- **Why.** `FIREFIK_API_TOKEN` inline = process restart for rotation;
  `FIREFIK_API_TOKEN_FILE` hot-reloads on file change.
- **Verify.**
  ```bash
  # Write a new token atomically (mv-based), then:
  curl -H "Authorization: Bearer $OLD_TOKEN" --unix-socket /run/firefik/api.sock http://localhost/api/containers
  # Should now return 401.
  ```
- **Remediate.** Always use `*_FILE` variants for long-running daemons.

### 2.2 Separate metrics token

- **Why.** `/metrics` is a DoS surface if hit by high-cardinality
  scraping. Separate token means revoking scraper credentials doesn't
  break app control.
- **Verify.** `FIREFIK_METRICS_TOKEN_FILE` set; attempt scrape with
  API token — should 401.
- **Remediate.** Provision dedicated token for Prometheus.

### 2.2.1 Dedicated metrics listener

- **Why.** Default API listener is a unix socket; Prometheus scrapers
  (vector, vmagent) speak HTTP over TCP. Switching the whole API to
  TCP exposes mutating endpoints. `FIREFIK_METRICS_LISTEN` keeps the
  API on the unix socket while serving `/metrics` on a separate TCP
  (or unix) listener — read-only, scoped to one endpoint.
- **Verify.**
  ```bash
  curl --unix-socket /run/firefik/api.sock http://localhost/rules   # OK
  curl -H "Authorization: Bearer $TOK" http://127.0.0.1:9180/metrics # OK
  curl http://127.0.0.1:9180/rules                                   # 404
  curl http://127.0.0.1:9180/metrics                                 # 401 (no bearer)
  ```
- **Remediate.** Bind metrics listener to loopback only; for
  non-loopback TCP, set `FIREFIK_METRICS_TLS_CERT` and
  `FIREFIK_METRICS_TLS_KEY` (the backend refuses to start otherwise).
  TCP metrics listener also requires `FIREFIK_METRICS_TOKEN` (or
  API-token fallback).
- **Escape hatch (private networks only).** For host-networked
  agents that need to publish `/metrics` to scrapers in a bridge
  network via an RFC1918 docker-bridge gateway (e.g. `172.18.0.1`)
  where issuing and rotating self-signed TLS per host is undesirable,
  set `FIREFIK_METRICS_ALLOW_PRIVATE=true`. This relaxes the TLS
  requirement **only** for addresses in `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, or IPv6 ULA `fc00::/7`. Public
  addresses still require TLS; the bearer-token requirement is
  unchanged. The relaxation is a deployment-time trust statement
  about the host's private network and is logged at warning level
  on startup with the address and matched range. Do not set this
  on a host whose private network is reachable from untrusted parties.

### 2.3 Control-plane bootstrap token

- **Why.** `/v1/enroll` is the only public-internet-friendly surface;
  unauthenticated enrollment = rogue-agent risk.
- **Verify.** `firefik-server` started with `--token-file`; agent
  enroll without token returns 401.
- **Remediate.** One-time bootstrap tokens per fleet rotation; rotate
  token-file after large enroll wave.

### 2.4 Operator/agent token separation

- **Why.** Before v(N), `--token-file` gated *both* the operator HTTP
  surface (panel, ansible, curl) **and** the agent gRPC interceptor.
  Compromising a single panel host = full fleet admin via the agent
  channel, and vice versa. Same blast radius for both transports is
  the worst case.
- **How it works now.**
  - `--operator-token-file` (env `FIREFIK_SERVER_OPERATOR_TOKEN`)
    gates HTTP requests under `requireBearer` (`/v1/agents`,
    `/v1/stats`, `/v1/agent-tokens`, `/v1/policies`, …).
  - Agent gRPC tokens are panel-managed: created via
    `POST /v1/agent-tokens` (operator-gated), stored as SHA-256
    hashes in the CP DB, identified by an `agt_` prefix. Plaintext
    is shown **once** at issue time and never again.
  - The gRPC interceptor validates the incoming `Bearer` against
    the legacy single token (back-compat) **then** falls back to
    `Store.ValidateAgentToken`, which checks the hash, refuses
    revoked tokens, and refreshes `last_used_at` / `last_used_ip`
    so the panel can show "last seen" per token.
  - Legacy `--token-file` (env `FIREFIK_SERVER_TOKEN`) still works
    — used as the operator token if `--operator-token-file` is
    empty AND as a static fallback agent bearer. Startup logs a
    deprecation warning; planned removal in v(N+1).
- **Verify.**
  ```bash
  # operator-token must work for HTTP, must fail on gRPC
  curl -fH "Authorization: Bearer $OPERATOR" https://cp:8443/v1/agents
  grpcurl -H "authorization: Bearer $OPERATOR" cp:8444 list  # → Unauthenticated

  # agent-token (panel-issued) must work for gRPC, must fail on HTTP
  curl -fH "Authorization: Bearer $AGENT" https://cp:8443/v1/agents  # → 401
  grpcurl -H "authorization: Bearer $AGENT" cp:8444 list             # OK
  ```
- **Remediate.** Issue per-host agent tokens from the panel; rotate
  via "Revoke" + reissue when a host is decommissioned or suspected
  compromised — no fleet-wide impact.

### 2.5 Panel session auth

- **Why.** Until v(N), anyone reaching the panel's HTTP port got an
  authenticated CP session because Caddy injected the operator
  Bearer for every browser request. Fine for air-gapped homelabs;
  unsuitable when the panel is exposed to a corp LAN, VPN, or
  reverse-proxied to the public internet.
- **How.** Set
  `FIREFIK_PANEL_USERNAME=<user>` and
  `FIREFIK_PANEL_PASSWORD_HASH=$(htpasswd -bnBC 12 "" <pass> | tr -d ':\n')`
  on the CP. Unset `FIREFIK_OPERATOR_TOKEN` in the **panel
  container** (the CP keeps it for its own validation) so Caddy
  injects an empty Bearer; the CP rejects empty bearers and falls
  through to session-cookie validation. Browsers hit `/login`,
  receive a `firefik_session` HttpOnly cookie, and use it for all
  subsequent `/api/*` calls.
- **Verify.**
  ```bash
  curl -i https://panel/api/agents          # → 401 (no Bearer, no cookie)
  curl -i -X POST -d '{"username":"admin","password":"…"}' https://panel/api/login
  # → Set-Cookie: firefik_session=… ; HttpOnly; Secure; SameSite=Lax
  curl -i --cookie 'firefik_session=…' https://panel/api/agents   # → 200
  ```
- **Remediate.** Always combine with mTLS or a VPN/private network
  if exposing the panel beyond `localhost`. Session TTL defaults to
  24 h, idle timeout 4 h — adjust via `SessionStore.WithTTL` if
  embedding `firefik-server`.

---

## 3 — Certificate lifecycle

### 3.1 Mini-CA state backup

- **Why.** `FIREFIK_CP_CA_DIR` contains root + issuing CA private keys.
  Loss = fleet-wide re-enrollment. Theft = fleet impersonation.
- **Verify.** Directory mode `0700`, owner = `firefik-server` user, no
  world read.
- **Remediate.** Encrypted offline backup (e.g. `age` / `rage`);
  periodic integrity check via `firefik-server mini-ca fingerprint`.

### 3.2 Agent cert renewal window

- **Why.** Agents drive their own renewal via the gRPC `RenewCert` RPC
  (`:8444`, mTLS only) — there is no HTTP renewal surface. Operator
  bearer is never involved, and the public HTTP listener (`:8443`)
  runs `tls.NoClientCert`, so reverse-proxies in front of `:8443` no
  longer break renewal. The agent reuses its enroll-time ECDSA private
  key (CSR-mode), so only the cert rotates. `firefik-admin enroll
  --renew` is the break-glass path when self-renewal can no longer
  authenticate.
- **Verify.**
  - `firefik_agent_cert_renewed_total` increments once per rotation;
    alert if `rate(firefik_agent_cert_renewed_total[7d]) == 0` for an
    agent whose `_days_until_expiry` is below `FIREFIK_CONTROL_PLANE_
    CERT_RENEW_BEFORE` (default 72h).
  - `firefik_agent_cert_renew_failed_total{reason}` and the server-side
    `firefik_controlplane_cert_renew_rejected_total{reason}` should
    stay at zero outside maintenance. `reason="rate_limited"` indicates
    a buggy agent ratcheting on the renew loop. Agent
    `reason="outside_window"` (server `outside_renewal_window`) means
    the server `--renew-window` / `FIREFIK_CP_CERT_RENEW_WINDOW`
    (default 72h) is shorter than the agent
    `FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE` (default 72h). Keep the
    server window ≥ the agent renew-before; otherwise the real safety
    margin shrinks to the server window.
  - `firefik_agent_bundle_rotated_total` ticks whenever the mini-CA
    root rotation propagates to the agent — alert on unexpected
    increments outside a planned root rotation.
  - `firefik_controlplane_agent_cert_days_until_expiry` gauge stays
    ≥ ~3 days (the agent renew-before) on healthy agents; alert below 2.
  - `firefik_controlplane_server_cert_renewed_total{reason}` should
    tick once per `--server-cert-renew-before` window (default 30d
    before expiry, ~once a year on default TTL); a sudden burst with
    `reason="issuer_rotated"` confirms a mini-CA root rotation took.
- **Remediate.** Tune `FIREFIK_CONTROL_PLANE_CERT_RENEW_INTERVAL`
  (default 30m) and `_BEFORE` (default 72h). Revoke a compromised cert
  with `firefik-server mini-ca revoke --serial <hex> --reason …` —
  every subsequent `RenewCert` from that cert returns `PermissionDenied`.
  Manual server-cert rotation: `firefik-server cert rotate --force`.

### 3.3 TLS cert rotation (server)

- **Why.** `firefik-server --cert / --key` aren't hot-reloaded by the
  gRPC server; a rotated cert requires SIGHUP or restart.
- **Verify.** Post-rotation, check gRPC cert chain via
  `openssl s_client`.
- **Remediate.** Coordinate with load balancer for zero-downtime
  restart; use blue/green (2 servers, rotate one at a time).

---

## 4 — Data plane

### 4.1 GeoIP source signature verification

- **Why.** `FIREFIK_GEOIP_SOURCE=p3terx` fetches from a GitHub
  mirror-maintainer; the file is **not** cryptographically verified
  against an upstream signature. For MaxMind source, the SHA256
  companion is checked.
- **Verify.** `FIREFIK_GEOIP_SOURCE=maxmind` +
  `FIREFIK_GEOIP_LICENSE_KEY_FILE` set; updater logs
  `sha256 match` on each refresh.
- **Remediate.** Prefer `maxmind` with license key in prod. Avoid
  p3terx unless license unavailable.

### 4.2 Kernel-rule injection via labels

- **Why.** `firefik.firewall.*.ports=...` labels are parsed and flowed
  into kernel rules. Container owners must be trusted to add these.
- **Verify.**
  ```bash
  docker run -d --label 'firefik.firewall.web.ports=80;DROP;echo hacked' nginx
  # firefik should reject or sanitise; audit sink should log.
  ```
- **Remediate.** Restrict Docker daemon access; use
  `FIREFIK_POLICIES_READONLY=true` + centrally-managed policies for
  shared clusters.

---

## 5 — Audit & compliance

### 5.1 Audit sink configuration

- **Why.** `FIREFIK_AUDIT_SINK=stdout` alone is ephemeral. Use
  `file,remote` or `cef,remote` for durable + forwarded copy.
- **Verify.** Apply a rule; check both sinks received the event.
- **Remediate.** Configure `FIREFIK_AUDIT_SINK_PATH` +
  `FIREFIK_AUDIT_SINK_ENDPOINT`; confirm rotation
  (`FIREFIK_AUDIT_SINK_MAX_SIZE_MB` not exceeded).

### 5.2 Audit sink → SIEM mapping

Map firefik audit fields to your SIEM:

| firefik field | CEF extension | Typical SIEM field |
|---|---|---|
| `action` | `act` | event_name |
| `source` | `src` (component) | event_source |
| `container_id` | `cs1` + `cs1Label=containerID` | resource_id |
| `user_id` | `suid` | user_id |
| `rule_set` | `cs2` + `cs2Label=ruleSet` | policy_name |
| `severity` | `Severity` | severity |

### 5.3 Audit retention

- **Why.** Compliance frameworks (SOC2, ISO 27001) often require 1yr+
  retention; default rotation is 30 days.
- **Remediate.** Set `FIREFIK_AUDIT_SINK_MAX_AGE_DAYS=400` and
  `FIREFIK_AUDIT_SINK_MAX_BACKUPS=100`, or forward to external SIEM
  with longer retention via remote sink.

---

## 6 — Network isolation

### 6.1 Host networking blast radius

- **Why.** Firefik runs with `--network host` + `CAP_NET_ADMIN`.
  Compromise of the agent = root-equivalent on host kernel firewall.
- **Verify.** Docker `--security-opt=no-new-privileges` on the
  firefik container; AppArmor/SELinux profile applied.
- **Remediate.** Run firefik as a systemd unit directly on host rather
  than in a container if your threat model requires maximum isolation.

### 6.2 Control-plane network reachability

- **Why.** Control plane must reach all agents; over-permissive ACLs
  broaden attack surface.
- **Remediate.** Allowlist `firefik-server:8444` from agent subnets
  only; deny public ingress.

---

## 7 — Build & supply chain

### 7.1 Image signatures

- **Why.** v0.10.0 ships SBOM (CycloneDX) but does not mandate cosign
  signatures (image signing is currently out of scope).
- **Remediate.** Pin by digest (`ghcr.io/...@sha256:...`) rather than
  tag in production manifests.

### 7.2 Vulnerability scanning

- **Verify.** Release CI runs `govulncheck`, `gosec`, `trivy` (HIGH /
  CRITICAL gate, fails the release on any unignored finding).
- **Remediate.** Re-scan production image weekly via
  `trivy image ghcr.io/.../firefik-back:v0.11.0`.
- **Accepted findings (`.trivyignore`).** Repo-root ignore list with
  CVE IDs explicitly assessed as not exploitable in this deployment —
  typically vulnerable libraries embedded in the upstream caddy binary
  whose code paths our `Caddyfile.panel` never reaches (`auto_https off`,
  no JWT/auth, no OTel exporter, no gRPC reverse-proxy). Each entry
  carries severity, justification, and a follow-up note; re-evaluated
  on every caddy bump. Frontend image now builds caddy from source
  against Go 1.26.2 to remove all stdlib CVEs at the binary level.

---

## 8 — Operational safety

### 8.1 Multi-operator 4-eyes (v0.12+)

Policy approval flow on firefik-server: `POST /v1/approvals` opens a
pending request signed by the requester's bearer fingerprint
(`sha256(bearer)[:8]`). A second operator with a **different** bearer
calls `POST /v1/approvals/{id}/approve`. Self-approve attempts return
`403`; concurrent double-approve returns `409 not pending` (atomic via
`RowsAffected` check).

Audit fan-out emits `policy_approval_requested|approved|rejected`
through the configured `WebhookSink` (HMAC over `action\ntimestamp\nbody`,
`X-Firefik-Timestamp` for replay protection) and `OTelSink` (OTLP logs).
Single-operator deploys remain valid — the gate is opt-in via the
`requires_approval` policy label.

### 8.2 Emergency kill switch

- **Verify.** `firefik-admin drain --confirm` removes all firefik
  chains but keeps parent-jump if `--keep-parent-jump` set.
- **Remediate.** Bind a systemd unit `firefik-panic.service` that
  invokes `drain --keep-parent-jump --confirm` on a well-known trigger
  file; document in runbook.

---

## Quick verification one-liner

```bash
firefik-admin doctor --output json | jq -r '.checks[] | select(.status != "pass") | "[\(.status)] \(.name): \(.detail)"'
```

All `pass` on a hardened host = core checks green. This catches
missing kernel modules, wrong capabilities, Docker-socket access,
GeoIP staleness. It does not cover TLS/mTLS config — use sections
1–2 above for those.
