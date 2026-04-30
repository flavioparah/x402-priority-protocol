# x402-trust-score — Specification v0.1 (DRAFT)

> **Status:** Draft v0.1. Maintainer: João Romeiro (CTO, RPC Priority Protocol).
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

- **`global_trust_score`** is the value providers apply discounts against. Recommended formula in Section 5.
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

Returns broker metadata: supported spec version(s), federation peers (if any), provider registration policy, broker-published discount formula. Used by clients to estimate prices ahead of time and by providers to verify protocol compatibility.

## 5. Score & Discount

### 5.1 Score Calculation (broker)

Recommended:

```text
provider_score(pubkey, p)  = min(100, paid_count_at_provider * 5)
weighted_avg(pubkey)       = Σ_p (provider_score(pubkey, p) * weight(p)) / Σ_p weight(p)
cross_provider_bonus(pubkey) = min(1.5, 1 + 0.1 * (active_in_n_providers - 1))

global_trust_score(pubkey) = min(100, weighted_avg(pubkey) * cross_provider_bonus(pubkey))
```

Where `weight(p)` is the broker-assigned trust weight per provider (default 1.0; tier-1 providers MAY have higher weight per published policy).

The `cross_provider_bonus` rewards reputation built across multiple providers. A pubkey with score 50 at one provider caps at 50 globally; the same 50-point reputation distributed across 3 providers reaches 60 global, across 5 providers reaches 70. **This is the core network-effect mechanism**: providers benefit from joining because their customers' scores grow faster than they would in isolation.

### 5.2 Discount Application (provider)

Recommended:

```text
discount_pct = global_trust_score / 2          // up to 50% off
final_price  = base_price * (1 - global_trust_score / 200)
```

Providers MAY implement custom discount functions but SHOULD publish them on `GET /info` so clients can estimate.

### 5.3 Floor

`final_price` MUST NOT go below a configurable `BASE_PRICE` (provider policy). This prevents top-tier agents from effectively DDoSing the provider with free traffic.

## 6. Privacy & Security

- Pubkey is pseudonymous, not personally identifiable.
- Aggregate data MAY be exposed publicly.
- Provider-side payment details are private to each provider.
- Broker MUST NOT correlate pubkey to off-chain identity.
- Providers SHOULD avoid reporting more data than is necessary for reputation and abuse control.

The security model assumes that the broker is neutral and that providers authenticate their attestations with authorized signing keys. Attack resistance comes from aggregation across providers, not from any single provider's log. Sybil resistance improves as the network sees more independent attestations.

## 7. Versioning

Header `X-TrustScore-Spec-Version: 1.0` carries spec version on every request and response. Providers and clients MUST reject incompatible major versions (`HTTP 400`). Minor versions (`1.x`) are backward-compatible additions: new optional fields, new categories, new endpoints. Major versions (`2.x`) signal breaking changes.

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

- **Provider weighting policy** — how a broker assigns `weight(p)` without favoritism. Proposed: weight by attested volume × time-in-network, with a published formula on `GET /info`.
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

- **v0.1 (DRAFT, 2026-04-26)** — Initial draft. Data model with `per_provider` and `churn_pattern`, HTTP API (4 endpoints), score formula with `cross_provider_bonus`, federation outline, fraud signal taxonomy (5 signals), adoption path, reference implementation notes mapping to `index.js`.
