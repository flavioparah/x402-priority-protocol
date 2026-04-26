# RFC: x402-trust-score subprotocol — DRAFT v0.1

> **Status:** Draft. Maintainers: João Romeiro (CTO, RPC Priority Protocol).
> Aberto a comentários até 2026-06-01. Implementação de referência em
> https://github.com/flavioparah/x402-priority-protocol.

## Abstract

This document specifies the `x402-trust-score` subprotocol, a reputation layer that complements the x402 HTTP payment standard for distributed service-pricing markets. Trust-Score allows providers, such as RPC node operators, to apply data-driven discounts to known clients, such as AI agents identified by an Ed25519 keypair, without coordinating directly with each other. A neutral broker holds the cross-provider reputation so the network can recognize repeat behavior without collapsing into operator-specific silos.

## 1. Motivation

Machine-to-machine markets break down when every request looks anonymous. API keys solve authentication, but they do not solve memory: a provider cannot easily tell whether a paying agent is a first-time buyer, a loyal customer, or a suspicious pattern that should be throttled. In Solana RPC markets this gets worse because operators compete, pricing is dynamic, and the same agent may transact across multiple providers within a short period. A neutral reputation layer creates continuity across providers while preserving operator independence. The broker is necessary because no single operator can safely hold the full cross-network picture without creating a conflict of interest. Trust-Score turns repeated payments into a portable signal that can improve pricing, detection of abuse, and eventual access to better service tiers.

## 2. Architecture

```text
Agent <-> Provider <-> Trust-Score Broker (neutral)
```

The agent pays the provider through x402. The provider emits attestations about successful payments and suspicious behavior. The broker aggregates those attestations into a global score, then returns a public reputation record to any provider that wants to quote a discount or enforce a policy. Providers remain in control of final pricing; the broker only supplies the signal.

## 3. Data Model

```typescript
interface ReputationRecord {
  pubkey: string;            // base58, Ed25519 public key
  global_trust_score: number; // 0-100
  paid_count_total: number;
  total_paid_micro_lamports: number;
  first_seen_at: number;     // unix ms
  last_seen_at: number;
  active_in_n_providers: number;
  loyalty_concentration: number; // 0-1, how concentrated in single provider
  fraud_flags: string[];
  sybil_risk: "low" | "medium" | "high";
}
```

`global_trust_score` is intentionally compact: it is a ranking signal, not a full behavioral dossier. `active_in_n_providers` and `loyalty_concentration` help distinguish genuine repeat users from concentrated or artificial usage. `fraud_flags` and `sybil_risk` are the defensive layer that lets providers respond to abuse without needing to share raw customer logs.

## 4. HTTP API

### 4.1 GET /reputation/:pubkey

Returns a `ReputationRecord`. Public read.

### 4.2 POST /attest

Provider reports a successful payment.

```json
{
  "pubkey": "...",
  "amount_micro_lamports": 40200,
  "tx_signature": "...",
  "provider_id": "...",
  "provider_signature": "..."
}
```

`provider_signature` must be produced by the provider's authorized key. The broker SHOULD verify the attestation against the reported transaction before accepting it into the reputation set.

### 4.3 POST /report

Provider reports suspicious behavior such as a sybil candidate, payment dispute, refund abuse, or repeated policy violations. Reports SHOULD be scoped to observable behavior and MAY be weighted by provider credibility.

## 5. Discount Function

Recommended:

```text
score = min(100, paid_count * 5)
discount_pct = score / 2
final_price = base_price * (1 - score/200)
```

Providers MAY implement custom discount functions, but SHOULD publish them so clients can estimate prices ahead of time. The point of the spec is not to standardize a single commercial policy; it is to standardize the reputation input so the market can compare offers on equal footing.

## 6. Privacy & Security

- Pubkey is pseudonymous, not personally identifiable.
- Aggregate data MAY be exposed publicly.
- Provider-side payment details are private to each provider.
- Broker MUST NOT correlate pubkey to off-chain identity.
- Providers SHOULD avoid reporting more data than is necessary for reputation and abuse control.

The security model assumes that the broker is neutral and that providers authenticate their attestations with authorized signing keys. Attack resistance comes from aggregation across providers, not from any single provider's log. Sybil resistance improves as the network sees more independent attestations.

## 7. Versioning

Header `X-TrustScore-Spec-Version: 1.0` carries spec version. Providers SHOULD reject incompatible versions. Future versions MAY add fields to `ReputationRecord`, but MUST preserve backward compatibility for the public read path.

## 8. Open Issues

- Cross-chain reputation portability for Tier 4.
- Decentralized broker federation between multiple neutral brokers.
- Privacy-preserving aggregation, possibly with zk attestations.
- Standardizing the fraud and sybil taxonomy across providers.

## 9. References

- x402 spec (Coinbase, 2024-2025): https://x402.org
- Visa Trust Framework, as a conceptual parallel.
- Plaid API design, as an architectural parallel.
