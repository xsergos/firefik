# Firefik Runbook

Operational playbooks for routine tasks. `operations.md` covers "what to
do when something is broken"; this doc covers "how to do a routine task
correctly the first time".

Every playbook assumes:

- `FIREFIK_API_TOKEN` is set in the operator's shell (for `firefik-admin` /
  direct API calls).
- `docker compose` v2+ with the repository's [docker-compose.yml](../docker-compose.yml).
- Backend listens on the unix socket `/run/firefik/api.sock` unless
  otherwise noted.

---

## 1. Rolling deploy (blue/green)

Use when you want to roll out a new firefik image with zero-downtime
for container firewall coverage.

### Pre-flight

```bash
# Confirm the running stack is healthy before touching it
firefik-admin check --output json | jq '.drift == false'
docker compose exec firefik-back firefik-admin inventory --output json | jq 'length'
```

### Procedure

1. **Stand up green with a fresh suffix**.

   ```bash
   FIREFIK_CHAIN_SUFFIX=v2 STACK_PREFIX=firefik-v2 \
     docker compose -p firefik-v2 up -d --wait
   ```

   Green installs `FIREFIK-v2` (iptables) or container chains
   `firefik-v2-<id>` (nftables) *alongside* blue's chains; the two
   stacks do not conflict.

2. **Switch upstream traffic** (Caddy / nginx / load balancer) to
   green's frontend port. If both use `FIREFIK_HTTP_PORT=80` bind
   green to a different port first, flip DNS/LB, then green is the
   canonical UI.

3. **Drain blue after soak** (≥ 5 min, verify Prometheus shows no
   error spike on green):

   ```bash
   # Option A: automatic cleanup on next firefik start
   #   — set on the fresh green's env:
   FIREFIK_CLEANUP_OLD_SUFFIXES=v1
   docker compose -p firefik-v2 restart firefik-back
   ```

   ```bash
   # Option B: manual reap (surgical, logs what it removed)
   firefik-admin reap --suffix v1 --dry-run
   firefik-admin reap --suffix v1
   ```

4. **Tear down blue compose project**:

   ```bash
   docker compose -p firefik-v1 down
   ```

### Verify

```bash
# No v1 chains left in the kernel
nft list table inet firefik | grep -c 'firefik-v1-' || true
iptables-save -t filter | grep -c 'FIREFIK-v1-' || true
# Should print 0 on both lines.

# Green is authoritative
curl -sf -H "Authorization: Bearer $FIREFIK_API_TOKEN" \
  http://localhost/api/containers | jq 'length'
```

### Rollback

```bash
# If green is unhealthy and blue is still up (within 5 min soak):
#   1. Flip LB/DNS back to blue.
#   2. Keep blue running; tear down green.
docker compose -p firefik-v2 down
# If blue was already drained, re-apply with the last good image tag.
```

---

## 2. Emergency rollback

Use when the currently-running firefik version misbehaves in prod
(apply errors, kernel crashes, UI broken).

### Pre-flight

```bash
docker compose ps firefik-back firefik-front
journalctl -u docker --since '10 min ago' | grep -i firefik | tail -50
```

### Procedure

1. **Identify the last known-good image tag** from
   `docker compose config | grep image` or CHANGELOG.

2. **Pin the image**:

   ```bash
   image: ghcr.io/<owner>/firefik-back:<known-good-tag>
   ```

3. **Restart the stack** (leaves kernel chains intact; backend
   re-attaches via `Rehydrate`):

   ```bash
   docker compose pull firefik-back
   docker compose up -d firefik-back firefik-front
   ```

4. **Reconcile explicitly** after startup to catch any state drift
   from the old version:

   ```bash
   docker compose exec firefik-back firefik-admin reconcile --backend auto
   ```

### Verify

```bash
firefik-admin check --output json | jq '{drift, base_chain_present, parent_jump_present}'
docker compose exec firefik-back wget -qO- http://127.0.0.1/health
```

### Rollback-of-rollback

