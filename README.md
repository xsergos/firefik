# Firefik

Docker container firewall manager with iptables/nftables support, IPv4/IPv6, web UI and Prometheus metrics.

## Requirements

- Linux host with Docker
- `NET_ADMIN` and `NET_RAW` capabilities
- One of:
  - **iptables** + **ip6tables** (for IPv6)
  - **nftables** (handles IPv4 and IPv6 natively via `inet` family)
- Docker socket access (`/var/run/docker.sock`)
- Go 1.26+ (build only)
- Node.js 24+ (frontend build only)

## Quick Start

```bash
docker compose up -d
```

The web UI is available at `http://<host>:80`. The backend runs on a Unix socket shared between containers via a Docker volume.

To build a standalone binary:

```bash
docker compose run --rm backend-build
# Binary is in ./bin/firefik
```

## Environment Variables

The full env-var reference (every variable with its default, type,
scope, and sensitivity) is in [docs/reference.md](docs/reference.md).
The most-used variables in a Compose deployment:

| Variable | Default | Description |
|---|---|---|
| `FIREFIK_API_TOKEN` (or `_FILE`) | *(required for TCP)* | Bearer token for `/api`, `/ws`, `/metrics`. Refuses to start on a TCP listener without it. |
| `FIREFIK_LISTEN_ADDR` | `unix:///run/firefik/api.sock` | TCP (`:8080`) or unix-socket listener. Unix socket is the recommended default. |
| `FIREFIK_METRICS_LISTEN` | — | Optional dedicated listener for `/metrics` (e.g. `tcp://127.0.0.1:9180`). Keeps the API on a unix socket while letting Prometheus-style scrapers reach metrics over TCP. See [docs/operations.md](docs/operations.md#dedicated-metrics-listener). |
| `FIREFIK_BACKEND` | `auto` | Firewall backend: `auto`, `iptables`, `nftables`. |
| `FIREFIK_DEFAULT_POLICY` | `RETURN` | Default verdict for containers when no rule matches. |
| `FIREFIK_AUTO_ALLOWLIST` | `true` | Auto-allowlist a container's own Docker network CIDRs. |
| `FIREFIK_ENABLE_IPV6` | `false` | Enable IPv6 rules (nftables `inet` handles both natively). |
| `FIREFIK_CHAIN_SUFFIX` | — | Blue/green deploy suffix — chain becomes `${FIREFIK_CHAIN}-${SUFFIX}`. |
| `FIREFIK_AUDIT_SINK` | — | `json-file` / `cef-file` / `remote` / `history`; comma-list for fan-out. |
| `FIREFIK_CONTROL_PLANE_GRPC` | — | gRPC endpoint for the optional control plane (see [docs/control-plane.md](docs/control-plane.md)). |

## API contract

Firefik ships an OpenAPI 2.0 specification embedded in the backend
binary. Fetch it at runtime:

```
GET /api/v1/openapi.json
GET /api/v1/openapi.yaml
```

CI re-runs `make openapi` and fails on drift, so the committed spec
at [backend/internal/api/openapi/swagger.json](backend/internal/api/openapi/swagger.json)
is always in sync with the handlers. See [docs/api.md](docs/api.md)
for a deeper description and regeneration workflow.

## Fleet panel

Firefik ships a unified web panel for managing many hosts from a single
control plane (Portainer-edge-style):

- **Fleet view** — `/fleet` lists every enrolled agent with `status`
  (healthy/stale/dead) derived from `last_seen`.
- **Agent detail** — `/fleet/:id` shows the latest snapshot (per-container
  firewall status, default policy, source attribution `default`/`config`/
  `label`, rule-set count) plus per-container **Apply**/**Disable** and
  agent-wide **Reconcile**/**Rotate token** actions.
- **Live logs** — the agent forwards its `nflog` stream over the gRPC
  push channel; the panel subscribes to a per-agent WebSocket
  (`/api/agents/{id}/logs`) and tails up to 500 lines client-side.
- **Add agent** — `/fleet/add` issues a one-time enrollment token and
  generates a copy-paste bash snippet that fetches the mTLS bundle from
  `/v1/enroll`. Token is single-use and TTL-bounded; see
  [docs/control-plane.md](docs/control-plane.md#edge-enrollment-one-time-token).

Bring the panel up with the `controlplane` Compose profile:

```bash
docker compose --profile controlplane up -d
# Panel: http://<host>:8090
# Backend: control plane on 8443/HTTP + 8444/gRPC
```

The panel proxies through Caddy (`frontend/Caddyfile.panel`), which
auto-handles WebSocket upgrade for `/api/agents/*/logs` and injects the
operator bearer token onto upstream `/v1/...` calls.

## Operator tooling

`firefik-admin` is a separate emergency CLI shipped alongside the main service:

| Command | Purpose |
|---|---|
| `firefik-admin inventory` | List tracked container chains (read-only). |
| `firefik-admin status`    | Summarise backend + chain count (read-only). |
| `firefik-admin check`     | Report kernel-side drift; exits 2 on drift. |
| `firefik-admin drain --confirm` | Progress-logged removal of every firefik container chain. `--keep-parent-jump` retains the DOCKER-USER hook for blue/green rollback. |
| `firefik-admin reconcile` | Run `engine.Reconcile` locally against the Docker daemon (disaster recovery — run only when the main service is down). |
| `firefik-admin reap --suffix <v>` | Remove a legacy blue/green chain tree by suffix (scoped to that suffix; supports `--dry-run`). |
| `firefik-admin force-reset --confirm` | Nuclear option: remove every firefik container chain. |

All commands accept `--chain`, `--parent`, `--backend {iptables,nftables,auto}`.
`inventory`, `status`, `check` accept `--output json` for CI / cron
integration. `force-reset` refuses to touch Docker / system chains unless
`--allow-system-chain` is passed; `force-reset` and `drain` surface a
clear "no terminal attached" error on EOF when neither `--confirm` nor
`--yes` is passed.

## Docker Labels

Add labels to containers to configure firewall rules.

### Enable firewall

```yaml
labels:
  firefik.enable: "true"
```

### Default policy

```yaml
labels:
  firefik.defaultpolicy: "DROP"  # DROP, RETURN, ACCEPT
```

### Disable auto-allowlist

By default, traffic from the container's own Docker network is allowed. To disable:

```yaml
labels:
  firefik.no-auto-allowlist: "true"
```

### Rule sets

Rule sets are defined via `firefik.firewall.<name>.<param>` labels.

**Parameters:**

| Parameter | Description | Example |
|---|---|---|
| `ports` | Comma-separated ports | `80,443` |
| `allowlist` | IPs, CIDRs, ranges, or Docker network names | `10.0.0.0/8,192.168.1.100` |
| `blocklist` | IPs, CIDRs, ranges, or Docker network names | `203.0.113.0/24` |
| `protocol` | `tcp` (default) or `udp` | `udp` |
| `profile` | Preset: `web` or `internal` | `web` |
| `ratelimit.rate` | Packets per second | `100` |
| `ratelimit.burst` | Burst size (default 20) | `50` |
| `log` | Enable NFLOG logging | `true` |
| `log.prefix` | Custom log prefix | `MY-SVC` |
| `geoblock` | Comma-separated country codes to block | `CN,RU` |
| `geoallow` | Comma-separated country codes to allow | `US,DE` |

### Allowlist formats

- Single IP: `192.168.1.1` or `2001:db8::1`
- CIDR: `10.0.0.0/8` or `2001:db8::/32`
- Range: `192.168.1.100-200` or `192.168.1.1-192.168.1.50`
- IPv6 range: `2001:db8::1-2001:db8::ff`
- Docker network name: `my_network` (resolved to the network's CIDR at apply time)

### Profiles

- **`web`** — defaults to ports `80,443` and allowlist `0.0.0.0/0,::/0`
- **`internal`** — defaults to allowlist `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7`

### Allowlist + default policy semantics

Traffic is matched per rule set in this order:

1. Blocklist for the port → DROP (with optional NFLOG).
2. Allowlist for the port → ACCEPT (subject to rate-limit, see below).
3. **Anything else targeting that port** → DROP (unconditional, regardless of
   `defaultPolicy`).
4. Traffic that does not match any configured port → `defaultPolicy`
   (`DROP`, `RETURN` or `ACCEPT`).

This is intentional: configuring a port implicitly closes it to everyone not
explicitly allow-listed. `defaultPolicy` only governs traffic on ports you
did **not** list. `RETURN` returns to the parent chain (`DOCKER-USER` on
iptables, the forward hook on nftables), letting upstream rules decide.

### Rate limit semantics

`ratelimit.rate` is enforced **per source IP** on both backends:

- **iptables**: via `hashlimit --hashlimit-mode srcip`.
- **nftables**: via a dynamic set (`type ipv4_addr` / `ipv6_addr`, flags
  `dynamic timeout`) and a per-element `limit` — each source IP gets its own
  token bucket.

Traffic from a source that exceeds its bucket falls through to a matching
DROP rule. The bucket refills at `rate` packets per second, allowing a short
`burst`.

### Examples

**Web server open to the world:**

```yaml
labels:
  firefik.enable: "true"
  firefik.defaultpolicy: "DROP"
  firefik.firewall.http.profile: "web"
```

**Service with restricted access and rate limiting:**

```yaml
labels:
  firefik.enable: "true"
  firefik.defaultpolicy: "DROP"
  firefik.firewall.api.ports: "8080"
  firefik.firewall.api.allowlist: "10.0.0.0/8,192.168.1.0/24"
  firefik.firewall.api.ratelimit.rate: "100"
  firefik.firewall.api.ratelimit.burst: "50"
```

**Database — internal network only:**

```yaml
labels:
  firefik.enable: "true"
  firefik.defaultpolicy: "DROP"
  firefik.firewall.db.ports: "5432"
  firefik.firewall.db.profile: "internal"
```

**Block specific countries, allow everything else:**

```yaml
labels:
  firefik.enable: "true"
  firefik.firewall.geo.ports: "443"
  firefik.firewall.geo.allowlist: "0.0.0.0/0"
  firefik.firewall.geo.geoblock: "CN,RU"
```

**Multiple rule sets:**

```yaml
labels:
  firefik.enable: "true"
  firefik.defaultpolicy: "DROP"
  firefik.firewall.http.ports: "80,443"
  firefik.firewall.http.allowlist: "0.0.0.0/0"
  firefik.firewall.ssh.ports: "22"
  firefik.firewall.ssh.allowlist: "10.0.0.0/8"
  firefik.firewall.ssh.ratelimit.rate: "5"
```

## YAML Rules File

As an alternative (or addition) to labels, rules can be defined in a YAML file. Set `FIREFIK_CONFIG` to the file path. The file is watched for changes and rules are reloaded automatically.

```yaml
rules:
  - container: my-nginx
    name: http
    ports: [80, 443]
    allowlist:
      - "0.0.0.0/0"
    defaultPolicy: DROP

  - container: my-postgres
    name: db
    ports: [5432]
    allowlist:
      - "10.0.0.0/8"
      - "172.16.0.0/12"
    protocol: tcp
    profile: internal
    defaultPolicy: DROP
```

File rules are merged with label rules. If a rule set with the same name exists in both, the label version takes priority.

### Host-level rules

Container rules apply to traffic destined to a specific docker container.
Host rules apply to traffic destined to the host itself — useful for
SSH allowlists, default-DROP postures on management interfaces, or
blocking known-bad nets at the host edge:

```yaml
host_default: DROP        # ACCEPT (default) | DROP
host_rules:
  - name: ssh
    protocol: tcp
    ports: [22]
    allowlist:
      - 10.0.0.0/8
      - 192.168.1.5
  - name: block-china
    protocol: tcp
    ports: [80, 443]
    blocklist:
      - 203.0.113.0/24
  - name: allow-icmp        # ping/traceroute; needed once host_default is DROP
    protocol: icmp
    allowlist:
      - 10.0.0.0/8
  - name: allow-icmpv6      # IPv6 needs ICMPv6 (NDP) or v6 connectivity breaks
    protocol: icmpv6
```

With `host_default: DROP` the host stops answering ICMP (ping,
traceroute, MTU discovery) unless you add an explicit rule. Add an
`icmp` rule for IPv4 and an `icmpv6` rule for IPv6 — the latter is
effectively mandatory on dual-stack hosts because Neighbor Discovery
rides on ICMPv6.

**Supported `protocol` values:** `tcp`, `udp`, `icmp`, `icmpv6` (alias
`ipv6-icmp`), or omit/`any` to match every protocol. `ports` apply to
`tcp`/`udp` only. On the **nftables** backend an unrecognised protocol
is skipped (logged, not applied) rather than opened — a host rule never
fails open. On the **iptables** backend the value is passed straight to
`-p`, so any protocol name `iptables` knows also works there.

Internally firefik maintains a dedicated `FIREFIK_HOST` chain hooked
from `INPUT` (iptables) or a `chain input` block of type filter
(nftables). Both backends keep an `ESTABLISHED,RELATED` accept rule
at the top when stateful mode is on. Remove the `host_rules` and
`host_default` keys (or empty the section) to tear the host chain
down on the next reconcile.

## API

The HTTP surface is described in the embedded OpenAPI 2.0 spec
(`GET /api/v1/openapi.json`). See [docs/api.md](docs/api.md) for the
endpoint inventory and [docs/control-plane.md](docs/control-plane.md)
for the optional fleet-wide control plane.

## Architecture

```
┌──────────┐     unix socket     ┌──────────┐     docker.sock     ┌────────┐
│ Frontend │ ──────────────────> │ Backend  │ ──────────────────> │ Docker │
│ (Caddy)  │  /api, /ws, static │ (Go)     │  events, inspect    │        │
└──────────┘                     └──────────┘                     └────────┘
                                      │
                                      ├── iptables / ip6tables
                                      └── nftables
```

- **Backend** runs with `network_mode: host` and `NET_ADMIN` capability to manage host firewall rules
- **Frontend** is a React SPA served by Caddy, which proxies API/WebSocket to the backend via Unix socket
- Docker events trigger automatic rule application/removal on container start/stop
