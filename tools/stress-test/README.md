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
node tools/stress-test/spawn-agents.js
```

This does 2-step funding per agent: treasury sends SOL to agent's address, then the agent itself signs a deposit tx to the operator. Slower (2N on-chain confirmations) and costs ~10k lamports per agent in tx fees, but exercises the actual production payment path.

## Cost estimates

At current SOL price (~$83), with default config (30 agents × 500 req):

| Mode | On-chain cost | Off-chain charges (escrow) | Total USD |
|---|---|---|---|
| demo | $0 | n/a (trusted deposits) | **$0** |
| mainnet | ~150k lamports (50 tx fees + funding) | ~225M µL (paid requests) | **~$0,80** |

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