If the old version also misbehaves, use `firefik-admin drain --confirm`
to strip firefik's chains entirely and let Docker's default FORWARD
accept traffic while you debug upstream.

```bash
docker compose exec firefik-back firefik-admin drain --chain FIREFIK --confirm
docker compose stop firefik-back
```

Once firefik-back is down, container traffic falls back to Docker's
built-in iptables behaviour (usually allow-all between containers on
user networks).

---

## 3. GeoIP database refresh

Use when you want to force-refresh the GeoIP database (e.g. after a
suspected stale-data incident) or when `FIREFIK_GEOIP_DB_AUTOUPDATE=false`.

### Pre-flight

```bash
# Current DB age
docker compose exec firefik-back stat -c '%y' /etc/firefik/GeoLite2-Country.mmdb
```

### Procedure — P3TERX source (default, no license key)

1. **Trigger auto-update** if enabled (default cron: Wednesdays 03:00):

   ```bash
   docker compose exec firefik-back kill -HUP 1
   # Backend handles SIGHUP by immediately running the updater.
   ```

2. **Manual download** if auto-update is disabled:

   ```bash
   docker compose exec firefik-back wget -O /etc/firefik/GeoLite2-Country.mmdb.new \
     'https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-Country.mmdb'
   docker compose exec firefik-back mv \
     /etc/firefik/GeoLite2-Country.mmdb.new \
     /etc/firefik/GeoLite2-Country.mmdb
   docker compose restart firefik-back
   ```

### Procedure — MaxMind source (license key required)

```bash
FIREFIK_GEOIP_SOURCE=maxmind FIREFIK_GEOIP_LICENSE_KEY_FILE=/run/secrets/mm \
  docker compose restart firefik-back
# auto-updater runs once on startup, then on the cron schedule.
```

### Verify

```bash
docker compose exec firefik-back stat -c '%y %s' /etc/firefik/GeoLite2-Country.mmdb
# Size should be > 1 MB.

# Confirm geoblock rules still resolve
curl -sf -H "Authorization: Bearer $FIREFIK_API_TOKEN" \
  http://localhost/api/stats | jq .
```

### Rollback

Keep the previous `.mmdb` as `.mmdb.bak` before overwriting if you're
paranoid:

```bash
docker compose exec firefik-back cp /etc/firefik/GeoLite2-Country.mmdb{,.bak}
```

Restoring:

```bash
docker compose exec firefik-back mv /etc/firefik/GeoLite2-Country.mmdb{.bak,}
docker compose restart firefik-back
```

---

## 4. Zero-packet-loss cutover

Use when swapping backend image or chain topology without dropping a
single packet — for latency-sensitive workloads (payments, gaming,
trading).

This is **blue/green plus conntrack preservation**: the old chain stays
primed until all existing flows have drained, new flows hit the new
chain.

### Pre-flight

```bash
# Capacity check — conntrack table size
docker compose exec firefik-back cat /proc/sys/net/netfilter/nf_conntrack_count
docker compose exec firefik-back cat /proc/sys/net/netfilter/nf_conntrack_max
# If count > 50% of max, raise the limit before cutover.

# Baseline drop counter (on the affected interface)
nft list table inet firefik | grep -c counter || true
```

### Procedure

1. **Stand up green alongside blue** (as in playbook 1). Both chains
   are active; green's FORWARD rule is inserted *after* blue's.

2. **Wait for drain window** — duration = longest expected flow TTL +
   small buffer. For typical web traffic 60 s is enough; for
   long-polling or streaming, base it on your app's idle timeout:

   ```bash
   sleep 90
   ```

3. **Swap FORWARD jump order** to prefer green:

   ```bash
   # iptables: move green's jump to position 1
   iptables -t filter -D DOCKER-USER -j FIREFIK-v2
   iptables -t filter -I DOCKER-USER 1 -j FIREFIK-v2

   # nftables equivalent — edit the forward chain ruleset
   ```

