# x402-trust-score — Specification v0.2 (DRAFT)

> **Status:** Draft v0.2 (2026-05-15). Maintainer: João Romeiro (CTO, RPC Priority Protocol).
> Companion specs: [`x402-priority`](./x402-priority.md) (wire-level 402 challenge), [`x402-qos-cooperative`](./x402-qos-cooperative.md) (operator-side priority queueing).
> Reference broker implementation: this repository's [`index.js`](../../index.js) (in-memory, single-broker MVP; see Section 11 for production deployment notes).
> Open to comments at <https://github.com/flavioparah/x402-priority-protocol/issues> until 2026-06-30.

## Abstract

This document specifies the `x402-trust-score` subprotocol, a reputation layer that complements the x402 HTTP payment standard for distributed service-pricing markets. Trust-Score allows providers, such as RPC node operators, to apply data-driven discounts to known clients, such as AI agents identified by an Ed25519 keypair, without coordinating directly with each other. A neutral broker holds the cross-provider reputation so the network can recognize repeat behavior without collapsing into operator-specific silos.

## 1. Motivation

Machine-to-machine markets break down when every request looks anonymous. API keys solve authentication, but they do not solve memory: a provider cannot easily tell whether a paying agent is a first-time buyer, a loyal customer, or a suspicious pattern that should be throttled. In Solana RPC markets this gets worse because operators compete, pricing is dynamic, and the same agent may transact across multiple providers within a short period. A neutral reputation layer creates continuity across providers while preserving operator independence. The broker is necessary because no single operator can safely hold the full cross-network picture without creating a conflict of interest. Trust-Score turns repeated payments into a portable signal that can improve pricing, detection of abuse, and eventual access to better service tiers.

## 2. Architecture

```text
┌──────────┐     /reputation/:pk     ┌───────────────────┐
│ Provider │ ─────────────────────▶  │  Trust-Score      │
│ A        │ ◀───── ReputationRecord │  Broker           │
└──────────┘                         │  (neutral,        │
                                     │   non-provider)   │
┌──────────┐         /attest         │                   │
│ Provider │ ─────────────────────▶  │  Aggregates:      │
│ B        │                         │   - per-pubkey    │
└──────────┘                         │   - per-provider  │
                                     │   - global        │
┌──────────┐         /report         │                   │
│ Provider │ ─────────────────────▶  │  Detects:         │
│ C        │                         │   - sybil rings   │
└──────────┘                         │   - fraud sprees  │
                                     │   - churn shop    │
                                     └───────────────────┘
```

The agent pays the provider through x402. The provider emits attestations about successful payments and suspicious behavior. The broker aggregates those attestations into a global score and abuse signals, then returns a public reputation record to any provider that wants to quote a discount or enforce a policy. Providers remain in control of final pricing; the broker only supplies the signal.

**The broker is necessary because no single provider can hold cross-provider data without conflict of interest.** The closest real-world analogues:

| Domain | Neutral broker | Why it works |
|---|---|---|
| Card payments | Visa / Mastercard | Banks won't share customer data with each other directly, but trust a non-bank to aggregate |
| Open banking | Plaid | Apps can't ask each bank for credentials; Plaid normalizes |
| Consumer credit | Equifax / Experian | Lenders share with the bureau, not each other |
| Securities settlement | DTCC | Brokers settle through a clearinghouse |
| **Agent reputation** | **x402-trust-score broker** | Operators won't share with competitors, but trust a neutral aggregator |

A federation of cooperating brokers MAY exist (Section 9); the protocol is broker-agnostic at the wire level.

## 3. Data Model

