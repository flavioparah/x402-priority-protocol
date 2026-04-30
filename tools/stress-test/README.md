# tools/stress-test/

Multi-agent load test: spawn N ephemeral keypairs, fund their escrows on the Shield, fire M signed RPC calls per agent in parallel, and report aggregate metrics.

## What this validates

| Subsystem | Coverage |
|---|---|
| Atomic-consume primitive | N concurrent signed retries against same shield |
| Trust-Score progression | Each agent independently climbs 0 → 100 |
| Leaderboard | N entries appear, sorted by paidCount |
| Anti-sybil detection | `coordinated_burst` and `cross_provider_velocity` flags trigger expectedly |
| Redis persistence | Counters survive container restart mid-test |
| QoS queue | Bypass / queueing / overflow under sustained load |

## 3-step usage

```bash
# 1. Spawn N agents (default 30, on demo.rpcpriority.com via trusted-deposits — instant, free)
node tools/stress-test/spawn-agents.js
# writes tools/stress-test/agents.json (contains private keys — gitignored)

# 2. Fire requests (default 500/agent, 10 agents in parallel)
node tools/stress-test/run-stress.js
# writes tools/stress-test/stress-results.json

# 3. Report
node tools/stress-test/report.js
# prints summary + writes tools/stress-test/stress-results.csv
```

## Default config

| Param | Default | Where |
|---|---|---|
| Mode | `demo` (uses demo.rpcpriority.com + trusted deposits) | `MODE` env |
| Agents | 30 | `AGENTS` env |
| Requests per agent | 500 | `REQUESTS_PER_AGENT` env |
| Parallel agents | 10 | `PARALLEL_AGENTS` env |
| Funding per agent | 10M µL escrow | `FUND_MICRO_LAMPORTS` env |
| RPC method tested | `getHealth` | `RPC_METHOD` env |

## Mainnet mode (real on-chain funding)

When you want to validate the full on-chain flow on `api.rpcpriority.com`:

```bash
TREASURY_SECRET_KEY=<base58 of treasury 64-byte secret> \
MODE=mainnet \
AGENTS=50 \
PARALLEL=1 \
FUND_LAMPORTS_PER_AGENT=10000 \
node tools/stress-test/spawn-agents.js
```

This does 2-step funding per agent: treasury sends SOL to agent's address, then the agent itself signs a deposit tx to the operator. Slower (2N on-chain confirmations, sequential) but exercises the actual production payment path.

### Mainnet gotchas (learned the hard way — see commit `b949aa7`)

**1. Rent-exempt minimum.** Every Solana account must hold at least
~890_880 lamports or the network rejects transactions involving it.
The treasury must send `FUND_LAMPORTS + 900_000 (rent-exempt buffer) + 5_500 (tx fee)`
per agent — the rent-exempt portion is **stuck** in the ephemeral wallet
forever (~$0.075 per agent at $83/SOL). spawn-agents.js handles this
automatically; you only choose `FUND_LAMPORTS_PER_AGENT` (the amount
actually deposited into escrow).

**2. 429 from upstream RPC.** The Shield calls `getParsedTransaction`
on `api.mainnet-beta.solana.com` to verify each on-chain deposit, and
the public RPC throttles bursts. spawn-agents.js retries the
`/escrow/deposit` POST with 3s/8s/15s backoff. With `PARALLEL>3` you
will hit 429s anyway — keep `PARALLEL=1` (sequential) on mainnet for
robustness.

**3. Sequential is slow but works.** 50 agents × 2 confirmations × ~30s
each = ~25 minutes. Plan accordingly. Use demo mode for fast iteration,
mainnet only when you specifically need the on-chain audit trail.

## Cost estimates

At current SOL price (~$83), with default config (30 agents × 500 req):

| Mode | On-chain cost (treasury) | Off-chain charges (escrow) | Stuck in rent-exempt | Total USD |
|---|---|---|---|---|
| demo | $0 | n/a (trusted deposits) | $0 | **$0** |
| mainnet (5 agents, 200 req — validated) | $0,38 | $0,001 | $0,375 (5×rent) | **$0,39** |
| mainnet (50 agents, 500 req) | ~$3,80 | ~$0,04 | ~$3,75 (50×rent) | **~$3,84** |
| mainnet (100 agents, 2000 req) | ~$7,60 | ~$0,17 | ~$7,50 (100×rent) | **~$7,77** |

The "stuck in rent-exempt" portion is **capital immobilized** in the
ephemeral wallets. To recover, you'd need to close each account
(another N transactions). Cheaper to write off as test cost.

## Validation milestone (2026-04-30)

End-to-end mainnet stress test executed and recorded:
- 5 agents spawned via 2-step on-chain funding (5/5 success)
- 1.000 paid requests fired (200/agent, 555 succeeded, 445 lost to upstream 429)
- Trust-Score progression observed: 0 → 100 in 21 confirmed payments
- Sustained throughput: 3,9 RPS
- Latency: p50=378ms, p95=639ms, p99=701ms
- Volume captured at api.rpcpriority.com: +1.000 payments, +5 unique
  pubkeys, +21,1M µL — all persisted in Redis (will survive restart)
- Full leaderboard visible at https://api.rpcpriority.com/stats/leaderboard

## Output files

```
tools/stress-test/
├── agents.json           agent keys + escrow state (gitignored — contains secrets)
├── stress-results.json   per-request raw outcomes (gitignored if large)
└── stress-results.csv    optional flat export
```

## Recommended sequence for first run

1. **Smoke** — `AGENTS=3 REQUESTS_PER_AGENT=10 node spawn-agents.js && node run-stress.js && node report.js` (validates pipeline in ~10s)
2. **Default** — `node spawn-agents.js && node run-stress.js && node report.js` (30 agents × 500 req, ~5 min)
3. **Heavy** — `AGENTS=100 REQUESTS_PER_AGENT=2000 node spawn-agents.js && node run-stress.js && node report.js` (200k requests, ~30 min)

## Notes

- Agents are **ephemeral by default** — `agents.json` lives only as long as you keep the file. Rerunning `spawn-agents.js` overwrites it.
- The Shield's anti-sybil engine WILL flag this batch as `coordinated_burst` (30+ pubkeys appearing in <24h with same operator). This is **expected and desirable** — it proves detection works.
- Demo mode uses trusted deposits, so the funding doesn't actually move SOL. The escrow is bookkeeping-only on the demo Shield.
