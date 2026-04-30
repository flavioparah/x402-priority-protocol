# RPC Priority Protocol — RFC index

This directory contains the formal specifications of the RPC Priority Protocol — a triple of complementary subprotocols built on top of the [x402 HTTP payment standard](https://x402.org). Together they define how an HTTP gateway (Shield) gates Solana RPC traffic by payment, applies reputation-based discounts, and cooperates with the upstream node operator's scheduler when the operator chooses to participate.

## The 3 specs

| Spec | Layer | Audience |
|---|---|---|
| [**x402-priority**](./x402-priority.md) | Wire protocol — 402 challenge + signed retry | RPC node operators, SDK implementers |
| [**x402-trust-score**](./x402-trust-score.md) | Reputation aggregator across operators | Trust-Score brokers, multi-provider clients |
| [**x402-qos-cooperative**](./x402-qos-cooperative.md) | Operator-side priority hint | RPC node operators with custom scheduling |

## Reading order

Read **x402-priority** first — it's the wire protocol every implementer must support. **x402-trust-score** and **x402-qos-cooperative** are independent extensions and can be read in either order.

## Status

| Spec | Version | Status | Open for comments until |
|---|---|---|---|
| x402-priority | v1.0 | DRAFT | 2026-06-30 |
| x402-trust-score | v0.1 | DRAFT | 2026-06-30 |
| x402-qos-cooperative | v1.0 | DRAFT | 2026-06-30 |

Comments: open an issue at <https://github.com/flavioparah/x402-priority-protocol/issues>.

## Reference implementation

Mainnet shield in production at `https://api.rpcpriority.com` (operator pubkey `CEH3dGLaYQmYGGwDpszfuBRfcUmBbLNinrSdVdi7k6zp`). Source: this repository's [`index.js`](../../index.js) and [`lib/store.js`](../../lib/store.js).

End-to-end validated 2026-04-29: 38 paid requests on Solana mainnet, Trust-Score progression 0 → 100, 50% discount applied, anti-replay confirmed.

## Versioning

Each spec independently versioned. Wire-level version negotiation via the `X-x402-Spec-Version` header (priority spec only — extensions inherit). Major version bumps signal breaking changes; minor versions are backward-compatible additions.

## Author / maintainer

João Romeiro — CTO, RPC Priority Protocol — `flavio@rpcpriority.com`

## License

The specifications themselves are published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — reuse and adaptation permitted with attribution. The reference implementation source is licensed separately under BUSL-1.1 (see [`LICENSE`](../../LICENSE)).