```typescript
interface ReputationRecord {
  // Identity
  pubkey: string;                       // base58, Ed25519 public key (Solana convention)

  // Aggregates across all participating providers
  global_trust_score: number;           // 0-100 normalized
  paid_count_total: number;             // number of paid challenges, all providers
  total_paid_micro_lamports: number;    // sum of paid amounts, µL
  first_seen_at: number;                // unix ms (earliest attestation)
  last_seen_at: number;                 // unix ms (most recent attestation)
  active_in_n_providers: number;        // distinct providers that attested
  loyalty_concentration: number;        // [0,1] — fraction of paid_count from top provider

  // Per-provider breakdown (providers MAY mark some entries private)
  per_provider: {
    [provider_id: string]: {
      score: number;                    // 0-100, provider-local
      paid_count: number;
      total_paid_micro_lamports: number;
      first_seen_at: number;
      last_seen_at: number;
    };
  };

  // Abuse signals (broker-computed, not provider-supplied)
  fraud_flags: string[];                // e.g. ["spam_burst_2026-04-12", "duplicate_signature"]
  sybil_risk: "low" | "medium" | "high";
  churn_pattern: "stable" | "shopping" | "ephemeral";
}
```

### Field Semantics

- **`global_trust_score`** is the value providers apply discounts against. Computed by the broker per §5.1; intentionally decoupled from provider `weight(p)` (§5.2).
- **`active_in_n_providers`** is the cross-provider visibility — the network-effect proof. SHOULD be hidden when `<2` to preserve provider privacy.
- **`loyalty_concentration`** measures whether the agent is "loyal to one provider" (≈1.0) or "spreading across many" (≈1/N). Used by providers to differentiate "anchor customer" from "price shopper".
- **`sybil_risk`** is computed by the broker from cross-provider velocity (Section 10).
- **`churn_pattern`** is `stable` (consistent provider), `shopping` (rotates among 3+ providers within a week), or `ephemeral` (active <7 days then silent).

`global_trust_score` is intentionally compact — a ranking signal, not a full behavioral dossier. `fraud_flags` and `sybil_risk` are the defensive layer that lets providers respond to abuse without sharing raw customer logs across competing providers.

## 4. HTTP API

### 4.1 GET /reputation/:pubkey

Returns a `ReputationRecord`. Public read.

### 4.2 POST /attest

Provider reports a successful payment. Authenticates with the provider's pre-registered Ed25519 keypair.

```json
{
  "pubkey": "G8KyXw...Y6pG",
  "amount_micro_lamports": 40200,
  "tx_signature": "2fP8DQhy...",
  "provider_id": "helius-tier1",
  "timestamp": 1714065432000,
  "provider_signature": "<bs58 sig of canonical body>"
}
```

`provider_signature` MUST be produced by the provider's authorized key over a canonical serialization of the body (RFC 8785 JSON Canonicalization recommended). The broker MUST verify the signature before accepting the attestation. Attestations including `tx_signature` are idempotent on that signature (anti-double-attest). Untyped attestations are accepted within a 5-minute clock-skew window from `timestamp`.

Returns `200 OK` with the updated `ReputationRecord` for the pubkey.

### 4.3 POST /report

Provider flags suspicious behavior. Same authentication as `/attest`.

```json
{
  "pubkey": "G8KyXw...Y6pG",
  "provider_id": "helius-tier1",
  "category": "spam_burst",
  "evidence": "<freeform string, max 1KB>",
  "timestamp": 1714065432000,
  "provider_signature": "<bs58 sig>"
}
```

`category` MUST be one of: `spam_burst`, `duplicate_signature`, `wash_payment`, `payment_dispute`, `refund_abuse`, `other`. Reports are weighted by provider credibility and deduplicated by `(pubkey, category, provider_id)` within a 24-hour window. Three or more independent provider reports of the same category trigger `fraud_flags` and MAY downgrade `global_trust_score` per broker policy.

### 4.4 GET /info

Returns broker metadata: supported spec version(s), federation peers (if any), provider registration policy, **score component status (§5.1.3)**, **provider weight policy parameters (§5.2.3)**, and the broker-published discount formula. Used by clients to estimate prices ahead of time and by providers to verify protocol compatibility.