4. **Soak for 5+ min**. Watch for:

   ```bash
   curl -sf -H "Authorization: Bearer $FIREFIK_API_TOKEN" \
     http://localhost/metrics | grep -E 'firefik_engine_apply|logstream_dropped'
   ```

5. **Reap blue**:

   ```bash
   firefik-admin reap --suffix v1
   ```

### Verify

- Application-side: response-time histogram p99 does not spike during
  the cutover window.
- Firefik-side: `firefik_engine_apply_duration_seconds_bucket` stable;
  `firefik_logstream_dropped_total` rate unchanged.
- Conntrack: `nf_conntrack_count` does not drop sharply (would indicate
  flow reset).

### Rollback

Re-insert blue's jump before green's (reverse step 3), then reap green
instead of blue. Procedure is symmetric.

---

## 5. Cert lifecycle runbooks

### 5.1 Server cert manual rotation

Hot-reload-friendly — does not interrupt the running process.

```bash
sudo firefik-server cert rotate --ca-state-dir /var/lib/firefik-server/ca
# add --force to rotate even if cert is healthy
```

`tls.Config.GetCertificate` re-reads the file on the next handshake;
existing connections stay up.

### 5.2 Mini-CA root rotation

```bash
# 1. Re-init mini-CA into a new dir (rotates root + issuing keys).
sudo firefik-server mini-ca init --state-dir /var/lib/firefik-server/ca-new \
    --trust-domain spiffe://firefik.local/

# 2. Swap dirs and restart firefik-server (pick up new issuer).
sudo systemctl stop firefik-server
sudo mv /var/lib/firefik-server/ca /var/lib/firefik-server/ca-old
sudo mv /var/lib/firefik-server/ca-new /var/lib/firefik-server/ca
sudo systemctl start firefik-server

# 3. Daily-check goroutine will detect the issuer change and re-issue
#    the server cert (reason="issuer_rotated"). Force it immediately:
sudo firefik-server cert rotate --force

# 4. Each agent's next renew tick (default every 30m) will pick up the
#    new ca-bundle.pem via RenewCert response — no manual push needed.
#    Watch firefik_agent_bundle_rotated_total ticking across the fleet.
```

If the old root must be untrusted immediately, revoke every issued
agent serial and remove `ca-old`. Otherwise leave `ca-old` available
for two weeks for the rare agent that missed the rollover window.

### 5.3 "Agent can't renew" diagnostic

| Symptom | Likely cause | Fix |
|---|---|---|
| RenewCert error `PermissionDenied: revoked` | serial in `<state-dir>/revoked.json` | Re-enroll agent: `firefik-admin enroll` (operator path) |
| RenewCert error `ResourceExhausted` | hit `--min-renew-interval` rate-limit | Wait or raise the limit |
| RenewCert error `FailedPrecondition: certificate valid for ...; renew window is ...`, `firefik_agent_cert_renew_failed_total{reason="outside_window"}` | CP `--renew-window` (`FIREFIK_CP_CERT_RENEW_WINDOW`) is shorter than agent `FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE`; the CP logs a startup warning when its window is below the 72h agent default | Raise the CP window to at least the agent renew-before (default 72h on both sides). The agent backs off to the CP window after the first rejection, so the cert still renews, only later |
| TLS handshake error reaching `:8444` | server cert SAN mismatch / expired | `firefik-server cert rotate --force` |
| Renew goroutine never logs anything | `FIREFIK_CONTROL_PLANE_GRPC` empty | Set the gRPC endpoint |

---

## Appendix — Common commands

| Task | Command |
|---|---|
| Health snapshot | `firefik-admin check --output json` |
| Live chain inventory | `firefik-admin inventory --output json` |
| Local reconcile (main service down) | `firefik-admin reconcile --backend auto` |
| Prune a suffix tree | `firefik-admin reap --suffix vN [--dry-run]` |
| Tear everything (last resort) | `firefik-admin force-reset --confirm` |

See [docs/operations.md](operations.md) for incident-response flows
and [README.md](../README.md) for the full env-var reference.
