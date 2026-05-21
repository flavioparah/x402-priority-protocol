# Operator Quickstart — x402-shield

> **For:** RPC operators (small validators, tier-2 providers, dev-on-VPS) integrating x402-shield in front of an existing Solana RPC node.
> **Time to first paid request:** ~30 minutes from clone to verifying a 402 → payment → 200 in mainnet.
> **Companion:** [`docs/AGENT-QUICKSTART.md`](./AGENT-QUICKSTART.md) for the agent side.

---

## 1. Who this is for

You run (or want to run) a Solana RPC endpoint and want a programmable way to monetize priority under load, defend against agentic abuse, and build portable per-agent reputation — without rewriting your existing node.

x402-shield is a reverse proxy you put **in front of** an existing Solana JSON-RPC node. It is not a replacement RPC.

## 2. Prerequisites

- **Node.js 18+** (LTS recommended — the runtime uses native `fetch` and modern Express).
- **Redis 6+** for production (escrow, nonces, reputation, used-deposit signatures persist here). In-memory mode works for local dev but resets on restart.
- **A Solana wallet (pubkey + secret kept offline)** that will receive priority payments. The Shield only needs the *pubkey* as `PAYMENT_DESTINATION` — the secret never touches the server.
- **An upstream Solana RPC URL** the Shield will proxy to (your own validator, Helius, Triton, QuickNode, or `https://api.mainnet-beta.solana.com` for dev).
- **A public hostname + TLS termination** (Traefik, Caddy, nginx) if exposing publicly. See `docs/DEPLOY.md` for the reference Traefik + Let's Encrypt pattern.

## 3. Install + Configure

```bash
git clone https://github.com/flavioparah/x402-priority-protocol.git x402
cd x402
npm install
cp .env.example .env
$EDITOR .env
```

Configuration is split in three tiers. The **minimal block matches `.env.example` exactly** — that's all you need to boot. The production + advanced blocks are recommended additions for serious deployments. See the [Configuration table in `README.md`](../README.md#configuration) for the full list.

### Minimal local config (matches `.env.example`)

- `PAYMENT_DESTINATION` — Solana wallet that receives x402 payments
- `REAL_RPC_URL` — upstream Solana RPC (defaults to mainnet-beta)
- `RPC_LOAD_THRESHOLD` — when `/rpc` load exceeds this, the 402 path fires
- `REQUESTS_PER_IP_LIMIT` — per-IP rate limit ceiling
- `RATE_WINDOW_MS` — sliding-window duration in ms
- `BASE_PRICE` — minimum µ-lamports charged per priority request
- `MAX_PRICE` — maximum µ-lamports under saturation

> Env-var naming note: the README and `.env.example` use `BASE_PRICE` / `MAX_PRICE` (the env-var names). Internally these map to `BASE_PRICE_MICRO_LAMPORTS` / `MAX_PRICE_MICRO_LAMPORTS` (the unit). Both refer to the same setting.

### Production config (recommended additions)

- `REDIS_URL` — required for multi-instance state durability
- `REDIS_REQUIRED=1` — fail-fast on Redis disconnect instead of in-memory fallback (auto-enables when `REAL_RPC_URL` contains `mainnet-beta`)
- `OPERATOR_ID` — your operator slug; used for cross-op attestations when broker is wired (defaults to `"self"`)
- `MAX_RPS` — global throughput ceiling
- `SOLANA_RPC_URL` — overrides `REAL_RPC_URL` if both set (used to verify on-chain deposits via `getParsedTransaction`)

### Advanced QoS config

- `QOS_BYPASS_THRESHOLD` — load below which the priority queue is bypassed entirely
- `QOS_MAX_QUEUE_DEPTH` — max queued requests before reject-overflow
- `QOS_QUEUE_TIMEOUT_MS` — max wait time in queue before reject-timeout

## 4. Run locally

```bash
npm start
# or with auto-reload during development:
npm run dev
```

Verify in a second terminal:

```bash
curl -s http://localhost:3000/health | jq
# { "status": "ok", "load": "0.00", "threshold": 0.75, "nonces_active": 0, "store_backend": "redis" }

curl -s http://localhost:3000/info | jq
# { "operator_pubkey": "<your pubkey>", "network": "mainnet"|"devnet"|"unknown",
#   "base_price_micro_lamports": 20000, "max_price_micro_lamports": 1000000, ... }
```

Force a 402 challenge without generating synthetic load:

```bash
RPC_LOAD_FORCE=1 npm start
# then, in another shell:
curl -i -X POST http://localhost:3000/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'
```

Expected response headers:

```
HTTP/1.1 402 Payment Required
X-x402-Payment-Destination: <your pubkey>
X-x402-Amount: 20000
X-x402-Nonce: a1b2c3d4...
X-x402-Nonce-TTL: 30
```

## 5. Deploy to production

