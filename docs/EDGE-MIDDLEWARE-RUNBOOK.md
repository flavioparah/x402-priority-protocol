# Edge Middleware Runbook — x402-Shield (Phase 1)

This runbook covers the 4 Traefik middlewares applied at the TLS edge in front
of `x402-shield-{devnet,mainnet}`:

| Middleware | Effect | Configured value |
|---|---|---|
| `x402-ratelimit` | Per-IP token-bucket throttle | 30 req/s sustained, burst 60 |
| `x402-inflight` | Cap on concurrent connections | 200 (cumulative across devnet+mainnet) |
| `x402-bodylimit` | Reject oversized POST bodies | 64KB max, 16KB memory buffer |
| `x402-headers` | Inject HSTS / no-sniff / XSS / referrer; strip Server / X-Powered-By | HSTS 1y + subdomains |

Spec: [`docs/superpowers/specs/2026-05-08-defesa-flood-e-enforcement-agentico-design.md`](superpowers/specs/2026-05-08-defesa-flood-e-enforcement-agentico-design.md) §5.

## Naming choice — cumulative inflight

The 4 middleware names are identical between `docker-compose.devnet.yml` and
`docker-compose.mainnet.yml`. Traefik discovers middleware definitions
**globally** within an instance — same name = same definition. This is
**intentional**: the 200 inflight cap is *shared* across both shield routers,
so a flood that targets one network cannot starve the other.

If you ever need separate caps, rename to `x402-inflight-devnet` /
`x402-inflight-mainnet` in both compose files and update each router's
`middlewares=` chain accordingly.

## Verification

### 1. Traefik dashboard

After `docker compose up -d` (Portainer or direct), the Traefik dashboard
should list 4 middlewares under HTTP → Middlewares with the names above.
Each entry shows the routers using it. Counters for 429 / 413 increment as
the smoke scripts fire.

### 2. Smoke scripts

The 4 scripts under `tools/edge-smoke/` exercise each middleware end-to-end
through the public TLS edge. Run order:

```bash
SHIELD_URL=https://devnet.rpcpriority.com bash tools/edge-smoke/test-security-headers.sh
SHIELD_URL=https://devnet.rpcpriority.com bash tools/edge-smoke/test-bodylimit.sh
SHIELD_URL=https://devnet.rpcpriority.com bash tools/edge-smoke/test-ratelimit.sh
SHIELD_URL=https://devnet.rpcpriority.com bash tools/edge-smoke/test-inflight.sh
```

All four MUST exit `0` before promoting devnet → mainnet.

### 3. Manual curl

Quick header sanity:

```bash
curl -sI https://devnet.rpcpriority.com/health | grep -iE 'strict-transport|content-type-options|referrer|server|powered'
```

Expected: HSTS, nosniff, referrer-policy present; Server / X-Powered-By empty.

Quick rate-limit sanity (30 quick requests should all succeed; 80 should see
some 429):

```bash
for i in $(seq 1 80); do curl -s -o /dev/null -w '%{http_code}\n' https://devnet.rpcpriority.com/health & done | wait | sort -u -c
```

## Adjusting limits at runtime

The 4 middlewares are static labels on the shield service. To change a value:

1. Edit the relevant label in both `docker-compose.devnet.yml` and `docker-compose.mainnet.yml`.
2. `docker compose -f docker-compose.devnet.yml up -d --force-recreate x402-shield-devnet`
3. (Mainnet only) repeat for the mainnet container.

No Shield restart is required because the change is in the Traefik label set,
which Traefik re-discovers on container recreation. The shield's Node process
is unaffected.

## Reverting Phase 1

The 3 commits that introduced this layer are:

```
0a73858  docs(edge-smoke): scaffold shell-based smoke tests for Traefik middlewares
<hash>   edge: add Traefik middleware chain ... to devnet
<hash>   edge: add Traefik middleware chain ... to mainnet
<hash>   edge: add 4 shell smoke tests for Traefik middlewares
```

To roll back:

```bash
git revert --no-edit <mainnet> <devnet> <smoke> <readme>
docker compose -f docker-compose.devnet.yml up -d --force-recreate x402-shield-devnet
docker compose -f docker-compose.mainnet.yml up -d --force-recreate x402-shield-mainnet
```

The shield's Node code is untouched, so reversal is purely a Traefik label
change. No state migration, no agent re-handshake.

## 24-hour soak procedure (devnet → mainnet promotion)

After deploying Phase 1 to **devnet only**, do not promote to mainnet for
24 hours. During the soak:

1. **Smoke loop every 30 minutes** (cron or `while true; do ... ; sleep 1800; done`):
   ```bash
   bash tools/edge-smoke/test-security-headers.sh && \
   bash tools/edge-smoke/test-ratelimit.sh && \
   bash tools/edge-smoke/test-bodylimit.sh
   ```
   Skip `test-inflight.sh` in the soak loop — 250 parallel sockets is too
   noisy as a recurring check. Run it once at hour 0, hour 12, hour 24.

2. **Watch Traefik logs** for unexpected 5xx (Traefik internal errors) or
   sustained 429 / 413 outside the smoke runs:
   ```bash
   docker logs -f traefik 2>&1 | grep -E "5[0-9]{2}|429|413"
   ```
   A few 429 / 413 are expected (the smoke scripts fire them). Sustained
   429 from a single non-test IP is a signal that a real client is being
   throttled — investigate before promoting.

3. **Bench parity check** at hour 0 and hour 24:
   ```bash
   node bench.js --target=https://devnet.rpcpriority.com --requests=1000
   ```
   p99 latency at hour 24 should be within 10% of hour 0 — confirms the
   middleware chain has not introduced drift.

4. **Multi-agent stress** (manual or scripted): start 3 agents with separate
   pubkeys and run `examples/trust-progression.js` against the devnet shield.
   All 3 should complete the trust ramp without hitting 429.

## Pass / fail criteria for promoting to mainnet

| Check | Pass | Fail action |
|---|---|---|
| All 4 smokes green at hour 24 | yes | Investigate failure; do not promote |
| Bench p99 within 10% of pre-deploy | yes | Investigate latency; do not promote |
| Multi-agent trust ramp completes | yes | Investigate sybil/throttle interaction |
| Traefik logs: no sustained non-test 429 | yes | Tune ratelimit upward; re-soak |
| Traefik logs: no 5xx from middleware itself | yes | Open Traefik issue; do not promote |

If all 5 are green, run the same compose change against mainnet:

```bash
docker compose -f docker-compose.mainnet.yml up -d --force-recreate x402-shield-mainnet
```

Run all 4 smokes against `https://api.rpcpriority.com` immediately after.

## Open issues

- **Cumulative inflight cap**: 200 across devnet+mainnet means a devnet
  load test can starve mainnet capacity. Acceptable for v0.2 because
  devnet load is small in practice; if devnet gets noisy, split the
  middleware names per spec note above.
- **No per-middleware metric until Phase 2**: Traefik exposes counters
  via its own dashboard and Prometheus endpoint, but the Shield does not
  yet emit middleware-specific gauges. Phase 4 wires `/metrics` for the
  Shield-side counters; the Traefik metrics are visible separately.
- **Body buffer to disk under flood**: `bodylimit.buffering` will spill
  >16KB bodies to disk before rejection. The container has `read_only: true`
  + `tmpfs:[/tmp]` (Phase 0), so spillage is bounded to the tmpfs. Monitor
  `/tmp` usage on each shield container during the soak.
