# Cold outreach email templates

> 3 variants × 2 languages (EN / PT). Pick by operator profile. Each ≤ 150 words. Attach [`OPERATOR-PITCH.md`](./OPERATOR-PITCH.md) as PDF (or link to GitHub). Track in [`TRACKER.md`](./TRACKER.md).

**Universal rules:**
- Subject ≤ 60 chars, mentions their company name
- First sentence proves we know them (1 specific reference)
- Hook in first paragraph: a number or a public URL they can click
- 1 ask, never 2
- No follow-ups before 7 days; max 2 follow-ups, then drop
- If opening rate < 30%, the subjects are bad — iterate
- Send between Tue 9am and Thu 4pm in their timezone

---

## Variant A — Tier-2 commercial RPC provider

**When to use:** Syndica, Chainstack, Ankr, DRPC, GetBlock, Blockdaemon, BlockPI, NodeReal, Tatum, Lava — operators who already sell RPC by API key + monthly plan.

**Hook:** spam → revenue, retention via Trust-Score.

### EN

**Subject:** {COMPANY} + per-request RPC monetization on Solana

> Hi {NAME},
>
> Saw your team launched {SPECIFIC_THING — e.g., "the new Solana endpoint" / "tier-2 plan last quarter"} — we built something that plugs into it cleanly.
>
> **TL;DR:** a sidecar that turns Solana RPC spam into per-request revenue using the open x402 standard from Coinbase. Agents pay you in SOL per call; loyal agents get up to 50% off automatically (Trust-Score). No API keys, no whitelist, no contract negotiation.
>
> Live + auditable: <https://x402.rpcpriority.com/live>. Real mainnet tx: <https://explorer.solana.com/tx/2fP8DQhypL3hj2Wu4jaEfUVLNJmCTV2j8Nn3VJouhAk1donYaJJrm2DWeyDzUriwF2uQfyqMxooLEXFco7rrfpro>. Open source (Apache-2.0).
>
> **First 90 days are free** — revenue share 70/30 in your favor, no fixed fee, you can drop out anytime.
>
> 30 min next week to show how it integrates? I'm Flavio, CEO.
>
> — Flavio

### PT

**Assunto:** {COMPANY} + monetização por requisição em RPC Solana

> Olá {NAME},
>
> Vi que o time {SOMETHING_SPECIFIC — ex: "lançou endpoint Solana semestre passado" / "tem plano tier-2 ativo"} — construímos algo que encaixa direto no stack de vocês.
>
> **TL;DR:** um sidecar que transforma spam em RPC Solana em receita por requisição usando o padrão aberto x402 da Coinbase. Agentes pagam vocês em SOL por chamada; cliente fiel ganha até 50% de desconto automático (Trust-Score). Sem API key, sem whitelist, sem negociar contrato.
>
> Ao vivo e auditável: <https://x402.rpcpriority.com/live>. Tx real em mainnet: <https://explorer.solana.com/tx/2fP8DQhypL3hj2Wu4jaEfUVLNJmCTV2j8Nn3VJouhAk1donYaJJrm2DWeyDzUriwF2uQfyqMxooLEXFco7rrfpro>. Open source (Apache-2.0).
>
> **Primeiros 90 dias zero fee** — revenue share 70/30 a favor de vocês, sem licença fixa, podem sair a qualquer momento.
>
> 30 min na próxima semana pra mostrar a integração? Sou o Flavio, CEO.
>
> — Flavio

---

## Variant B — Solana validator with RPC sideline

**When to use:** Marinade Finance (validators + RPC), Helius's competitors that also stake (P2P, Figment, Stakefish), Stake DAO, Jito's adjacent operators. Smaller in-house RPC ops attached to a validator business.

**Hook:** RPC differentiation = competitive moat for staking.

### EN

**Subject:** Differentiate your Solana RPC for searchers — without an API-key tier

> Hi {NAME},
>
> Quick note: {THEIR_VALIDATOR}'s RPC tier is one of the few that {SPECIFIC_THING — e.g., "doesn't gate getProgramAccounts" / "publishes p99 latency"}. That's exactly the audience we built for.
>
> **The problem with API keys for searchers:** they don't work. Searchers rotate infra, can't sign monthly contracts, and your spam protection punishes the legitimate ones.
>
> We give you a per-request pricing layer (x402 standard, Coinbase-published) where searchers pay in SOL per call and earn discounts via cross-operator Trust-Score. **They can't game it** — sybil/fraud signals are derived cross-operator, single-op spam attacks lose money for the attacker.
>
> Live: <https://x402.rpcpriority.com/live>. Spec: <https://github.com/flavioparah/x402-priority-protocol>.
>
> **90-day free pilot, 70/30 revenue share in your favor, no contract.**
>
> 30 min to walk through the integration? I'm Flavio, CEO.
>
> — Flavio

### PT

**Assunto:** Diferencie seu RPC Solana pra searchers — sem precisar criar plano API-key

