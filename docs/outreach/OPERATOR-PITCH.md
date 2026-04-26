# RPC Priority Protocol — operator pitch

> **One-pager para anexar em emails de outreach a operadores tier 2/3.** Audience: technical decision-makers (CTO, head of infra, founder) at Solana RPC providers. Differente de [`BENEFICIOS.md`](../BENEFICIOS.md) (audience: investidor) e do [`PITCH-SCRIPT-PT.md`](../PITCH-SCRIPT-PT.md) (audience: hackathon judge). Print-friendly em A4.

---

## What you get (operator side)

You add a reverse proxy in front of your existing Solana RPC node. We handle:

- **Per-request micropayment via x402** (the open Coinbase HTTP-payment standard) — agents pay you in SOL, no API key, no whitelist, no contract negotiation.
- **Trust-Score discount engine** — repeat customers get up to 50% off automatically (you keep them sticky); new agents pay full price (your spam defense pays for itself).
- **Cross-operator reputation** — once 2+ operators are on the network, your customers' Trust-Score works at any of us. You attract agents that built reputation elsewhere.
- **Sybil/fraud signals** — derived from cross-operator visibility (`sybilRisk: low|medium|high`, `fraud_flags`, `churn_pattern`). Block bad actors before they hit your spend.
- **Drop-in QoS** — if you want operator-level priority queueing, our `x402-qos-cooperative` spec gives you a clean integration in **~2-3 days** of operator-side work.

## Live, auditable, today

| Proof | Where to test |
|---|---|
| Mainnet on-chain payment validated end-to-end | tx `2fP8DQhy...` finalized at slot 415702360, [Solana Explorer](https://explorer.solana.com/tx/2fP8DQhypL3hj2Wu4jaEfUVLNJmCTV2j8Nn3VJouhAk1donYaJJrm2DWeyDzUriwF2uQfyqMxooLEXFco7rrfpro) |
| Live dashboard with real traffic | https://x402.rpcpriority.com/live |
| 402 challenge in your browser (no install) | https://x402.rpcpriority.com/try |
| Look up any pubkey's reputation | https://x402.rpcpriority.com/explorer |
| Source code (Apache-2.0) | https://github.com/flavioparah/x402-priority-protocol |

## Numbers (measured, not projected)

- **8.7 ms** — protocol overhead at p95 over a plain proxy baseline. Pitch goal was < 50 ms.
- **26.1%** — average savings to a returning agent over 22 sequential requests, score growing 0 → 100. Reproducible: `npm run demo:trust`.
- **50%** — max Trust-Score discount.
- **33/33 tests passing** — atomic concurrency (5/5), sybil/fraud detection (19/19), cooperative QoS integration (9/9).
- **Redis-backed state** with `volatile-lru` policy — escrow / reputation / used signatures are restart-safe and immune to memory-pressure eviction.

## Integration paths

### Option 1 — Reverse proxy (5 min)

You point your DNS or load balancer at our shield container. Shield issues 402 challenges under load, verifies signatures, debits escrow, and forwards verified requests to your RPC node. Zero changes to your Solana validator stack.

```
[Agent] → [x402-shield (you run)] → [your existing Solana RPC node]
              │
              └─→ [Trust-Score broker (we run, neutral)]
```

Effort:
- 1 hr — clone the repo, configure `PAYMENT_DESTINATION` (your wallet)
- 30 min — Docker compose `up -d`, point your DNS
- 30 min — smoke test with `npm run demo:trust`
- **Total: half a day**

### Option 2 — Cooperative QoS (2-3 days, premium tier)

Your RPC stack reads `X-Priority-Score` and `X-QoS-Spec-Version` headers and routes through your own priority-weighted worker pool. Spec at [`docs/QOS-COOPERATIVE-SPEC.md`](../QOS-COOPERATIVE-SPEC.md), reference implementation at [`examples/operator-qos-reference.js`](../../examples/operator-qos-reference.js) (~80 lines).

You get per-tier SLA control, validator-internal scheduling, and the ability to publish a "guaranteed slot" SKU at premium pricing.

## Deal structure

| Pilot (first 90 days) | Production (after pilot) |
|---|---|
| **No fixed fee.** | Pick one of: |
| Revenue share **70/30 in your favor.** | A) **SaaS license** US$ 500–5.000/mo by tier |
| You keep 70% of every 402 cobrança we facilitate. | B) **Revenue share** 5% (no fixed fee) |
| We keep 30% as platform fee. | C) **Trust-Score Premium** add-on (US$ 200/mo) — cross-op reputation data |

**You can opt out of the pilot at any time, no contract minimum.** All we ask: 30 min of your time at the end of the 90 days for a candid post-mortem.

## What we're NOT asking

- 🚫 No equity / token allocation.
- 🚫 No fees during pilot (genuinely 0).
- 🚫 No exclusivity (you can run other RPC pricing models in parallel).
- 🚫 No code on your validator stack (Option 1 path is purely a sidecar).

## Honest limitations

- **Single-broker today.** The Trust-Score broker runs as our service. Federation is in the spec ([RFC v0.1](../TRUST-SCORE-RFC-DRAFT.md) §9) but not yet implemented. Operators worried about lock-in: we can sign a data-portability commitment.
- **Solana-only for now.** Cross-chain (Base, Sui, Aptos via the same Ed25519 keypair) is on the Tier-4 roadmap, ~12-24 months out.
- **No Postgres audit log yet.** Every `/attest` and `/report` ends up in Redis AOF; for SOC 2 we'd add a Postgres mirror. On the post-pilot roadmap.

## Why us, why now

- **Three founders, full-time on this.** João (CTO, ex-software architect), Flávio (CEO, product + GTM), Felipe (DPO, security + compliance).
- **First mover on x402 + RPC layer.** Coinbase published the standard in 2024–2025; nobody else has shipped a Solana-specific implementation with on-chain mainnet validation yet.
- **Built for the Colosseum Frontier Hackathon (Apr–May 2026).** Hackathon submission is the open spec + reference impl; the broker SaaS becomes a separate revenue stream post-hackathon.

## Next step

Reply to the email this is attached to with **one** of:
- *"Tell me more"* — we send a 30-min calendar invite + agenda
- *"Send me the integration guide"* — we send the QoS-COOPERATIVE-SPEC.md PDF + reference impl
- *"Not now"* — we'll check back in 90 days; no follow-up spam

---

**Contact:** Flávio Furtado · flavio@rpcpriority.com · [github.com/flavioparah/x402-priority-protocol](https://github.com/flavioparah/x402-priority-protocol)
