# Firefik — Metrics guide

Every Prometheus metric firefik emits, with the context you need to
build alerts. For alert expressions already shipped, see
[`alerts/firefik.yml`](../alerts/firefik.yml). For dashboard JSON, see
[`dashboards/`](dashboards/).

---

## How to scrape

Both `firefik-back` and `firefik-server` expose `/metrics`:

```yaml
scrape_configs:
  - job_name: firefik-agent
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/firefik-metrics-token
    scheme: http
    static_configs:
      - targets: ['host1:<api-port>', 'host2:<api-port>']
  - job_name: firefik-server
    scheme: https
    tls_config:
      ca_file: /etc/prometheus/firefik-ca.pem
      cert_file: /etc/prometheus/prometheus.pem
      key_file: /etc/prometheus/prometheus.key
    static_configs:
      - targets: ['firefik-server:8443']
```

Recommended scrape interval: **30 s**. Lower = higher load on
`/metrics` rate limiter (`FIREFIK_METRICS_RATE_*`).

---

## Engine (firewall application)

### `firefik_engine_reconcile_total` (counter)
Total reconcile cycles. **No labels.** Should grow steadily; absence
means reconciler stalled.

- **Alert**: `increase(firefik_engine_reconcile_total[15m]) == 0` for 10m.

### `firefik_engine_reconcile_errors_total` (counter)
Failed reconciles. **No labels.**

- **Threshold**: rate > 0.
- **Alert**: `rate(firefik_engine_reconcile_errors_total[5m]) > 0`.
- **What it means**: Docker list failure, backend unavailable, or
  kernel-rule emit error mid-cycle.

### `firefik_engine_reconcile_duration_seconds` (histogram)
Wall-clock of one reconcile.

- **Typical p95**: < 1s on ≤ 50 containers; < 5s on 200+.
- **Alert on p95 > 10s**: either container count exploded, Docker is
  slow, or kernel is thrashing.

### `firefik_engine_apply_duration_seconds` (histogram, label `result`)
Per-container rule apply. `result` ∈ {`success`, `error`}.

- **Alert** on error-rate: `sum(rate(firefik_engine_apply_duration_seconds_count{result="error"}[5m])) / sum(rate(firefik_engine_apply_duration_seconds_count[5m])) > 0.05`.

### `firefik_engine_apply_errors_total` (counter, label `phase`)
Grouped errors. `phase` ∈ {`backend`, `labels`, `policy_compile`,
`geoip`, `kernel_emit`}.

- **Action by phase**:
  - `backend`: iptables/nft command failed — check kernel logs.
  - `labels`: malformed container label — owner's fault, log container.
  - `kernel_emit`: rule rejected by kernel — often duplicate suffix
    collision; reap.

### `firefik_engine_orphans_cleaned_total` (counter)
Orphan container chains removed (dead container + leftover rules).
Steady low rate is normal; spike = many container crashes.

### `firefik_engine_rehydrated_chains` (gauge)
Set once at startup. Non-zero after restart means firefik recovered
previous kernel state without user action — this is by design.

### `firefik_engine_legacy_cleanup_errors_total` (counter, label `suffix`)
Blue/green reap failures.

- **Alert**: `increase(firefik_engine_legacy_cleanup_errors_total[1h]) > 0`.
- **Remediate**: manual `firefik-admin reap --suffix=<suffix>`.

### `firefik_engine_drift_total` (counter, label `type`)
Detected kernel↔memory divergence. `type` ∈ {`missing_chain`,
`extra_rule`, `wrong_jump`, `policy_mismatch`}.

- **Threshold**: rate > 0.1/min.
- **Alert**: any non-zero rate over 10m (drift should self-heal within
  1–2 reconcile cycles).

### `firefik_engine_drift_checks_total` + `firefik_engine_drift_check_errors_total`
Drift detector heartbeat. Errors = can't enumerate kernel state.

### `firefik_engine_scheduled_reconcile_total` (counter)
Reconciles from time-window scheduler. Zero on fleets without
scheduled rules — safe to ignore.

### `firefik_engine_scheduled_toggle_total` (counter, label `direction`)
Rule-set transitions by schedule. `direction` ∈ {`activated`,
`deactivated`}.

---

## Autogen (observe-mode proposal generator)

### `firefik_autogen_flows_recorded_total` (counter)
NFLOG flows accepted into the observer. Zero = observer disabled or
no traffic.

### `firefik_autogen_resolve_miss_total` (counter)
Flows dropped because neither endpoint IP mapped to a tracked
container.

- **Threshold**: miss-ratio > 30% means your container network
  topology changed faster than firefik's IP index refresh.
- **Alert**: `sum(rate(firefik_autogen_resolve_miss_total[5m])) / sum(rate(firefik_autogen_flows_recorded_total[5m])) > 0.3` for 15m.

---

## Control plane (firefik-server side)

### `firefik_controlplane_grpc_agents_connected` (gauge)
Currently connected agents on gRPC Stream RPC.

- **Alert**: gauge drops by > 20% in 5m compared to 1h baseline =
  network partition or server crash-loop.

### `firefik_controlplane_connection_state` (gauge, labels `peer`,
`transport`) — *agent side*
- `1` = connected, `0.5` = reconnecting, `0` = backoff, `-1` = disabled.
- **Alert**: `firefik_controlplane_connection_state < 1` for 10m.

### `firefik_controlplane_transport_requests_total` (counter, label
`transport`)
All accepted control-plane requests.

### `firefik_controlplane_mtls_rejected_total` (counter, label `reason`)
Peer certs rejected. `reason` ∈ {`trust_domain`, `no_uri_san`,
`expired`, `unknown_ca`}.

