# x402-priority — Specification v1.0 (DRAFT)

> **Status:** Draft v1.0. Maintainer: João Romeiro (CTO, RPC Priority Protocol).
> Companion specs: [`x402-trust-score`](./x402-trust-score.md) (cross-operator reputation), [`x402-qos-cooperative`](./x402-qos-cooperative.md) (operator-side scheduling hint).
> Reference implementation: this repository's [`index.js`](../../index.js).
> Open to comments at <https://github.com/flavioparah/x402-priority-protocol/issues> until 2026-06-30.

## Abstract

This document specifies **x402-priority**, a subprotocol of the [x402 HTTP payment standard](https://x402.org) that gates HTTP requests by load and pricing rather than by authentication. When the upstream service is below a configured load threshold, requests pass for free. When load exceeds the threshold, the gateway issues an HTTP 402 challenge with a signed payment nonce. The client signs the nonce with an Ed25519 keypair, retries the request with an `Authorization: x402` header, and the gateway verifies the signature, debits a pre-funded escrow, and forwards the request upstream. The protocol is stateless from the client's perspective — no API key, no contract, no whitelist.

x402-priority is designed for **agentic workloads** — autonomous bots, MEV searchers, AI agents, indexers — where the consumer is software with a Solana keypair, not a human with a credit card. The wire format is HTTP-native and SDK-agnostic; reference implementations exist in JavaScript ([`x402-client-sdk.ts`](../../x402-client-sdk.ts)) and any Solana SDK with Ed25519 signing primitives can integrate.

## 1. Motivation

Existing RPC priority models all assume one of three things that break for agents:

| Existing model | Broken assumption |
|---|---|
| **Per-IP rate limits** | Agent infra is elastic (Lambda, container, k8s) — IP changes per request |
| **API key + monthly plan** | Agent has a wallet, not a credit card — can't sign B2B contracts |
| **IP allowlist / VIP tier** | Agent counts in the thousands and rotates infra — can't curate manually |

x402-priority replaces these with **per-request payment in native SOL**, using cryptographic identity (Ed25519 wallet) rather than account credentials. The result:

- An agent doesn't register, doesn't carry credentials, doesn't plan ahead — it pays only when the network congests, on demand, in fractional cents.
- An operator earns directly proportional to the value they provide to that specific request, not via a subscription with massive variance.
- A reputation layer ([`x402-trust-score`](./x402-trust-score.md)) makes loyal customers cheaper without any account-management overhead.

x402-priority is intentionally **complementary to**, not competitive with, native Solana priority fees and Jito bundles. Native fees price inclusion of a transaction in a block; x402-priority prices access to the RPC node that submits that transaction (and, more importantly, the read traffic that doesn't generate transactions at all).

## 2. Architecture

```text
┌──────────┐                                 ┌─────────────┐
│  Client  │                                 │  Upstream   │
│  (agent) │                                 │  RPC node   │
└────┬─────┘                                 └──────┬──────┘
     │                                              │
     │  POST /rpc {jsonrpc:..,method:..}            │
     ├─────────────────────────────────────▶┌───────┴───────┐
     │                                      │               │
     │     402 Payment Required             │   x402-       │
     │     X-x402-Nonce: <hex>              │   priority    │
     │     X-x402-Amount: <µL>              │   gateway     │
     │     X-x402-Payment-Destination: <pk> │   (Shield)    │
     │◀─────────────────────────────────────┤               │
     │                                      │               │
     │  POST /rpc                           │               │
     │  Authorization: x402                 │               │
     │    <bs58(sig)>.<bs58(pk)>.<bs58(msg)>│               │
     ├─────────────────────────────────────▶│               │
     │                                      │  verify sig + │
     │                                      │  debit escrow │
     │                                      │  via Lua      │
     │                                      ├───────────────┤
     │                                      │     proxy     │
     │                                      ├──────────────▶│
     │                                      │               │
     │     200 OK {jsonrpc:..,result:..}    │               │
     │◀─────────────────────────────────────┤               │
     │                                      │               │
     └──────────────────────────────────────┴───────────────┘
```

The gateway sits between the client and the upstream RPC node. When load is below the threshold, the gateway acts as a transparent proxy. When load exceeds the threshold (or per-IP rate limit triggers), the gateway gates new requests through a 402 challenge.

## 3. Load and Pricing

### 3.1 Load metric

Load is computed locally by the gateway as a sliding-window RPS measurement, normalized against a configurable maximum:

```text
load(t) = min(1, count(requests in [t - W, t]) / MAX_RPS)
```

Where `W` (default `5_000` ms) is the sliding window and `MAX_RPS` (default `50`) is the operator's configured ceiling. Implementations MAY substitute an externally-supplied load metric (e.g., from a Prometheus scrape of the upstream) — the protocol is agnostic to the source.

### 3.2 Gating decision

A request is gated (returns 402) when:

```text
gated = (load > THRESHOLD) || rate_limited(client_ip)
```

Where `THRESHOLD` (default `0.5`) is the configurable activation threshold and `rate_limited` is a per-IP soft cap (default 100 req/min) used as a coarse-grained spam filter.

### 3.3 Price calculation

The challenge amount scales linearly between `BASE_PRICE` and `MAX_PRICE` over the gated load range:

```text
ratio  = clamp(0, 1, (load - THRESHOLD) / (1 - THRESHOLD))
amount = round(BASE_PRICE + ratio * (MAX_PRICE - BASE_PRICE))
```

In micro-lamports (µL). The reference deployment uses `BASE_PRICE=20000` (20 lamports) and `MAX_PRICE=1000000` (1000 lamports). Operators MAY publish their own values via `GET /info` (Section 7.4).

If the client sends a Trust-Score hint (`X-x402-Agent-Pubkey` header), the gateway MAY apply a discount per [`x402-trust-score`](./x402-trust-score.md). The discount formula is:

```text
final_amount = max(BASE_PRICE, round(amount * (1 - score / 200)))
```

A score of 100 yields 50% off; the floor at `BASE_PRICE` prevents free traffic.

## 4. The 402 Challenge

### 4.1 Response

On a gated request, the gateway responds with HTTP 402 and the following fields.

**Headers:**

| Header | Value |
|---|---|
| `X-x402-Status` | `"challenged"` |
| `X-x402-Payment-Destination` | base58 Solana pubkey to receive payment |
| `X-x402-Amount` | µLamports (final, after discount) |
| `X-x402-Amount-Base` | µLamports (base, pre-discount) |
| `X-x402-Trust-Score` | Trust-Score applied (0–100), or `0` if no hint |
| `X-x402-Nonce` | nonce (32-character lowercase hex) |
| `X-x402-Nonce-TTL` | nonce lifetime in seconds (default `30`) |
| `Content-Type` | `application/json` |

**Body:**

```json
{
  "error": "Payment Required",
  "code": 402,
  "message": "RPC node under load. Pay priority fee to proceed.",
  "payment": {
    "destination": "<base58 pubkey>",
    "amount_micro_lamports": 40200,
    "amount_base_micro_lamports": 40200,
    "trust_score": 0,
    "nonce": "0bf1988e44c2...",
    "ttl_seconds": 30,
    "instructions": "Sign the payload and retry with: Authorization: x402 <sig>.<pubkey>.<msg>. Send X-x402-Agent-Pubkey to claim Trust-Score discount."
  }
}
```

The body is informational; clients SHOULD use the headers as the source of truth (they're easier to parse and can't be JSON-corrupted by intermediate proxies).

### 4.2 Nonce semantics

A nonce is a single-use token bound to one (amount, destination, optional pubkey hint) tuple. The gateway MUST:

- Generate the nonce with at least 128 bits of cryptographic entropy (recommended: `crypto.randomBytes(16)` rendered as lowercase hex).
- Store the nonce in a TTL-bounded primitive (Redis `SET ... EX <ttl>` or equivalent).
- Reject reuse: a nonce that has been consumed once MUST NOT be accepted again, even within its TTL.
- Bind the nonce to the `hintedPubkey` if a hint was sent. Signers using a different pubkey MUST be rejected even if the signature would otherwise verify.

### 4.3 Pubkey hint and Trust-Score

A client MAY include `X-x402-Agent-Pubkey: <base58>` on the initial request. The gateway:

1. Looks up the pubkey's Trust-Score (0–100).
2. Applies the discount per Section 3.3.
3. Binds the issued nonce to that pubkey (`hintedPubkey`).

The hint is **cosmetic until proven** — applying a discount based on a hinted pubkey only commits the gateway if the client's signed retry uses the same pubkey. This prevents Alice from claiming Bob's discount.

## 5. The Signed Retry

### 5.1 Payload

The client constructs the canonical payload:

```json
{
  "nonce": "<hex>",
  "pubkey": "<base58>",
  "amount": <µL int>,
  "destination": "<base58>"
}
```

Serialized via `JSON.stringify(...)` — the reference implementation does **not** require RFC 8785 canonicalization, but key order MUST be `nonce, pubkey, amount, destination`. Implementations MAY accept any field order in v2.x; v1.0 enforces fixed order to keep the signing surface tight.

### 5.2 Signature

The client signs the UTF-8 bytes of the serialized payload using Ed25519, with the secret key corresponding to the `pubkey` field.

```text
signature = ed25519_sign(secret_key, utf8(payload))
```

### 5.3 Authorization header

The client retries the original request with:

```text
Authorization: x402 <bs58(signature)>.<bs58(pubkey)>.<bs58(utf8(payload)))>
```

Three base58 components separated by `.` (period). All three MUST be base58 (Solana convention, not base64) to match the wallet ecosystem.

The gateway:

1. Splits the header on `.` into 3 parts; rejects if not exactly 3.
2. Decodes each part from base58.
3. Verifies `ed25519_verify(pubkey, payload, signature)`.
4. Parses the payload; extracts `nonce, pubkey_in_payload, amount, destination`.
5. Confirms `pubkey_in_payload === bs58(pubkey)` (signature pubkey matches payload claim).
6. Confirms `destination === <gateway's PAYMENT_DESTINATION>`.
7. Atomically: validates nonce, validates `amount >= nonce.amount`, validates `pubkey === nonce.hintedPubkey` (if bound), validates escrow balance, marks nonce used, debits escrow.

Any failure → 402 with a fresh challenge. Success → forward to upstream, record payment, update reputation.

### 5.4 Atomicity

Steps 7's combined check-and-debit MUST be atomic. The reference implementation uses a Redis Lua script (see [`lib/store.js`](../../lib/store.js) `consumeNonceAndDebit`):

```lua
-- pseudocode of the actual script
if not nonce_exists then return {0, 'nonce_not_found'} end
if nonce.used then return {0, 'nonce_already_used'} end
if claimed_amount < nonce.amount then return {0, 'insufficient_payment'} end
if nonce.hintedPubkey and nonce.hintedPubkey ~= pubkey then
  return {0, 'pubkey_hint_mismatch'}
end
if escrow_balance < claimed_amount then
  return {0, 'insufficient_balance'}
end
mark_nonce_used()
new_balance = decrement_escrow(claimed_amount)
return {1, 'ok', new_balance}
```

Two concurrent retries with the same valid nonce: exactly one wins, the other gets `nonce_already_used`. This is required for correctness: without atomicity, double-spend is trivial.

## 6. Escrow

### 6.1 Pre-funding

A client funds its escrow with a one-time on-chain transfer to the gateway's `PAYMENT_DESTINATION`, then submits the transaction signature to the gateway:

```http
POST /escrow/deposit
Content-Type: application/json

{ "tx_signature": "<base58 Solana tx signature>" }
```

The gateway:

1. Fetches the transaction from a configurable Solana RPC (`SOLANA_RPC_URL`, defaults to mainnet-beta).
2. Validates: tx is finalized, recipient matches `PAYMENT_DESTINATION`, sender is identifiable, `tx_signature` not previously consumed (anti-replay).
3. Credits escrow at **1000 µL per lamport** (1 µL = 0.001 lamport).
4. Returns `{credited_micro_lamports, balance, signature, slot, sender_pubkey}`.

### 6.2 Why 1000:1

µLamports give finer-grained pricing than lamports (which round to whole numbers). At 1000 µL/lamport, a request priced at 40,200 µL costs 40.2 lamports — preserving precision through the pricing curve. The 1000:1 ratio is the same Solana itself uses for compute-unit-price (`setComputeUnitPrice` is also in micro-lamports).

### 6.3 Trusted deposits (demo only)

A gateway MAY enable `ESCROW_TRUST_DEPOSITS=1` to accept escrow credits without on-chain verification, via:

```http
POST /escrow/deposit-trusted
{ "pubkey": "<base58>", "amount_micro_lamports": <int> }
```

This is for **demonstration deployments only** (e.g., the Trust-Score progression demo at `https://demo.rpcpriority.com`). Production gateways serving real traffic MUST disable trusted deposits.

## 7. HTTP API

### 7.1 POST /rpc

The gated proxy. JSON-RPC body forwarded to upstream on success; 402 on gating; relays upstream errors when the call reaches upstream.

### 7.2 POST /escrow/deposit

Verified on-chain deposit (Section 6.1).

### 7.3 GET /escrow/balance/:pubkey

Returns the escrow balance for a pubkey:

```json
{ "pubkey": "<base58>", "balance_micro_lamports": 1999025150 }
```

Public read. No authentication.

### 7.4 GET /info

Static metadata about the gateway:

```json
{
  "operator_pubkey": "<base58>",
  "network": "mainnet" | "devnet" | "unknown",
  "upstream_rpc": "<URL>",
  "base_price_micro_lamports": 1000,
  "max_price_micro_lamports": 50000,
  "threshold": 0.5,
  "nonce_ttl_seconds": 30,
  "trusted_deposits_enabled": false
}
```

Used by clients to estimate prices ahead of time. Public read.

### 7.5 GET /reputation/:pubkey

See [`x402-trust-score`](./x402-trust-score.md). Returns trust score, paid count, sybil risk, churn pattern.

### 7.6 GET /health

Liveness probe with current load:

```json
{
  "status": "ok",
  "load": "0.50",
  "threshold": 0.5,
  "rps": "12.34",
  "max_rps": 50,
  "nonces_active": 3,
  "store_backend": "redis" | "memory"
}
```

## 8. Error Handling

| Code | Meaning | When |
|---|---|---|
| `200` | Success | Request passed (free) or signed retry succeeded |
| `402` | Payment Required | Gating active; signed retry invalid; nonce expired |
| `400` | Bad Request | Malformed Authorization header, malformed JSON |
| `503` | Service Unavailable | Internal queue overflow (see [`x402-qos-cooperative`](./x402-qos-cooperative.md)) |
| `504` | Gateway Timeout | Internal queue timeout |
| Upstream | Transparent passthrough | When forwarded to upstream, upstream's response code is returned as-is |

The 402 response after signed retry failure SHOULD include a fresh nonce so the client can immediately retry without a separate request.

## 9. Security Considerations

### 9.1 Replay
The atomic nonce-consume primitive (Section 5.4) prevents the same nonce from being used twice. The 30-second TTL bounds the replay window. Deposit signatures are tracked in a separate set (`x402:deposit-sigs`) and rejected on second submission.

### 9.2 Hint spoofing
A client cannot apply Bob's Trust-Score by hinting Bob's pubkey: the issued nonce is bound to Bob's pubkey, and the signed retry must use Bob's secret key. Worst case: Alice triggers a 402 issuance for Bob, costing Alice nothing and inconveniencing nothing.

### 9.3 Operator key compromise
The gateway does **not** hold the operator's secret key. `PAYMENT_DESTINATION` is a public address; the operator's wallet is offline (recommended: hardware wallet) and only used to sweep accumulated SOL. Server compromise loses operational state but cannot drain funds.

### 9.4 Upstream RPC compromise
A compromised upstream can return wrong RPC results, but the gateway's payment receipt is on-chain and immutable. Clients SHOULD verify on-chain state independently for high-value operations.

### 9.5 Chosen-pubkey attacks
The pubkey in the signed payload MUST equal the pubkey in the Authorization header. The reference implementation enforces this at Section 5.3 step 5. Without this check, an attacker could sign with a key they control and claim the payload was signed by a different (high-Trust-Score) party.

### 9.6 Denial of service
The pricing curve and per-IP rate limit jointly throttle abuse. An attacker forced to pay 50 lamports per request will spend faster than they can attack — congestion becomes economically self-limiting.

## 10. Versioning

Header `X-x402-Spec-Version: 1.0` MAY be sent by clients and gateways. Major version mismatches MUST be rejected with `400`. Minor versions are backward-compatible (new optional headers, new optional payload fields). The reference implementation does not require the header — defaults to v1.0 — but MAY enforce it in v2.x.

## 11. Reference Implementation

This repository implements the entire spec:

| Spec section | Code location |
|---|---|
| §3 Load + pricing | [`index.js`](../../index.js) `getRpcLoad`, `calcDynamicPrice`, `applyTrustDiscount` |
| §4 Challenge | `app.post("/rpc", ...)` (the 402 path) + `issueNonce` |
| §5 Signed retry verification | `verifyX402Authorization` |
| §5.4 Atomic consume | [`lib/store.js`](../../lib/store.js) `consumeNonceAndDebit` (Lua) |
| §6 Escrow | `verifyDepositTx`, `app.post("/escrow/deposit", ...)` |
| §7 HTTP API | All `app.get` / `app.post` handlers |

End-to-end test: [`tools/pay-test-mainnet.js`](../../tools/pay-test-mainnet.js) exercises the full handshake against the live mainnet gateway.

Live deployment: `https://api.rpcpriority.com` (operator pubkey `CEH3dGLaYQmYGGwDpszfuBRfcUmBbLNinrSdVdi7k6zp`).

## 12. Open Issues

- **Bundle support** — multi-request atomic-or-none, similar to Jito Bundles, deferred to v1.1.
- **Mempool semantics** — the protocol currently treats `/rpc` as opaque proxy; surfacing pre-block visibility to clients (à la Jito's auctioneer) is out of scope.
- **Negative balance recovery** — if a client's signed retry races a refund (rare; not implemented), balance can briefly go negative. The reference treats this as best-effort consistency.
- **Nonce rotation across operators** — currently each gateway issues nonces independently. A federated nonce broker (similar to Trust-Score federation) would let agents pre-commit cross-operator. Deferred to v2.x.

## 13. References

- [x402](https://x402.org) — the underlying HTTP payment standard (Coinbase, 2024-2025)
- [Ed25519](https://datatracker.ietf.org/doc/html/rfc8032) — RFC 8032
- [Solana getParsedTransaction](https://solana.com/docs/rpc/http/getparsedtransaction) — used in Section 6 deposit verification
- [`x402-trust-score`](./x402-trust-score.md) — companion reputation spec
- [`x402-qos-cooperative`](./x402-qos-cooperative.md) — companion operator-side scheduling spec

## 14. Changelog

- **v1.0 (DRAFT, 2026-04-30)** — Initial public spec consolidating the wire-protocol portions of the reference implementation. Sections: Load + pricing curve, 402 challenge format with all 7 headers, signed retry payload + Authorization header format, atomic consume primitive, escrow deposit flow with on-chain verification, HTTP API surface, security considerations.