## 5. Score & Discount

### 5.1 Agent Score Calculation (broker)

The broker computes `global_trust_score(pubkey)` from five normalized subscores and a network-effect multiplier. All subscores are scaled to 0-100 *before* weighting, so the published weights correspond to their actual contribution to the final score.

#### 5.1.1 Subscores

```text
P1 = min(100, log10(1 + paid_count_total) * 20)                                   // persistence: volume, log-scaled
P2 = min(100, sqrt(months_in_network) * 12)                                       // persistence: tenure
D2 = (1 - loyalty_concentration) * 100                                            // distribution across providers
H1 = ((paid_count_total - disputes + 1) / (paid_count_total + 2)) * 100           // hygiene: Laplace-smoothed no-dispute ratio
R1 = exp(-idle_days / 60) * 100                                                   // recency: 60-day half-life decay
```

H1 uses **add-one (Laplace) smoothing** so a new pubkey with zero observed disputes does not begin at 100. A pubkey with 5 paid challenges and 0 disputes scores H1 ≈ 85.7; convergence to 100 requires sustained volume without disputes. This prevents zero-history agents from inheriting a perfect hygiene score from absence of evidence.

H2 is a binary gate (not a weighted subscore): `H2 = 0` if any active `fraud_flag` is present per Section 10; otherwise `H2 = 1`.

#### 5.1.2 Weighted aggregation

Default weights (all subscores already on the 0-100 scale):

| Subscore | Weight | Notes |
|---|---|---|
| P1 (paid_count, log) | 0.30 | |
| P2 (tenure) | 0.15 | |
| D2 (distribution) | 0.10 | |
| H1 (no-dispute ratio) | 0.20 | Requires `/report`. Inactive in deployments without `/report` — see §5.1.3. |
| R1 (recency) | 0.25 | |

```text
raw = 0.30*P1 + 0.15*P2 + 0.10*D2 + 0.20*H1 + 0.25*R1
```

#### 5.1.3 Conditional renormalization for inactive subscores

When a subscore depends on infrastructure not yet deployed by a given broker (most notably H1, which requires `/report`), the broker MUST renormalize the remaining weights to sum to 1.0 rather than silently treating the missing subscore as zero. Silent-zero would lower the headline ceiling without lowering the published weights — an auditability footgun.

```text
// Phase 1 example: H1 inactive
raw_phase1 = (0.30*P1 + 0.15*P2 + 0.10*D2 + 0.25*R1) / 0.80
```

Brokers MUST expose per-subscore status in `GET /info`:

```json
{
  "score_components": [
    {"id": "P1", "weight": 0.30, "status": "active"},
    {"id": "P2", "weight": 0.15, "status": "active"},
    {"id": "D2", "weight": 0.10, "status": "active"},
    {"id": "H1", "weight": 0.20, "status": "inactive_until_report_v1"},
    {"id": "R1", "weight": 0.25, "status": "active"}
  ],
  "normalization": "renormalize_remaining_to_one"
}
```

Status values are free-form strings of the form `inactive_until_<feature>`; clients SHOULD treat any value other than `"active"` as inactive and recompute the effective weights accordingly.

#### 5.1.4 Cross-provider bonus and final score

```text
cross_provider_bonus = min(1.5, 1 + 0.1 * (active_in_n_providers - 1))
global_trust_score   = H2 * min(100, raw * cross_provider_bonus)
```

`cross_provider_bonus` counts distinct providers **binarily** — a small operator contributes the same +0.1 increment as a large operator. **This is the structural mechanism that gives small operators network leverage:** their presence increments `active_in_n_providers` by 1 regardless of their attested volume.

A pubkey with `raw = 60` and `active_in_n_providers = 3` reaches `60 * 1.2 = 72`; with `N = 5`, it reaches `60 * 1.4 = 84`. The multiplier saturates at 1.5 (N ≥ 6) so a single deep-pocketed agent cannot accumulate unbounded bonus by spreading across dozens of providers.