- **Threshold**: any rate > 0 under normal operation is suspicious.
- **Alert**: `rate(firefik_controlplane_mtls_rejected_total[5m]) > 0`.
- **Action**: correlate with connecting-peer IP in log; possible
  fleet impostor or stale cert.

### `firefik_controlplane_ca_certs_issued_total` (counter)
Agent certs issued via `/v1/enroll`. Spike after fleet rotation is
normal; continuous rate > 0 on stable fleet = someone's re-enrolling
unnecessarily.

### `firefik_controlplane_audit_events_total` (counter)
Audit rows written by server.

### `firefik_controlplane_db_bytes` (gauge)
SQLite file size. Growth rate should be bounded by retention
settings (`--audit-retention`, `--snapshots-per-agent`).

- **Alert**: db > 10GB = retention loop not running; check
  `--retention-interval`.

### `firefik_controlplane_commands_enqueued_total` (counter, label
`kind`)
Commands sent agent-ward by kind.

- **Threshold**: kind-specific — spike in `apply_rules` during
  policy rollout is expected.

### `firefik_controlplane_agent_cert_days_until_expiry` (gauge,
labels `agent_id`, `spiffe_id`) — *v0.11+*
Days until each agent's cert expires. A healthy agent renews on the
first tick after the value crosses its renew-before (agent
`FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE`, default 72h = 3 days) and
the value jumps back to the cert TTL (default 30 days). In a healthy
cycle it never goes below ~3 days.

- **Alert (warn)**: `min by(agent_id) (firefik_controlplane_agent_cert_days_until_expiry) < 2`
  — renewal is at least one day late.
- **Alert (crit)**: same metric `< 1`. If the CP stays unreachable the
  cert expires and the agent needs a manual re-enroll.
- Keep the warn threshold below renew-before in days. With a longer
  renew-before, raise both thresholds with it.

### `firefik_agent_cert_renew_failed_total` (counter, label `reason`, agent)
Failed self-renewal attempts, by reason.

| `reason` | Meaning |
|---|---|
| `outside_window` | CP answered `FailedPrecondition`: the cert is not yet inside the CP `--renew-window`. The agent logs at Info and waits until it is. Means the CP window is shorter than the agent renew-before. |
| `rate_limited` | CP answered `ResourceExhausted` (`--min-renew-interval`). |
| `denied` | CP answered `PermissionDenied` / `Unauthenticated`: revoked serial, trust-domain or agent-id mismatch, no client cert. Needs a re-enroll. |
| `rpc_error` | Anything else: CP unreachable, transport error, CP internal error, CP without CA. |
| `load_cert`, `build_csr`, `empty_response`, `write_cert` | Local failures on the agent. |

- **Alert (warn)**: `increase(firefik_agent_cert_renew_failed_total{reason=~"rpc_error|denied"}[2h]) > 0`.
  With default settings every reason stays at 0 during a healthy
  cycle, so no filter is needed.
- `outside_window` above 0 means CP `--renew-window` < agent
  renew-before. Fix the config (see
  [control-plane.md](control-plane.md#renew-window)).

---

## API & log stream

### `firefik_rules_active` (gauge, label `container`)
Count of active iptables rules per container.

- **High-cardinality watch**: label value is container short-ID.
  Bounded by "enabled containers". Cap in practice: fleets of
  ~500 containers/host.

### `firefik_packets_total` (counter, labels `container`, `action`)
Packet counters from kernel chain statistics.

- **Cardinality**: `container` × `action` (action ∈ {`accept`, `drop`,
  `return`}). OK.

### `firefik_reconcile_duration_seconds` (histogram)
Alias/legacy of `firefik_engine_reconcile_duration_seconds`. Prefer
the `engine_` name.

### `firefik_docker_events_total` (counter, label `event_type`)
Docker API events received (`start`, `die`, `destroy`, `rename`).
Silence here + no containers being managed = Docker socket dead.

### `firefik_logstream_dropped_total` (counter)
Log messages dropped because a WebSocket subscriber can't keep up.

- **Alert**: `rate(firefik_logstream_dropped_total[5m]) > 10` for 15m
  = client falling behind; consider fewer subscribers or dedicated
  log forwarder.

---

## Cardinality discipline

Firefik deliberately keeps label cardinality low:

- `container` = short-ID only (12 chars), bounded by containers-per-host.
- `action`, `phase`, `reason`, `direction`, `type`, `kind`, `transport`,
  `suffix` = enumerated, small.
- `result` = {`success`, `error`}.
- `agent_id` / `spiffe_id` = bounded by fleet size.

No metric labels on rule names, port numbers, or IPs. If you find
an exception, it's a bug — file an issue.

The v0.11 `firefik-admin metrics-audit` subcommand verifies cardinality
empirically against live `/metrics` output. Run it weekly as a
preventive check.

---

## Dashboards

- [`dashboards/firefik-overview.json`](dashboards/firefik-overview.json)
  — agent-side overview (engine, reconcile, drift, packets).
- [`dashboards/firefik-controlplane.json`](dashboards/firefik-controlplane.json)
  — control-plane: connected agents, connection-state per peer, mTLS
  rejections, cert-days-until-expiry, transport mix, command throughput,
  audit events, sqlite size.

---

## See also

- [`alerts/firefik.yml`](../alerts/firefik.yml) — ready-to-deploy alert
  rules (aligned with the thresholds above).
- [operations.md](operations.md) — runtime ops narrative.
- [reference.md](reference.md) — env-var reference.
