# tools/edge-smoke/

Smoke tests for the 4 Traefik middlewares applied to `x402-shield-{devnet,mainnet}`:
`x402-ratelimit`, `x402-inflight`, `x402-bodylimit`, `x402-headers`.

These are **shell scripts**, not Node tests, because Traefik is part of the Docker
deploy (Portainer's daemon, not the Node test harness). The middlewares run
**before** the Node process sees a request — once Traefik rejects, Node never sees
it. To exercise the middleware chain you must hit the public TLS edge.

## Layout

| Script | Validates |
|---|---|
| `test-ratelimit.sh` | 30 req/s sustained, burst 60 → 429 with `Retry-After` |
| `test-bodylimit.sh` | POST > 64KB → 413; ≤ 64KB → 200/402 (passes through) |
| `test-security-headers.sh` | HSTS / X-Frame-Options / Referrer-Policy / Content-Type-Options present; `Server` and `X-Powered-By` empty |
| `test-inflight.sh` | 250 simultaneous long-lived connections → ≤ 200 served immediately, rest queued/rejected |

## Usage

```bash
# Default target (devnet)
SHIELD_URL=https://devnet.rpcpriority.com bash tools/edge-smoke/test-ratelimit.sh

# Mainnet
SHIELD_URL=https://api.rpcpriority.com bash tools/edge-smoke/test-bodylimit.sh

# Dry run (echo what would be sent, do not fire)
bash tools/edge-smoke/test-security-headers.sh --dry-run
```

## Recommended sequence

1. **Dry run first** — `--dry-run` on each script confirms parsing and curl flags
   on a dev machine before pointing at prod.
2. **Hit devnet** — full sequence against `https://devnet.rpcpriority.com`.
3. **Soak** — repeat the sequence every 5 minutes for 1 hour after a deploy
   (cron loop or `watch`); check Traefik dashboard for 429/413 counters.
4. **Hit mainnet** — only after devnet passes a 24h soak per
   `docs/EDGE-MIDDLEWARE-RUNBOOK.md`.

## Dependencies

- `bash` ≥ 4 (Debian/Ubuntu default).
- `curl`.
- `jq` (header parsing in `test-security-headers.sh`).
- `parallel` (GNU parallel) **or** `xargs -P` for `test-inflight.sh` (auto-detected).

## Exit codes

`0` on pass; non-zero with a printed reason on fail. Each script also writes a
short summary to stdout you can grep in CI logs.