#### 5.1.5 Reference values

The following sanity-check values illustrate the formula for three canonical agents. Phase 1.5+ assumes H1 active; Phase 1 assumes H1 inactive with renormalization.

| Agent profile | P1 | P2 | D2 | H1 | R1 | raw (1.5+) | raw (P1) | bonus | score (1.5+) | score (P1) |
|---|---|---|---|---|---|---|---|---|---|---|
| Top: 1k paid / 6mo / 4 ops / 0 disputes / active | 60 | 29 | 60 | ~100 | 97 | ~72 | ~70 | 1.3 | **~94** | **~91** |
| Mid: 50 paid / 1mo / 2 ops / 0 disputes / active | 34 | 12 | 50 | ~96 | 100 | ~55 | ~50 | 1.1 | **~61** | **~55** |
| New: 5 paid / 0.5mo / 1 op / 0 disputes / active | 16 | 8 | 0 | ~86 | 100 | ~48 | ~39 | 1.0 | **~48** | **~39** |

### 5.2 Provider Weight Policy

While `global_trust_score` measures *agent behavior*, the broker MUST also assign each provider a `weight(p)` used for provider-credibility-aware decisions — most notably weighing `/report` submissions (§4.3). Weights and the policy parameters that govern them are published in `GET /info`.

`weight(p)` and `global_trust_score(pubkey)` are **deliberately decoupled**. RFC v0.1 mixed them through a `weighted_avg(provider_score(pubkey, p) * weight(p))` term, which let attestation volume dominate agent score. v0.2 removes that coupling: operator credibility (political/economic) and agent behavior (per-pubkey aggregates) cannot be conflated.

#### 5.2.1 Raw weight

```text
raw_weight(p) = tier_base(p) * log10(1 + attested_count_30d) * sqrt(max(1, months_in_network))
```

Tier base values:

| Tier | tier_base | Promotion criterion |
|---|---|---|
| alpha | 0.5 | Initial, after admin registration |
| beta | 1.0 | 30 days without disputes |
| production | 1.5 | 90 days at beta + ≥1 cross-op signal in good standing |

#### 5.2.2 Active cohort

Statistics on provider weights (median, percentiles) MUST be computed over an *active cohort* — never over all registered providers. Zero-traffic or dormant providers would otherwise collapse the median to zero and inflate the cap:

```text
active_cohort = { p : raw_weight(p) > 0
                       AND status(p) == "production"
                       AND last_attest_at >= now - active_window_days
                       AND distinct_pubkeys_attested_30d >= pubkey_reach_threshold }
```

`pubkey_reach_threshold` and `active_window_days` are governance parameters published in `GET /info.provider_weight_policy`.

#### 5.2.3 Cap and floor

```text
network_median = median({ raw_weight(p) : p in active_cohort })

floor(p) = floor_weight  if  p in active_cohort  AND  no_disputes_in_last_30d(p)
         = 0              otherwise

weight(p) = max( floor(p), min( raw_weight(p), cap_multiple_of_active_median * network_median ) )
```

- **Cap** prevents any single high-volume provider from dominating cross-op-derived signals.
- **Floor** protects small but legitimately active providers from being weighted to irrelevance, while requiring real reach (`pubkey_reach_threshold`) and clean recent history (`no_disputes_in_last_30d`) so it cannot be claimed by production-zombie operators.

Default policy published in `GET /info`:

```json
{
  "provider_weight_policy": {
    "pubkey_reach_threshold": 25,
    "cap_multiple_of_active_median": 3,
    "floor_weight": 0.3,
    "active_window_days": 7
  }
}
```

Changes to any value MUST go through the public change-window described in the broker governance document. Brokers MAY publish historical values to demonstrate stability.

### 5.3 Discount Application (provider)

Recommended:

```text
discount_pct = global_trust_score / 2          // up to 50% off
final_price  = base_price * (1 - global_trust_score / 200)
```

