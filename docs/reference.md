# Firefik — Configuration reference

Single-source-of-truth for every env-var, CLI flag, metric, and
subcommand. When a value appears in both code and documentation, this
file is the canonical description.

- [Environment variables](#environment-variables)
- [`firefik-admin` subcommands](#firefik-admin-subcommands)
- [`firefik-server` subcommand & flags](#firefik-server-subcommand--flags)
- [Metrics](metrics-guide.md) (separate file — each metric has
  threshold + alert context)

---

## Environment variables

Columns:

- **Default** — value if unset; empty string = feature disabled.
- **Type** — `string`, `int`, `bool`, `float`, `path`, `list` (comma-
  separated), `duration` (Go syntax: `10s`, `72h`).
- **Scope** — `agent` (firefik-back), `server` (firefik-server), `both`.
- **Sensitive** — 🔒 = contains or points to a secret; never log; use
  `*_FILE` variant when possible.

### Networking & API surface

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_LISTEN_ADDR` | `unix:///run/firefik/api.sock` | string | agent | | Unix-socket or `tcp://host:port`. Unix recommended. |
| `FIREFIK_SOCKET_MODE` | `0o660` | octal | agent | | Mode on unix-socket creation. |
| `FIREFIK_SOCKET_GROUP` | — | string | agent | | Group owner of unix-socket. Empty = default process group. |
| `FIREFIK_ALLOWED_UIDS` | — | list | agent | | Peer-cred UID allowlist. Empty = token-only auth. |
| `FIREFIK_ALLOWED_ORIGINS` | — | list | agent | | CORS allowlist for browser UI. |
| `FIREFIK_MAX_BODY_BYTES` | `1048576` | int | agent | | POST body size cap (bytes). |
| `FIREFIK_RATE_LIMIT_RPS` | `10` | float | agent | | Per-route write-side rate limit. |
| `FIREFIK_RATE_LIMIT_BURST` | `20` | int | agent | | Burst allowance on write endpoints. |
| `FIREFIK_METRICS_RATE_RPS` | `1.0` | float | agent | | Limiter on `/metrics` (Prometheus scrape). |
| `FIREFIK_METRICS_RATE_BURST` | `5` | int | agent | | Metrics burst. |
| `FIREFIK_METRICS_LISTEN` | — | string | agent | | Dedicated `/metrics` listener (e.g. `tcp://127.0.0.1:9180` or `unix:///run/firefik/metrics.sock`). Empty = metrics served on main API listener. When set, `/metrics` is removed from the API listener (returns 404 there). |
| `FIREFIK_METRICS_TLS_CERT` | — | path | agent | | TLS cert for the dedicated metrics listener. Required (with key) when the listener is non-loopback TCP. |
| `FIREFIK_METRICS_TLS_KEY` | — | path | agent | 🔒 | TLS key for the dedicated metrics listener. |
| `FIREFIK_METRICS_ALLOW_PRIVATE` | `false` | bool | agent | | Allow the metrics listener to bind to a non-loopback RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) or IPv6 ULA (`fc00::/7`) address without TLS. Bearer token still required. Public addresses still require TLS. Deployment-time trust statement about the host's private network — emits a warning log on startup naming the address and matched range. |
| `FIREFIK_REQUEST_TIMEOUT_MS` | `30000` | int | agent | | HTTP request timeout (ms). |
| `FIREFIK_WS_MAX_SUBSCRIBERS` | `20` | int | agent | | Max concurrent `/ws/logs` subscribers. |

### Authentication

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_API_TOKEN` | — | string | agent | 🔒 | Inline bearer token. Prefer `*_FILE`. |
| `FIREFIK_API_TOKEN_FILE` | — | path | agent | 🔒 | File containing token; hot-reloaded. |
| `FIREFIK_METRICS_TOKEN` | — | string | agent | 🔒 | Separate token for `/metrics`. Optional. |
| `FIREFIK_METRICS_TOKEN_FILE` | — | path | agent | 🔒 | File-backed metrics token. |
| `FIREFIK_CLIENT_CA_FILE` | — | path | agent | | Client-cert CA for mTLS on API. |

### Firewall engine

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_BACKEND` | `auto` | string | agent | | `iptables` / `nftables` / `auto`. |
| `FIREFIK_CHAIN` | `FIREFIK` | string | agent | | Base chain name (prefix). |
| `FIREFIK_CHAIN_SUFFIX` | — | string | agent | | Blue/green chain suffix. |
| `FIREFIK_CLEANUP_OLD_SUFFIXES` | — | list | agent | | Auto-reaped suffixes on startup. |
| `FIREFIK_PARENT_CHAIN` | `DOCKER-USER` | string | agent | | Kernel chain that jumps to firefik. |
| `FIREFIK_DEFAULT_POLICY` | `RETURN` | string | agent | | `ACCEPT` / `DROP` / `RETURN`. |
| `FIREFIK_AUTO_ALLOWLIST` | `true` | bool | agent | | Auto-allow `firefik.enable=true` containers. |
| `FIREFIK_ENABLE_IPV6` | `false` | bool | agent | | Install `ip6tables`/`inet` rules. |
| `FIREFIK_STATEFUL_ACCEPT` | `true` | bool | agent | | Adds `ESTABLISHED,RELATED` accept to base chain. |
| `FIREFIK_DRIFT_CHECK_INTERVAL` | `300` | int (sec) | agent | | Kernel-drift reconcile interval. |
| `FIREFIK_SCHEDULE_INTERVAL` | `60` | int (sec) | agent | | Time-window rule scheduler tick. |
| `FIREFIK_CONFIG` | `/etc/firefik/rules.conf` | path | agent | | Legacy rules-file source. |
| `FIREFIK_TEMPLATES_FILE` | — | path | agent | | Rule-template definitions. |

### Policy DSL & autogen

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_POLICIES_DIR` | — | path | agent | | Directory of `.dsl` policy files. |
| `FIREFIK_POLICIES_READONLY` | `false` | bool | agent | | Block UI/API policy writes. |
| `FIREFIK_AUTOGEN_MODE` | `off` | string | agent | | `off` / `observe` / `suggest`. |
| `FIREFIK_AUTOGEN_MIN_SAMPLES` | `10` | int | agent | | Flows required before emitting proposal. |
| `FIREFIK_AUTOGEN_DB_PATH` | — | path | agent | | SQLite path for proposals. Empty = in-memory. |

### GeoIP

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_USE_GEOIP_DB` | `false` | bool | agent | | Enable GeoIP country-based rules. |
| `FIREFIK_GEOIP_DB_PATH` | `/etc/firefik/GeoLite2-Country.mmdb` | path | agent | | MMDB file location. |
| `FIREFIK_GEOIP_SOURCE` | `p3terx` | string | agent | | `p3terx` / `maxmind` / `custom`. |
| `FIREFIK_GEOIP_DOWNLOAD_URL` | — | string | agent | | Override URL for `custom` source. |
| `FIREFIK_GEOIP_LICENSE_KEY` | — | string | agent | 🔒 | MaxMind license key. |
| `FIREFIK_GEOIP_LICENSE_KEY_FILE` | — | path | agent | 🔒 | File-backed license key. |
| `FIREFIK_GEOIP_DB_AUTOUPDATE` | `false` | bool | agent | | Auto-refresh on cron. |
| `FIREFIK_GEOIP_DB_CRON` | `0 3 * * 3` | cron | agent | | Wed 03:00 weekly by default. |

### Audit sinks

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_AUDIT_SINK` | — | string | both | | `stdout` / `file` / `cef` / `remote` / comma-list. |
| `FIREFIK_AUDIT_SINK_PATH` | — | path | both | | Path for `file`/`cef` sinks. |
| `FIREFIK_AUDIT_SINK_ENDPOINT` | — | string | both | | URL for `remote` NDJSON POST. |
| `FIREFIK_AUDIT_SINK_MAX_SIZE_MB` | `100` | int | both | | Lumberjack rotation size. |
| `FIREFIK_AUDIT_SINK_MAX_BACKUPS` | `5` | int | both | | Rotated-file retention count. |
| `FIREFIK_AUDIT_SINK_MAX_AGE_DAYS` | `30` | int | both | | Rotated-file retention age. |
| `FIREFIK_AUDIT_SINK_COMPRESS` | `true` | bool | both | | gzip rotated files. |

### Webhook sink (also used by firefik-server for approval events)

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_WEBHOOK_URL` | — | string | both | | Webhook endpoint URL. Empty = disabled. On firefik-server: emits `policy_approval_*` events by default. |
| `FIREFIK_WEBHOOK_EVENTS` | (agent: 5 default actions; server: 3 approval actions) | csv | both | | Allowlist of audit `Action` values to forward. |
| `FIREFIK_WEBHOOK_SECRET` | — | string | both | 🔒 | HMAC-SHA256 signing key. Signature covers `action\ntimestamp\nbody`; replay protection via `X-Firefik-Timestamp`. Sent in `X-Firefik-Signature: sha256=…` header. |
| `FIREFIK_WEBHOOK_SECRET_FILE` | — | path | both | 🔒 | File-backed secret. |
| `FIREFIK_WEBHOOK_TIMEOUT_MS` | `5000` | int | both | | HTTP timeout per attempt; 1 retry on 5xx. |

### Observability (OTel)

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_OTEL_ENABLED` | `false` | bool | both | | Enable trace export. |
| `FIREFIK_OTEL_ENDPOINT` | `localhost:4317` (grpc) / `localhost:4318` (http) | string | both | | OTLP collector. |
| `FIREFIK_OTEL_SERVICE_NAME` | `firefik` | string | both | | Resource service name. |
| `FIREFIK_OTEL_PROTOCOL` | `grpc` | string | both | | `grpc` / `http/protobuf`. |
| `FIREFIK_OTEL_SAMPLE_RATIO` | `1.0` | float | both | | `0.0` = off, `1.0` = always. |
| `FIREFIK_OTEL_METRICS_ENABLED` | `false` | bool | both | | Enable OTLP metrics push (Prometheus bridge). |
| `FIREFIK_OTEL_METRICS_ENDPOINT` | `localhost:4317` (grpc) / `localhost:4318` (http) | string | both | | OTLP collector for metrics. Defaults follow `FIREFIK_OTEL_METRICS_PROTOCOL`. |
| `FIREFIK_OTEL_METRICS_PROTOCOL` | `grpc` | string | both | | `grpc` / `http/protobuf`. |
| `FIREFIK_OTEL_METRICS_INTERVAL` | `30s` | duration | both | | Push interval; minimum 1s. Invalid → default. |
| `FIREFIK_OTEL_LOGS_ENABLED` | `false` | bool | both | | Enable OTLP logs push. Audit events → OTel log records. |
| `FIREFIK_OTEL_LOGS_ENDPOINT` | `localhost:4317` (grpc) / `localhost:4318` (http) | string | both | | OTLP collector for logs. |
| `FIREFIK_OTEL_LOGS_PROTOCOL` | `grpc` | string | both | | `grpc` / `http/protobuf`. |
| `FIREFIK_OTEL_LOGS_TIMEOUT` | `30s` | duration | both | | Batch export timeout; minimum 1s. |

### Log level

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_LOG_LEVEL` | `info` | string | both | | `debug` / `info` / `warn` / `error`. |

### Control plane (agent → server)

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_CONTROL_PLANE_GRPC` | — | string | agent | | `host:port` of firefik-server. Empty = disabled. |
| `FIREFIK_CONTROL_PLANE_TOKEN` | — | string | agent | 🔒 | Bearer token for enroll bootstrap. |
| `FIREFIK_CONTROL_PLANE_TOKEN_FILE` | — | path | agent | 🔒 | File-backed. |
| `FIREFIK_CONTROL_PLANE_INSECURE` | `false` | bool | agent | | Skip TLS verify. **Dev only.** |
| `FIREFIK_CONTROL_PLANE_CA_CERT` | — | path | agent | | Trusted CA bundle for server cert. |
| `FIREFIK_CONTROL_PLANE_CLIENT_CERT` | — | path | agent | | Client mTLS cert. |
| `FIREFIK_CONTROL_PLANE_CLIENT_KEY` | — | path | agent | 🔒 | Client mTLS key. |
| `FIREFIK_CONTROL_PLANE_SNAPSHOT_INTERVAL` | `30` | int (sec) | agent | | Periodic state snapshot to server. |
| `FIREFIK_CONTROL_PLANE_HEARTBEAT_INTERVAL` | `30` | int (sec) | agent | | gRPC keep-alive. |
| `FIREFIK_CONTROL_PLANE_INSTANCE_ID` | `(hostname)` | string | agent | | Advertised agent-id. |
| `FIREFIK_CONTROL_PLANE_HTTP` | — | string | agent | | `https://host:port` of firefik-server's HTTP API. Empty = templates / approvals UI proxy disabled. |
| `FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE` | `259200` | int (sec) | agent | | Start self-renewal when the client cert has less than this left (72h). Must be ≤ server `FIREFIK_CP_CERT_RENEW_WINDOW`. |
| `FIREFIK_CONTROL_PLANE_CERT_RENEW_INTERVAL` | `1800` | int (sec) | agent | | Renewal check period. |
| `FIREFIK_CONTROL_PLANE_CERT_RENEW_TTL` | `2592000` | int (sec) | agent | | Requested TTL of the renewed cert (720h). |
| `FIREFIK_TEMPLATE_SYNC_INTERVAL` | `60` | int (sec) | agent | | Pull policy templates every N seconds. |
| `FIREFIK_TEMPLATE_CACHE_DIR` | `/var/lib/firefik/templates` | path | agent | | On-disk cache for synced templates (JSON files per template). |

### Control plane (server)

| Variable | Default | Type | Scope | Sensitive | Notes |
|---|---|---|---|:-:|---|
| `FIREFIK_SERVER_TOKEN` | — | string | server | 🔒 | Shared bearer token for agent auth. |
| `FIREFIK_CP_DB` | `/var/lib/firefik-server/firefik.db` | path | server | | SQLite file; `:memory:` for tests. |
| `FIREFIK_CP_TRUST_DOMAIN` | — | string | server | | SPIFFE trust domain (`spiffe://...`). |
| `FIREFIK_CP_CA_DIR` | — | path | server | | Mini-CA state directory. |
| `FIREFIK_CP_CERT_RENEW_WINDOW` | `259200` | int (sec) or duration | server | | `RenewCert` accepts a cert only within this time of expiry (72h). Keep ≥ agent `FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE`. |

---

## `firefik-admin` subcommands

All subcommands accept: `--chain`, `--parent`, `--backend`, `--output`.

| Command | Purpose | Command-specific flags |
|---|---|---|
| `inventory` | List tracked container chains | — |
| `status` | Summarize backend and chain count | — |
| `check` | Report kernel-side drift; exits ≠ 0 on drift | — |
| `drain` | Remove every firefik container chain | `--confirm`, `--yes`, `--keep-parent-jump` |
| `reconcile` | Run `engine.Reconcile` locally against Docker | `--rules-file`, `--timeout` (60s) |
| `reap` | Remove legacy blue/green chains by suffix | `--suffix` (required), `--dry-run` |
| `doctor` | Environmental pre-flight checks | `--geoip-db`, `--geoip-max-age` (14d), `--audit-path`, `--docker-socket` |
| `diff` | Compare `/api/rules` vs kernel; exit 1 on drift | `--api` (`http://127.0.0.1/api/rules`), `--token`, `--timeout` (5s) |
| `explain` | Show compiled policy rule-sets | `--api`, `--token`, `--timeout`, `--policy`, `--policy-file`, `--container` (required), `--packet` |
| `enroll` | Request / renew mTLS client cert from firefik-server | `--control-plane` (required), `--agent-id`, `--token`, `--ttl` (720h), `--out`, `--renew`, `--renew-window` (72h), `--trust-domain` |
| `force-reset` | Remove all firefik chains | `--confirm`, `--yes`, `--allow-system-chain` |

### `--output` values

- `text` (default) — human-readable.
- `json` — machine-parseable; stable schema versioned via
  `firefik_admin_schema` field.

---

## `firefik-server` subcommand & flags

### `mini-ca`

`firefik-server mini-ca init|issue` — embedded CA state management. See
[`backend/cmd/firefik-server/README.md`](../backend/cmd/firefik-server/README.md)
for flags.

### Main flags

| Flag | Default | Purpose |
|---|---|---|
| `--listen` | `:8443` | HTTP bootstrap (health + enroll) |
| `--grpc-listen` | `:8444` | gRPC transport (empty disables) |
| `--cert` | — | TLS cert (PEM) |
| `--key` | — | TLS key (PEM) |
| `--client-ca` | — | Client CA; enables mTLS when set |
| `--ca-state-dir` | `$FIREFIK_CP_CA_DIR` | Mini-CA state; empty disables `/v1/enroll` |
| `--trust-domain` | `$FIREFIK_CP_TRUST_DOMAIN` | SPIFFE trust domain; enables SAN verification |
| `--token-file` | — | Shared bearer token file for agent auth |
| `--db` | `$FIREFIK_CP_DB` | SQLite path; `:memory:` for in-memory |
| `--command-ttl` | `24h` | Pending command expiry |
| `--audit-retention` | `2160h` (90d) | Audit row retention |
| `--snapshots-per-agent` | `100` | Per-agent snapshot cap |
| `--retention-interval` | `15m` | Retention loop period |
| `--renew-window` | `$FIREFIK_CP_CERT_RENEW_WINDOW` (`72h`) | `RenewCert` rejects certs with more than this left; keep ≥ agent renew-before |
| `--min-renew-interval` | `5m` | Rate limit between two `RenewCert` calls from one cert serial |

---

## See also

- [operations.md](operations.md) — runtime ops narrative.
- [control-plane.md](control-plane.md) — gRPC + enrollment flow.
- [security-hardening.md](security-hardening.md) — prod checklist.
- [metrics-guide.md](metrics-guide.md) — per-metric alert thresholds.
- [upgrade.md](upgrade.md) — moving between 0.x releases.
- [troubleshoot.md](troubleshoot.md) — incident decision tree.
