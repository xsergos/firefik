# Firefik HTTP API

Firefik exposes a small, bearer-authed REST surface plus one WebSocket
stream. The authoritative contract is the machine-readable spec shipped
in the binary itself — everything here is derived from it.

## Spec endpoints

| Path | Content | Auth |
|---|---|---|
| `GET /api/v1/openapi.json` | OpenAPI 2.0 (Swagger) JSON | none |
| `GET /api/v1/openapi.yaml` | Same, YAML serialization | none |

The spec is embedded in the binary via `go:embed` (see
`backend/internal/api/openapi/`). A GET returns the exact file
committed to the repository — no runtime regeneration, no
network lookups.

## Source of truth

The spec is generated from swaggo annotations on the handlers in
`backend/internal/api/handlers_*.go` + `server.go`. After changing a
handler annotation or a DTO:

```bash
cd backend
make openapi
```

CI runs `make openapi-check` on every PR (see `.github/workflows/ci.yml`,
`backend` job) and fails when the regenerated spec differs from the
committed version. If that check fires, run `make openapi` locally and
commit the result.

## Contract tests

`backend/internal/api/contract_test.go` spins up an `httptest.Server`
with stubbed Docker + engine dependencies, hits every documented
endpoint, and unmarshals the response into the Go DTO type named in
the `@Success` annotation. This catches the other half of spec drift —
cases where the annotation is stale but the spec itself is internally
consistent (so the drift-check passes).

Run locally:

```bash
cd backend
go test ./internal/api/...
```

## Endpoints

Run `curl -s $URL/api/v1/openapi.json | jq '.paths | keys'` for the
live list. The current set is:

### Liveness / readiness

- `GET /health`, `GET /live` — always 200 while serving.
- `GET /ready` — 200 when Docker reachable, 503 otherwise.

### Containers + rules

- `GET /api/containers` — list containers with parsed firewall config.
- `GET /api/containers/{id}` — single container, 409 on ambiguous prefix.
- `POST /api/containers/{id}/apply` — apply rules, audit source `api`.
- `POST /api/containers/{id}/disable` — remove rules, audit source `api`.
- `POST /api/containers/bulk` — bulk apply/disable; per-item results.
- `GET /api/rules` — live applied rule-sets snapshot.
- `GET /api/rules/profiles` — built-in rule-set profiles.
- `GET /api/rules/templates` — local DSL rule templates loaded from
  `FIREFIK_TEMPLATES_FILE`.
- `GET /api/stats` — container counts + last 60m traffic buckets.

### Policies (DSL)

- `GET /api/policies` — list saved policies + version metadata.
- `GET /api/policies/{name}` — single policy DSL body.
- `PUT /api/policies/{name}` — write policy (creates new version).
- `POST /api/policies/validate` — validate DSL without persisting.
- `POST /api/policies/{name}/simulate` — simulate compile against a
  container or label-set.

### Autogen proposals

- `GET /api/autogen/proposals` — pending proposals list.
- `POST /api/autogen/proposals/{id}/approve` — approve and emit YAML
  / labels artifact.
- `POST /api/autogen/proposals/{id}/reject` — drop proposal.

### Audit history

- `GET /api/audit/history` — in-memory ring buffer. Optional
  `?limit=<N>` (last N events) and `?since=<RFC3339>` (events strictly
  after the given timestamp).

### Control-plane proxy (v0.12+, when `FIREFIK_CONTROL_PLANE_HTTP` or `FIREFIK_CONTROL_PLANE_ADMIN_HTTP` set)

These routes proxy to firefik-server's `/v1/templates` and
`/v1/approvals` HTTP endpoints. The upstream base URL is
`FIREFIK_CONTROL_PLANE_ADMIN_HTTP` when set (admin API on its own domain),
otherwise `FIREFIK_CONTROL_PLANE_HTTP`. The agent-side firefik-back forwards
its own control-plane bearer (`FIREFIK_CONTROL_PLANE_TOKEN`), so the
control-plane sees a single fingerprint per agent. Multiple operators
behind one agent share that fingerprint — the 4-eyes guard catches
self-approval *between agents*, not between operators on the same
agent — multi-operator RBAC on a single agent is intentionally out
of scope.

- `GET /api/templates`, `POST /api/templates`,
  `GET /api/templates/{name}` — fleet-wide policy templates.
- `GET /api/approvals` (optional `?status=pending|approved|rejected`),
  `POST /api/approvals` — pending-approval CRUD.
- `GET /api/approvals/{id}`,
  `POST /api/approvals/{id}/approve`,
  `POST /api/approvals/{id}/reject` — 4-eyes flow (self-approve
  rejected with 403; approver fingerprint = `sha256(bearer)[:8]`).

### Streams + metrics

- `GET /ws/logs` — WebSocket audit/traffic stream (`?filter=` optional).
- `GET /metrics` — Prometheus metrics (separate token via
  `FIREFIK_METRICS_TOKEN`). Set `FIREFIK_METRICS_LISTEN` to expose
  `/metrics` on a dedicated TCP/unix listener; the main API listener
  then returns 404 for `/metrics`.

## Auth

All `/api/*` and `/ws/*` routes require the bearer token configured
via `FIREFIK_API_TOKEN` (or `FIREFIK_API_TOKEN_FILE`). Unix-socket
clients additionally pass peer-credential check against
`FIREFIK_ALLOWED_UIDS`. See `README.md` for the full env reference.