Providers MAY implement custom discount functions but SHOULD publish them on `GET /info` so clients can estimate.

### 5.4 Floor on final_price

`final_price` MUST NOT go below a configurable `BASE_PRICE` (provider policy). This prevents top-tier agents from effectively DDoSing the provider with free traffic.

## 6. Privacy & Security

- Pubkey is pseudonymous, not personally identifiable.
- Aggregate data MAY be exposed publicly.
- Provider-side payment details are private to each provider.
- Broker MUST NOT correlate pubkey to off-chain identity.
- Providers SHOULD avoid reporting more data than is necessary for reputation and abuse control.

The security model assumes that the broker is neutral and that providers authenticate their attestations with authorized signing keys. Attack resistance comes from aggregation across providers, not from any single provider's log. Sybil resistance improves as the network sees more independent attestations.

## 7. Versioning

Header `X-TrustScore-Spec-Version: 0.2` carries spec version on every request and response. Providers and clients MUST reject incompatible major versions (`HTTP 400`). Minor versions (`1.x`) are backward-compatible additions: new optional fields, new categories, new endpoints. Major versions (`2.x`) signal breaking changes.

## 8. Adoption Path for Providers

| Task | Effort |
|---|---|
| Read this spec + reference implementation in [`index.js`](../../index.js) | 1-2 hours |
| Register Ed25519 keypair with the broker (one-time) | 5 min |
| Implement `POST /attest` call after each successful x402 payment | 0.5 day |
| Implement `GET /reputation/:pubkey` query before each challenge issuance to apply discount | 0.5 day |
| (Optional) Implement `POST /report` for suspicious patterns | 0.5 day |
| Run integration tests against broker staging endpoint | 0.5 day |
| **Total** | **~2 days** |

A Shield instance configured with `TRUST_SCORE_BROKER_URL=<broker>` does steps 3-4 automatically — single env var ships the integration.

## 9. Federation (Optional Extension)

A single broker is a single point of failure and a single point of capture. The spec accommodates a federation of cooperating brokers:

- Each broker MAY peer with other brokers via `POST /peer/sync` (out of scope for v0.1; specified in v1.1).
- Providers MAY attest to multiple brokers; brokers reconcile via gossip with last-write-wins semantics.
- Clients MAY query any broker; results SHOULD converge within a configurable staleness window (default 5 minutes).
- A "primary broker" designation is anti-spec; all federated brokers are equal peers.

Federation is opt-in. v0.1 supports a single broker (centralized); v1.1 will define the gossip protocol once one or more independent providers want to host brokers. This deferral is intentional — federation requires real-world coordination among providers, not just spec design.

## 10. Sybil / Fraud Detection

The broker computes the following signals from raw attestation data. **All signals are derived from cross-provider visibility — a single provider cannot compute them**, which is the structural reason the broker exists:

| Signal | Trigger | Effect |
|---|---|---|
| `cross_provider_velocity` | Pubkey attested by ≥3 providers in <24h with `first_seen_at` <72h | `sybil_risk: high` |
| `wash_payment_suspect` | Same provider attests same pubkey >100×/day with constant amount | `fraud_flags: ["wash_payment_<date>"]` after 3 days |
| `coordinated_burst` | ≥10 distinct pubkeys created in <24h, all attested by same provider subset | `fraud_flags` on all pubkeys; `sybil_risk: high` |
| `dormant_revival` | `last_seen_at` >90 days, then sudden burst of >50 attestations | `churn_pattern: ephemeral`, score frozen 7 days |
| `cross_provider_dispute` | ≥2 providers report same `pubkey` with same category in <24h | Auto-elevation: dispute weight = 3× single report |

Providers receive these signals via the `ReputationRecord` and apply their own policy (block, throttle, raise price floor, etc.). The broker MUST NOT take direct action — it is signal-only.

## 11. Reference Implementation Notes

