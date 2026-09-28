# firefik-server (control plane)

The central control plane for a firefik fleet. Accepts agent
registrations, collects per-host snapshots + audit events, and
dispatches commands (apply / disable / reconcile / token-rotate) back
via bidirectional gRPC streams.

## Transport

gRPC bidirectional streams over TLS 1.3 with mutual auth. The
`.proto` contract lives at [backend/proto/controlplane/v1/controlplane.proto](../../proto/controlplane/v1/controlplane.proto)
and is the sole supported protocol.

See [docs/control-plane.md](../../../docs/control-plane.md) for the
full protocol reference.

## Run

```bash
firefik-server --grpc-listen :8444 \
  --listen :8443 \
  --cert /etc/firefik-server/tls.crt \
  --key /etc/firefik-server/tls.key \
  --client-ca /etc/firefik-server/agents-ca.pem \
  --ca-state-dir /var/lib/firefik-server/ca \
  --trust-domain spiffe://prod.corp/ \
  --db /var/lib/firefik-server/firefik.db
```

- `--grpc-listen` — operational traffic. Mutual TLS is mandatory.
- `--listen` — bootstrap only: `GET /healthz`, `POST /v1/enroll`.
- `--client-ca` enables mTLS (`RequireAndVerifyClientCert`) for the
  gRPC listener. Agents must present certs signed by this CA.
- `--ca-state-dir` — directory with the embedded mini-CA state
  (created by `firefik-server mini-ca init`). Enables `/v1/enroll`.
- `--trust-domain` (or `FIREFIK_CP_TRUST_DOMAIN`) — rejects peer
  certs whose URI SAN is not under the given SPIFFE domain.
- `--db` — sqlite path for persistent agent / snapshot / audit /
  command / policy-version rows. `":memory:"` or empty disables
  persistence (tests only).

## Bootstrap CA

```bash
firefik-server mini-ca init --state-dir /var/lib/firefik-server/ca \
                            --trust-domain spiffe://prod.corp/
firefik-server mini-ca issue --state-dir /var/lib/firefik-server/ca \
                             --agent-id host-a --ttl 720h --out /tmp/host-a
```

Agents call `firefik-admin enroll` to pull short-lived certs via the
HTTP `/v1/enroll` endpoint.

## Endpoints (HTTP, bootstrap-only)

| Method | Path | Caller | Purpose |
|--------|------|--------|---------|
| GET  | `/healthz` | anyone | Liveness probe (unauthenticated). |
| POST | `/v1/enroll` | agent (bearer or one-time enrollment token) | Initial mTLS client cert from embedded mini-CA. |

> The HTTP listener no longer carries `/v1/renew`. Renewal is a unary
> gRPC RPC `ControlPlane.RenewCert` on `:8444` with mTLS verification
> + per-cert rate-limit (`--min-renew-interval`).
>
> `--renew-window` / `FIREFIK_CP_CERT_RENEW_WINDOW` (seconds or a Go
> duration, default 72h) is how close to expiry a cert must be before
> `RenewCert` accepts it. Keep it ≥ the agent
> `FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE` (default 72h); the server
> logs a warning at startup when it is below 72h.

## Agent integration

Agents (firefik-back) opt in by setting:

- `FIREFIK_CONTROL_PLANE_GRPC=cp.example:8444` (machine API + RenewCert)
- `FIREFIK_CONTROL_PLANE_HTTP=https://cp.example:8443` (bootstrap-only — `/v1/enroll`)
- `FIREFIK_CONTROL_PLANE_CA_CERT=/etc/firefik/ca-bundle.pem`
- `FIREFIK_CONTROL_PLANE_CLIENT_CERT=/etc/firefik/client.crt`
- `FIREFIK_CONTROL_PLANE_CLIENT_KEY=/etc/firefik/client.key`
- `FIREFIK_CONTROL_PLANE_TOKEN=…` (optional; bearer for non-RenewCert RPCs)
- `FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE=259200` (default 72h, in seconds; must be ≤ server `--renew-window`)
- `FIREFIK_CONTROL_PLANE_CERT_RENEW_INTERVAL=1800` (default 30m, in seconds)
- `FIREFIK_CONTROL_PLANE_CERT_RENEW_TTL=2592000` (default 720h, in seconds)

On connection loss the agent degrades to local-only operation — the
control plane is an observer, not a master.

## Features

- Embedded mini-CA subcommands: `mini-ca init|issue|revoke|list-revoked`.
- Agent-driven self-renewal via gRPC `ControlPlane.RenewCert` (mTLS only,
  CSR-mode) — no operator bearer; per-cert rate-limit;
  `ca-bundle.pem` rollover ships every successful renewal so mini-CA
  root rotation propagates automatically.
- SPIFFE SVID trust-domain enforcement via
  `FIREFIK_CP_TRUST_DOMAIN` / `--trust-domain`.
- Auto-issued + auto-rotated server certificate (`--cert`/`--key` are
  optional override; otherwise mini-CA signs `<ca-state-dir>/cp-server.{crt,key}`
  at startup, daily-checks for near-expiry / SAN-mismatch / issuer-rotation,
  and supports manual `firefik-server cert rotate [--force]`).
- gRPC machine API on `:8444`; HTTP bootstrap on `:8443` runs
  `tls.NoClientCert` (no client-cert mTLS at the HTTP layer).

## Out of scope

- HA / multi-replica control plane — single-host by design.
- Postgres / MySQL backend — sqlite-only persistence.
- Multi-token RBAC — one operator = one bearer token.
