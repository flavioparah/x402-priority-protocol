# x402-shield

**HTTP 402 priority gate for Solana RPC nodes.** Turn spam defense into revenue. Give paying agents a fast lane without IP whitelists or API keys.

> *"It's not an error — it's an automated economic negotiation."*

---

## The problem

Public Solana RPC nodes get hammered by spam. The status-quo defense is per-IP rate limiting, which punishes legitimate AI agents that rotate infrastructure (Lambda, containers, cloud bursting). Meanwhile, DDoS is pure cost to the operator — unmonetizable.

## The solution

**x402-shield** is a reverse proxy that sits in front of any Solana RPC and enforces payment-gated priority under load:

1. Agent sends a regular JSON-RPC request.
2. Under load, the shield responds `HTTP 402 Payment Required` with a signed challenge (destination, amount, nonce, TTL).
3. Agent signs the challenge payload with its Ed25519 key — the same key that funds its pre-deposited escrow.
4. Agent retries with `Authorization: x402 <sig>.<pubkey>.<msg>`.
5. Shield verifies signature + nonce + escrow balance, debits the fee, and forwards to the upstream RPC.

Three properties fall out:

- **Sovereign Access** — No API keys, no IP whitelists. Agents are identified cryptographically by their pubkey.
- **Dynamic Backpressure** — Not a binary drop. Price scales with load; under capacity, requests pass for free.
- **Aligned Incentives** — Spam defense becomes revenue. Attackers pay the operator to keep attacking.

---

## Quick start

```bash
git clone https://github.com/flavioparah/x402-priority-protocol.git
cd x402-priority-protocol
npm install

# Start the shield (defaults: port 3000, proxies to mainnet-beta)
REAL_RPC_URL=https://api.devnet.solana.com \
PAYMENT_DESTINATION=YourSolWalletHere \
npm start
```

Hit the proxy without payment — under simulated load you get a 402 challenge:

```bash
curl -i -X POST http://localhost:3000/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'
```

```
HTTP/1.1 402 Payment Required
X-x402-Payment-Destination: YourSolWalletHere
X-x402-Amount: 12500
X-x402-Nonce: a1b2c3d4e5f6...
X-x402-Nonce-TTL: 30
```

Below the load threshold the request passes through transparently to the upstream RPC.

---

## Client SDK

The TypeScript client extends `@solana/web3.js` `Connection` — existing code only needs to swap the constructor:

```ts
import { X402Provider } from './x402-client-sdk';
import { Keypair, PublicKey } from '@solana/web3.js';

const connection = new X402Provider(
  'http://localhost:3000/rpc',
  Keypair.fromSecretKey(/* agent's secret key */),
  {
    priorityBudget: 10_000,      // max µ-lamports the agent will pay per request
    settlementMode: 'offchain',  // or 'onchain' for SystemProgram.transfer
    onChallenge: (c) => c.amount_micro_lamports < 5_000, // approve/veto per-request
  }
);

// Use like any Connection — 402 challenges are handled transparently
const info = await connection.request('getAccountInfo', [publicKey.toBase58()]);
```

On a 402, the SDK parses the challenge, optionally prompts the caller via `onChallenge`, signs the payload, and retries — all invisible to the caller.

---

## Architecture

![Protocol flow](./x402_protocol_architecture.svg)

### Components

| File | Role |
|------|------|
| `index.js` | x402-Shield proxy server (Express + `http-proxy-middleware`) |
| `x402-client-sdk.ts` | `X402Provider extends Connection` — drop-in replacement |
| `x402-guia-implementacao.docx` | Implementation guide (PT-BR) |
| `x402_protocol_architecture.svg` | Protocol flow diagram |

### Settlement modes

| Mode | Latency | Trust model |
|------|---------|-------------|
| `offchain` *(default, MVP)* | Sub-millisecond verification | Agent pre-funds a pubkey-indexed escrow; each request debits via a signed nonce |
| `onchain` | Seconds (confirmation) | Agent sends a `SystemProgram.transfer` and includes the signed tx |

### Anti-replay

Nonces are issued per-challenge, stored in-memory with a 30-second TTL. Consumed nonces are flagged `used` and subsequent presentations are rejected.

---

## Configuration

All configurable via env vars (see `index.js`):

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | Listen port |
| `REAL_RPC_URL` | `https://api.mainnet-beta.solana.com` | Upstream RPC |
| `PAYMENT_DESTINATION` | `YourSolAddressHere` | Node operator's Solana wallet |
| `RPC_LOAD_THRESHOLD` | `0.75` | Load above which 402 gating activates |
| `REQUESTS_PER_IP_LIMIT` | `100` | Per-IP request cap per window |
| `RATE_WINDOW_MS` | `60000` | Per-IP window (ms) |
| `BASE_PRICE` | `1000` | Min µ-lamports per priority request |
| `MAX_PRICE` | `50000` | Max µ-lamports (at full load) |

---

## Status

**This is a hackathon MVP, not production.** Known limitations:

- **In-memory state** — escrow, nonces, and rate counters live in `Map`/`Set`. Use Redis for multi-instance.
- **Unverified deposits** — `POST /escrow/deposit` accepts any amount without confirming an on-chain transfer. Production must verify the deposit tx against the destination wallet.
- **Simulated load metric** — `getRpcLoad()` returns `Math.random() * 0.4 + 0.6` for demo. Wire to Prometheus / node RPC stats before shipping.
- **Single process** — no horizontal scaling yet; escrow state must be shared when scaled.

---

## Roadmap

**Week 1 — MVP (current)**
Off-chain escrow, Ed25519 signed nonces, dynamic pricing, proxy pass-through.

**Week 2 — Trust Score**
`X-x402-Trust-Score` header. Well-behaved recurring agents accumulate score; their per-request price decays. Reputation as a defense against Sybil while preserving pseudonymity.

**Week 3 — Moat**
Open-source protocol spec and reference implementations. Build a network of RPC operator partners (Helius, Triton, Jito) for whom this is a drop-in revenue layer.

---

## KPIs

- **Handshake overhead**: < 50 ms p95 over a plain proxy baseline.
- **Spam economics**: attacker cost ≥ node profit at any sustained rate.
- **Agent success rate under saturation**: ≥ 95 % (paying) vs. < 20 % (non-paying).

---

## Positioning

`x402-shield` operates at the **protocol infrastructure layer** (RPC network).

Existing x402-adjacent projects (MCPay, Latinum) operate at the **application layer** — paying for MCP-exposed services. Both layers are valid, but the RPC layer has the broader blast radius and aligns directly with operators who already monetize priority (Helius, Triton, Jito).

---

## Team

| | Role |
|---|---|
| **Flávio Furtado** | CEO — product & go-to-market |
| **João Romeiro** | CTO — architecture & implementation |
| **Felipe Cardoso** | DPO — blockchain & security |

Built for the [Colosseum Frontier Hackathon](https://arena.colosseum.org/hackathon), April–May 2026.

---

## License

TBD. A permissive OSS license will be published alongside the Week 3 protocol spec release.