> Olá {NAME},
>
> Mensagem rápida: o RPC da {THEIR_VALIDATOR} é um dos poucos que {SOMETHING_SPECIFIC — ex: "não gateia getProgramAccounts" / "publica p99 honesto"}. É exatamente esse público que estamos atacando.
>
> **O problema de API key pra searcher:** não funciona. Searcher rotaciona infra, não assina contrato mensal, e seu antispam pune os legítimos.
>
> A gente entrega uma camada de pricing por requisição (padrão x402 da Coinbase) onde o searcher paga em SOL por chamada e ganha desconto via Trust-Score cross-operador. **Não dá pra burlar** — sinais de sybil/fraude vêm da visão multi-operador, ataque single-op só faz o atacante perder dinheiro.
>
> Ao vivo: <https://x402.rpcpriority.com/live>. Spec: <https://github.com/flavioparah/x402-priority-protocol>.
>
> **Piloto 90 dias zero fee, 70/30 a favor de vocês, sem contrato.**
>
> 30 min pra rodar a integração junto? Sou o Flavio, CEO.
>
> — Flavio

---

## Variant C — In-house DeFi protocol RPC

**When to use:** Drift, MarginFi, Solend/Save, Mango, Phoenix, Marinade — protocols that run their own RPC for their dApp users. Different value-prop: not selling RPC to outside customers, but **using Trust-Score as a layer-2 anti-abuse signal**.

**Hook:** behavior-derived sybil signal for your liquidator/searcher pool.

### EN

**Subject:** Behavioral sybil signal for {PROTOCOL}'s liquidator pool

> Hi {NAME},
>
> Different angle than usual outreach: we're not pitching you a paid RPC.
>
> {PROTOCOL} has the same problem every DeFi protocol has — your liquidator and arbitrageur pool includes a long tail of suspicious sybils that bid on every opportunity but never settle. You can't tell them apart from legitimate ones with on-chain data alone.
>
> We just shipped a behavioral reputation layer for Solana pubkeys called Trust-Score. It's an x402 sidecar today, but the **`/reputation/<pubkey>` endpoint is publicly readable** (no payment required). Returns: `sybil_risk`, `fraud_flags`, `churn_pattern`, `paid_count` across multiple operators (when 2+ join the network).
>
> Could be a free signal for your bot allowlist before {PROTOCOL} even commits to the full integration.
>
> Try it: <https://x402.rpcpriority.com/explorer> — paste any pubkey.
>
> 20 min to see if there's a fit?
>
> — Flavio (CEO)

### PT

**Assunto:** Sinal comportamental de sybil pro pool de liquidadores da {PROTOCOL}

> Olá {NAME},
>
> Outreach diferente do usual: não estou pitchando RPC pago pra vocês.
>
> {PROTOCOL} tem o mesmo problema de toda DeFi — o pool de liquidadores e arbitradores inclui uma cauda longa de sybils suspeitos que dão lance em toda oportunidade mas nunca settlam. Não dá pra separar deles dos legítimos só com dado on-chain.
>
> Acabamos de shippar uma camada de reputação comportamental pra pubkeys Solana — o Trust-Score. É um sidecar x402 hoje, mas o **endpoint `/reputation/<pubkey>` é leitura pública** (sem pagamento). Retorna: `sybil_risk`, `fraud_flags`, `churn_pattern`, `paid_count` cross-operador (quando 2+ operadores entrarem na rede).
>
> Pode virar sinal grátis pro allowlist de bots de vocês antes mesmo da {PROTOCOL} se comprometer com a integração completa.
>
> Testa: <https://x402.rpcpriority.com/explorer> — cola qualquer pubkey.
>
> 20 min pra ver se faz sentido?
>
> — Flavio (CEO)

---

## Follow-up cadence

| Day | Action | Template (≤ 50 words) |
|---|---|---|
| 0 | Initial email (above) | — |
| +7 | Bump 1 — same thread | "Hi {NAME}, just checking — did the email below land? Happy to send a 5-min Loom walkthrough if a meeting's too much. — Flavio" |
| +21 | Bump 2 — same thread | "Last bump from me, {NAME}. We're at 5/15 operators in pilot conversation; happy to revisit in 90d if now isn't right. — Flavio" |
| +90 | Re-engage if context changed | New thread, mention what changed since last touch (e.g., "we now have N operators integrated; thought you might want to revisit") |

After the second bump with no reply, mark as `cold` in the tracker and don't email again unless something material changes (we close another tier-2, hit a milestone like federation, etc.).

---

## Subject line A/B options

If first batch has < 30% open rate, swap to these:

| Variant A — commercial RPC | Variant B — validator | Variant C — in-house DeFi |
|---|---|---|
| {COMPANY} + per-request Solana RPC | {COMPANY}'s RPC + searcher pricing | Free sybil signal for {PROTOCOL}'s liquidators |
| Turn {COMPANY}'s spam into revenue (x402 + Solana) | Premium RPC tier without an API-key plan | Reputation oracle for Solana pubkeys |
| Q: how does {COMPANY} price MEV searchers today? | {COMPANY}'s p99 + per-request payment | {PROTOCOL} bot allowlist signal (no integration needed) |

Track which subject correlates with replies in the tracker.

---

## Personalization checklist (before sending)

- [ ] Replaced `{COMPANY}` / `{NAME}` / `{SPECIFIC_THING}` / `{PROTOCOL}` placeholders
- [ ] Specific reference is real and recent (< 60 days) — not a generic "I see you do X"
- [ ] Live URL works (curl test before send)
- [ ] Mainnet tx link still resolves on Solana Explorer
- [ ] Time-zone of recipient confirmed; sending Tue–Thu 9am–4pm local
- [ ] Tracker row created with `Stage: 1-emailed`, `Date sent`, `Owner`