The reference deployment is **Traefik + Let's Encrypt on a kvm4 VPS**, fully documented in [`docs/DEPLOY.md`](./DEPLOY.md). It covers:

- `docker compose up -d --build` for the mainnet shield, with `docker-compose.yml`
- Side-by-side devnet shield (`docker-compose.devnet.yml`)
- Recreation gotcha for bind-mounted nginx configs (inode replacement on `git pull`)
- Mitigation for public mainnet-beta RPC 429s on burst deposit verification
- Phase 1 edge middlewares (Traefik rate-limit / inflight cap / body-limit / security headers) — see [`docs/EDGE-MIDDLEWARE-RUNBOOK.md`](./EDGE-MIDDLEWARE-RUNBOOK.md)

**Minimum bare-VPS spec** that fits the reference deployment (Docker + Node + Redis sidecar, single shield serving devnet + mainnet behind Traefik): **1 vCPU, 4 GB RAM**, ~20 GB SSD, ~US$20/mo at Hetzner / Contabo / DigitalOcean. The reference VPS (kvm4) runs both the mainnet + devnet shield plus the static landing page on this footprint.

For Phase 4 (admin HMAC, hot-reload config, mass-ban guard, audit log), see [`docs/AGENT-OPERATOR-RUNBOOK.md`](./AGENT-OPERATOR-RUNBOOK.md).

## 6. Verify it's working

Once deployed, these calls should all succeed without auth:

```bash
# Gateway metadata — used by clients to estimate prices
curl -s https://your-shield.example.com/info | jq
# {
#   "operator_pubkey": "<your pubkey>",
#   "network": "mainnet",
#   "upstream_rpc": "https://api.mainnet-beta.solana.com",
#   "base_price_micro_lamports": 20000,
#   "max_price_micro_lamports": 1000000,
#   "threshold": 0.75,
#   "nonce_ttl_seconds": 30,
#   "trusted_deposits_enabled": false
# }

# Reputation lookup for any pubkey (returns zeros for unknown agents)
curl -s https://your-shield.example.com/reputation/<base58_pubkey> | jq

# QoS queue + dispatcher stats
curl -s https://your-shield.example.com/stats/qos | jq

# Live dashboard (HTML) — open in a browser:
#   Linux / macOS:  open https://your-shield.example.com/live
#   Windows:        start https://your-shield.example.com/live
```

Trigger the 402 path end-to-end:

```bash
curl -i -X POST https://your-shield.example.com/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'
# Expect 200 (load below threshold) or 402 with the X-x402-* headers.
```

For the full handshake against your deployed Shield, point the bundled demo at it:

```bash
SHIELD_URL=https://your-shield.example.com node demo.js
```

## 7. Monitor + observability

| Endpoint / signal | Purpose |
|---|---|
| `GET /health` | Liveness + current load + sliding-window RPS + active nonce count + store backend |
| `GET /metrics` | Prometheus scrape. Key gauges: `x402_store_healthy`, `x402_requests_total{route,outcome}`, `x402_admin_actions_total{action,outcome}`, `x402_rate_limit_hits_total{dimension}` |
| `GET /stats/qos` | Priority queue depth, in-flight count, dispatched count, bypass threshold |
| `GET /stats/recent` | Recent payments + challenges (for the live dashboard) |
| pino structured logs (stdout) | JSON log lines with `request_id`, `route`, `outcome`, `pubkey`, `amount`, etc. Pipe through `pino-pretty` in dev. |

Alert conditions worth setting up early:

- `x402_store_healthy == 0` for ≥ 30 s → Redis is down. See §7 of [`docs/AGENT-OPERATOR-RUNBOOK.md`](./AGENT-OPERATOR-RUNBOOK.md) for the fail-closed matrix and escalation ladder.
- `/health` returns `load_forced: true` in mainnet → `RPC_LOAD_FORCE` env var was left on after a demo.
- Spike in `x402_rate_limit_hits_total{dimension="ip"}` → coordinated burst from a single source; cross-reference with `/admin/abuse-log`.

## 8. What do I earn? (operator economics)

x402-shield does not promise revenue numbers — it gives you the **knobs** that set the curve. The math:

```
daily_revenue_lamports = RPS × 86400 × avg_price_lamports × paid_fraction
daily_revenue_SOL      = daily_revenue_lamports / 1_000_000_000
```

Where:

- `RPS` is **paid** requests per second (not total RPS — only gated traffic above `RPC_LOAD_THRESHOLD` triggers 402s).
- `avg_price_lamports` is somewhere between `BASE_PRICE / 1000` (= 20 lamports default) and `MAX_PRICE / 1000` (= 1000 lamports default). At sustained moderate overload, expect roughly the midpoint (~510 lamports = `0.00000051 SOL`). At full saturation, the ceiling. Below `THRESHOLD`, zero — gating doesn't fire.
- `paid_fraction` is the share of gated requests where the agent actually pays (vs. drops the call). The Trust-Score discount means loyal agents pay less per request but pay more often.

