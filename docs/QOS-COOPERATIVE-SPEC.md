# x402-qos-cooperative — Specification v1.0 (DRAFT)

> **Status:** Draft v1.0. Maintainer: João Romeiro (CTO, RPC Priority Protocol).
> Reference implementation: [`examples/operator-qos-reference.js`](../examples/operator-qos-reference.js).
> Integration test: [`test/cooperative-qos.test.js`](../test/cooperative-qos.test.js).
> Open to comments at <https://github.com/flavioparah/x402-priority-protocol/issues> until 2026-06-30.

---

## Abstract

This document specifies **x402-qos-cooperative**, a cross-component protocol that lets an [x402](https://x402.org)-compliant gateway (Shield) signal request priority to an upstream RPC node operator's stack via HTTP headers, so the operator's own scheduler can honor priority directly — instead of the Shield queueing locally.

The protocol is opt-in. A Shield in `cooperative` mode SHOULD forward two headers and respect a defined fallback contract; an operator implementing the spec SHOULD use the headers to influence its scheduling and emit a defined response signal when overloaded. Either side MAY decline; the system falls back gracefully to standalone behavior.

This spec complements [x402-shield's standalone QoS](../README.md#qos-priority-queue) (where the Shield itself maintains the priority queue). Cooperative QoS pushes scheduling **closer to the metal** of the RPC node, which yields better fairness when the upstream node is the bottleneck.

---

## 1. Motivation

x402 monetizes **gating** ("you pay to pass under load"). Standalone QoS adds **ordering at the proxy edge** ("higher payment ⇒ earlier dispatch among queued requests"). Both are useful, but neither tells the **upstream Solana RPC node** anything about request priority.

When the bottleneck is the upstream node itself (CPU, RPC thread pool, mempool depth), only the operator can:

- Reserve capacity for paid requests (separate worker pools per tier)
- Apply per-thread quotas (block free traffic from starving paid traffic)
- Coordinate with validator-internal QoS (e.g., Jito-Solana modifications, custom Solana validator forks)
- Emit graceful overload signals back to the Shield so it can route around the issue

x402-qos-cooperative defines the **minimum interface** an operator implements to cooperate — and the **fallback contract** when the operator can't honor a hint.

---

## 2. Architecture

```
┌────────────┐    POST /rpc    ┌─────────────┐   X-Priority-Score: N    ┌─────────────────┐
│  Agent     │───────────────▶ │  Shield     │─────────────────────────▶│  Operator's     │
│  (signed   │                 │  (cooperative│                         │  RPC stack      │
│   x402)    │                 │   mode)     │ ◀─── X-QoS-Overload (?)──│  (with own QoS) │
└────────────┘                 └─────────────┘   On 503 + Overload:1    └─────────────────┘
                                      │           Shield falls back to
                                      │           standalone queue
                                      └─── /stats/qos exposes mode + overload count
```

**Boundary:** the Shield owns x402 verification (signature, escrow, anti-replay, Trust-Score discount). The operator owns scheduling/dispatching. They communicate via two headers and one response code.

---

## 3. Header Contract

### 3.1 `X-Priority-Score` (request, optional, integer)

Numeric priority hint computed by the Shield. Higher is more important. Range: `[0, 2^31)`. Recommended formula:

```
priorityScore = verifiedAmountMicroLamports + verifiedTrustScore * 100
```

Where:
- `verifiedAmountMicroLamports` is the µ-lamport amount paid for the current request (post-discount).
- `verifiedTrustScore` is the agent's 0-100 reputation score (see [TRUST-SCORE-RFC-DRAFT.md](./TRUST-SCORE-RFC-DRAFT.md)).

Operators MAY use the score directly or apply a custom transform. Operators MUST NOT trust the score as a security primitive — it is a **hint**, not an authentication.

### 3.2 `X-QoS-Spec-Version` (request, required when cooperating, string)

Currently `1`. Operators MUST reject (`HTTP 400`) requests with an unknown major version. Minor revisions are backward-compatible.

### 3.3 `X-QoS-Operator-Tier` (request, optional, integer)

OPTIONAL hint about the agent's pricing tier (`1`=basic, `2`=standard, `3`=premium). Allows operators with multi-tier worker pools to route directly without recomputing from score. Shields MAY omit; operators MAY ignore.

### 3.4 `X-QoS-Overload` (response, optional, "1" only)

When set to `"1"` on any non-2xx response, the operator declares it cannot honor priority hints right now (capacity exhausted, validator restart, planned maintenance). Shields receiving this header MUST fall back to **standalone QoS** for subsequent requests for at least 30 seconds.

Operators SHOULD also include `Retry-After` (RFC 7231) when known.

---

## 4. Scheduling Recommendations (non-normative)

How an operator implements scheduling is out of scope, but typical patterns:

| Pattern | Description | Trade-off |
|---|---|---|
| **Priority-weighted pool** | N worker threads; threads pick from a min-heap ordered by `X-Priority-Score`. | Simple, FIFO within score buckets. |
| **Tier-isolated pools** | Separate pools per `X-QoS-Operator-Tier`. Premium pool reserved (not stealable). | Strong isolation; worse utilization. |
| **Token bucket per tier** | Each tier consumes from a bucket refilled at tier-specific rate. | Smooth long-tail behavior. |
| **Aging hybrid** | Score boosted by `Date.now() - enqueuedAt`. Low-priority eventually clears. | Prevents starvation. |

The reference implementation (Section 8) uses **aging hybrid** — same algorithm as standalone QoS, identical effective-score function. This makes Path A and Path B observationally equivalent at the agent level.

---

## 5. Fallback Behavior (Shield-side)

A Shield in `cooperative` mode MUST implement:

1. **Forward** `X-Priority-Score` and `X-QoS-Spec-Version` on every proxied request.
2. **Listen** for `X-QoS-Overload: 1` on responses. On detection, **disable cooperative mode** and re-enter standalone for the next 30 seconds.
3. **Health-check** the operator's stack independently (e.g., periodic `OPTIONS /qos-status`). If unreachable for > 60 seconds, fall back to standalone.
4. **Re-probe** every 30 seconds during fallback. If the operator returns successfully, resume cooperative mode after 3 consecutive successes.

This is implemented in [`index.js`](../index.js) — search for `qosMiddleware` and `qosOverloadFallback`.

---

## 6. Operator-Side Minimum Implementation

To implement the spec, an operator needs:

1. **Read** `X-Priority-Score` (default to `0` if missing).
2. **Validate** `X-QoS-Spec-Version` (reject if unknown major).
3. **Schedule** the request using its own QoS engine (priority-weighted worker pool, tier-isolated pools, etc).
4. **Emit** `X-QoS-Overload: 1` on overload responses (`HTTP 503` recommended).

Reference: [`examples/operator-qos-reference.js`](../examples/operator-qos-reference.js) implements all four in ~80 lines of Node.js.

---

## 7. Privacy & Security

- `X-Priority-Score` is **not authenticated**. The Shield's signed challenge already proves payment; the score is derivative.
- Operators MUST NOT use the score for billing decisions (only the x402 signature is authoritative).
- The score reveals approximately how much a given agent is paying and how trusted it is. Operators logging the score should treat it as **business-confidential** — exposing all scores publicly could let competitors reverse-engineer pricing curves.
- Operators MUST NOT correlate `X-Priority-Score` with off-chain identifiers without independent consent.

---

## 8. Reference Implementation

[`examples/operator-qos-reference.js`](../examples/operator-qos-reference.js) is a self-contained Node.js HTTP server demonstrating the operator side. It:

- Listens on `127.0.0.1:9000`
- Maintains a 4-slot worker pool with priority-weighted dispatch
- Honors `X-Priority-Score` (defaults to 0)
- Forwards to a configurable upstream Solana RPC
- Emits `X-QoS-Overload: 1` when its internal queue exceeds `MAX_QUEUE_DEPTH`
- Logs every dispatch with score, wait time, and outcome

Run it as a fake operator behind the Shield in cooperative mode (see Section 9).

---

## 9. End-to-End Integration Test

[`test/cooperative-qos.test.js`](../test/cooperative-qos.test.js) validates the full loop:

1. Starts the reference operator on port 9000.
2. Starts a Shield with `QOS_MODE=cooperative REAL_RPC_URL=http://127.0.0.1:9000`.
3. Issues a paid request through the Shield.
4. Asserts the reference operator received `X-Priority-Score` and `X-QoS-Spec-Version` headers.
5. Forces the operator into overload (queue saturation), asserts `X-QoS-Overload: 1` is emitted, asserts the Shield falls back to standalone for the next request.

Pass criteria: 5 assertions, total runtime < 30s, zero leaked sockets.

Run: `npm run test:cooperative-qos`.

---

## 10. Versioning

- Major version (`1`) bumps for breaking changes. Always conveyed via `X-QoS-Spec-Version`.
- Minor version (`1.x`) bumps for additive, backward-compatible changes (new optional headers, new tier values). Not conveyed in the wire — software MAY introspect via `OPTIONS /qos-status`.

This document describes spec **v1.0**.

---

## 11. Adoption Path for Operators

For an operator to integrate, the typical effort is:

| Task | Effort |
|---|---|
| Read spec (this doc) + reference impl | 1 hour |
| Add header forwarding to existing nginx/Caddy in front of validator | 0.5 day |
| Implement priority-weighted worker pool (or wire existing one to read header) | 1-2 days |
| Wire `X-QoS-Overload` emission on overload paths | 0.5 day |
| Run integration test against own deployment | 0.5 day |
| **Total** | **~3 days** |

A Shield deployed to point at the integrated operator simply sets `QOS_MODE=cooperative`. No code change in the Shield — just env var.

---

## 12. Open Issues

- **Multi-region operators**: how to coordinate score forwarding across regions when a Shield instance hits a regional load balancer.
- **Validator-internal QoS** (e.g., Jito-Solana modification): defining a standard hook so future Solana validator clients can implement the spec at the validator layer rather than at the gateway layer.
- **Decentralized score attestation**: when multiple Shields cooperate without a central Trust-Score broker, how the score itself is computed and verified. Tracked in [TRUST-SCORE-RFC-DRAFT.md](./TRUST-SCORE-RFC-DRAFT.md) Open Issues.

---

## 13. References

- [x402 spec](https://x402.org) — Coinbase, 2024-2025
- [TRUST-SCORE-RFC-DRAFT.md](./TRUST-SCORE-RFC-DRAFT.md) — companion spec for cross-operator reputation
- [RFC 7231](https://datatracker.ietf.org/doc/html/rfc7231) — HTTP/1.1 Semantics (Retry-After)
- [Standalone QoS implementation](../index.js) — `qosMiddleware`, `qosOnSlotFree`

---

## 14. Changelog

- **v1.0 (DRAFT, 2026-04-26)** — Initial draft. Header contract, fallback behavior, reference implementation, integration test.