This repository's [`index.js`](../../index.js) implements the **broker as colocated with a single provider** for MVP simplicity. Mapping spec to current code:

| Spec concept | Current implementation |
|---|---|
| Broker data store | `reputation` Map (per-pubkey aggregate) |
| `POST /attest` handler | `recordPayment()` (called inline after x402 verification) |
| `GET /reputation/:pubkey` handler | `app.get("/reputation/:pubkey", ...)` |
| Discount application | `applyTrustDiscount()` |
| Anti-replay | `usedDepositSignatures` Set + nonce reuse check |

For production, the broker SHOULD be a separate service:

- **Persistence** — Redis Sorted Sets (`ZADD pubkey:scores`) + Postgres for audit log
- **Replication** — multi-region read replicas; primary in low-latency proximity to providers
- **Rate limiting** — provider-keyed token buckets to prevent attestation flooding
- **Audit trail** — all `/attest` and `/report` events logged with provider signatures, immutable
- **Monitoring** — Prometheus metrics on attestation rate, score distribution, fraud signal trigger rate
- **Provider registration** — out-of-band admin process; production brokers won't auto-accept arbitrary public keys

A separate `trust-score-broker` repository will house the production broker; v0.1 of the spec is satisfied by the in-process implementation in `index.js` for testing and reference.

## 12. Open Issues

- **Cross-chain reputation portability** (Tier 4 vision) — agents using the same Ed25519 keypair on Sui, Aptos, NEAR, or Base. Spec extension to attest cross-chain payments deferred to v1.x.
- **Privacy-preserving aggregation** — zk-attestations so the broker can publish "this pubkey has score >50" without revealing per-attestation amounts. Active research; deferred.
- **Decentralized broker federation** between multiple neutral brokers — gossip protocol deferred to v1.1.
- **Standardizing the fraud and sybil taxonomy** across providers — current categories are pragmatic; a formal taxonomy may emerge from running deployment data.
- **Compliance integrations** — KYC providers consuming Trust-Score as a behavior signal (deferred to v1.x).

## 13. References

- [x402 spec](https://x402.org) — Coinbase, 2024-2025 (HTTP payment standard)
- [`x402-priority`](./x402-priority.md) — wire-level 402 challenge spec
- [`x402-qos-cooperative`](./x402-qos-cooperative.md) — operator-side priority queue companion spec
- [Visa Trust Framework](https://usa.visa.com/about-visa/visa-trust-framework.html) — conceptual parallel
- [Plaid API](https://plaid.com/docs/api/) — architectural parallel for neutral broker design
- [RFC 7231](https://datatracker.ietf.org/doc/html/rfc7231) — HTTP/1.1 Semantics
- [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785) — JSON Canonicalization Scheme (recommended for `provider_signature` body)

## 14. Changelog

- **v0.2 (DRAFT, 2026-05-15)** — Agent score and provider weight decoupled. All subscores (P1, P2, D2, H1, R1) normalized to 0-100 before weighting. H1 uses Laplace (add-one) smoothing so new pubkeys do not inherit a perfect hygiene score from absence of evidence. Conditional renormalization rule (§5.1.3) for inactive subscores with `inactive_until_<feature>` status marker exposed in `/info`. Explicit `weight(p)` formula (§5.2) with active-cohort median, cap (`cap_multiple_of_active_median`, default 3), and conditional floor (`floor_weight`, default 0.3); governance parameters published as `provider_weight_policy` in `/info`. `cross_provider_bonus` mechanics preserved binarily so small operators retain network leverage. Resolved §12 "Provider weighting policy" open issue.
- **v0.1 (DRAFT, 2026-04-26)** — Initial draft. Data model with `per_provider` and `churn_pattern`, HTTP API (4 endpoints), score formula with `cross_provider_bonus`, federation outline, fraud signal taxonomy (5 signals), adoption path, reference implementation notes mapping to `index.js`.