Plug your own numbers in. Examples at the default `BASE_PRICE=20000` / `MAX_PRICE=1000000`:

```
10 RPS × 86400 × 510 lamports × 1.0 paid_fraction
  = 440_640_000 lamports/day
  = 0.4406 SOL/day
```

Convert SOL to USD using the current market price; the example is illustrative only.

The framing the protocol is designed around: **spam defense becomes revenue**. An attacker forced to pay 50 lamports per request spends faster than they can attack — abuse becomes economically self-limiting, and the operator captures the cost. See `README.md` "Aligned Incentives" and `docs/rfc/x402-priority.md` §9.6.

Three knobs to tune for your hardware:

| Knob | Effect |
|---|---|
| `MAX_RPS` | What req/s = "100% load" for the sliding-window metric. Lower = gating kicks in earlier. |
| `RPC_LOAD_THRESHOLD` | Fraction of `MAX_RPS` above which 402 fires. `0.75` default = ~38 RPS triggers gating at default `MAX_RPS=50`. |
| `BASE_PRICE` / `MAX_PRICE` | The floor and ceiling of the price curve. Raising the floor monetizes light overload; raising the ceiling captures more value under saturation but discourages low-margin agents. |

## 9. Troubleshooting

| Symptom | Likely cause + fix |
|---|---|
| **No 402 ever fires, even under load** | `RPC_LOAD_THRESHOLD` too high, or `MAX_RPS` too high. Confirm with `curl /health` — `load` should be > `threshold` for gating to activate. For demos, set `RPC_LOAD_FORCE=1`. |
| **`/health` reports `load_forced: true`** | You are in demo mode and should remove `RPC_LOAD_FORCE` before production traffic — every request will be gated regardless of real load. |
| **Shield boots but logs `REDIS_URL set but Redis is unhealthy`** | Redis host unreachable. Check `REDIS_URL` and that the Redis container/service is up. On mainnet, `REDIS_REQUIRED=true` is the default — boot will refuse. Set `REDIS_REQUIRED=false` to allow memory-fallback (single-instance only). |
| **`POST /escrow/deposit` returns 503 / 400 with "RPC error fetching transaction: 429"** | Public mainnet-beta throttles concurrent `getParsedTransaction` calls. Either retry client-side with backoff (3 s / 8 s / 15 s) or switch `SOLANA_RPC_URL` to a private RPC (Helius, Triton, QuickNode). See `docs/DEPLOY.md` "Public mainnet-beta RPC throttles bursts". |
| **`POST /escrow/deposit` returns "deposit-amount-mismatch" or "deposit-signature-invalid"** | The on-chain tx doesn't match: wrong destination (not `PAYMENT_DESTINATION`), wrong sender pubkey, or signature already consumed (anti-replay). Each `tx_signature` is single-use. |
| **402 fires but signed retry is rejected with "nonce_already_used"** | The nonce was consumed by a parallel request (atomic consume protects against double-spend). Issue a fresh request, get a new nonce, sign that. |
| **402 fires but signed retry rejected with "pubkey_hint_mismatch"** | Client sent `X-x402-Agent-Pubkey` on the initial request but signed the retry with a different keypair. The nonce binds to the hinted pubkey. Sign with the same key, or omit the hint. |
| **`x402_store_healthy 0` in metrics** | Redis connection lost. See §7 of `docs/AGENT-OPERATOR-RUNBOOK.md` for the fail-closed matrix (deposits 503, admin writes 503, `/rpc` degrades to in-memory rate limit). |
| **HTTP 503 from `/rpc` with `qos_overflow`** | Queue depth exceeded `QOS_MAX_QUEUE_DEPTH` (default 1000). Either raise the limit or scale horizontally — multi-instance QoS coordination via shared Redis ZSET is on the roadmap (see README "Pending"). |
| **HTTP 504 from `/rpc`** | Per-request queue wait > `QOS_QUEUE_TIMEOUT_MS` (default 10 000). Upstream RPC is slow; investigate upstream node health. |

## 10. Support

- **GitHub issues:** https://github.com/flavioparah/x402-priority-protocol/issues — bug reports, feature requests, RFC comments (the wire protocol is open for comment at `docs/rfc/x402-priority.md` until 2026-06-30).
- **Security disclosures:** see `SECURITY.md` in the repo root (added in a sibling PR). Do **not** file security issues in public GitHub issues — follow the disclosure process documented there.
- **Operator-runbook deep-dive:** [`docs/AGENT-OPERATOR-RUNBOOK.md`](./AGENT-OPERATOR-RUNBOOK.md) covers admin HMAC, key rotation, mass-ban guard, hot-reload config, ENFORCEMENT_TIER_MAX promotion, Redis-down handling, and removing `RPC_LOAD_FORCE` from mainnet.
- **Outreach + community:** [`docs/outreach/`](./outreach/) — operator pitch, email templates, demo-call playbook.
