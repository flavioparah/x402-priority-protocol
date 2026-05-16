# Agent Quickstart — x402-shield

> **For:** AI-agent developers, SDK users, and HTTP clients that need to pay x402 challenges to access Solana RPC.
> **Time to first paid request:** ~10 minutes from `npm install` to a successful 402 → 200 round-trip.
> **Companion:** [`docs/OPERATOR-QUICKSTART.md`](./OPERATOR-QUICKSTART.md) for the operator side.

---

## 1. Who this is for

You're writing code (an agent, indexer, MEV bot, or any HTTP client) that calls a Solana RPC and you want it to keep working when that RPC is under load and starts returning `HTTP 402 Payment Required`.

## 2. The 5-minute path

The entire flow, as one Node.js block. Run it against the devnet shield and it works without spending real SOL.

```js
// npm install @solana/web3.js tweetnacl bs58
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { Keypair, Connection, SystemProgram, Transaction,
        sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");

const SHIELD_URL = "https://devnet.rpcpriority.com";        // production-grade devnet
const SOLANA_RPC = "https://api.devnet.solana.com";
const RPC_BODY   = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] });

// 1. Keypair (Solana convention: Ed25519, 64-byte secret)
const agent  = Keypair.generate();
const pubkey = agent.publicKey.toBase58();

// 2. Fund the agent + escrow with an on-chain transfer (devnet)
const conn = new Connection(SOLANA_RPC, "confirmed");
await conn.requestAirdrop(agent.publicKey, 0.01 * LAMPORTS_PER_SOL)
          .then((s) => conn.confirmTransaction(s, "confirmed"));

const info = await (await fetch(SHIELD_URL + "/info")).json();   // → operator_pubkey
const destination = new (require("@solana/web3.js").PublicKey)(info.operator_pubkey);
const tx = new Transaction().add(SystemProgram.transfer({
  fromPubkey: agent.publicKey, toPubkey: destination, lamports: 100,
}));
const sig = await sendAndConfirmTransaction(conn, tx, [agent], { commitment: "confirmed" });
await fetch(SHIELD_URL + "/escrow/deposit", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tx_signature: sig }),
});   // 100 lamports → 100_000 µL credited to your pubkey

// 3. Make the request
let r = await fetch(SHIELD_URL + "/rpc", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": pubkey },
  body: RPC_BODY,
});

// 4. Handle 402
if (r.status === 402) {
  const nonce       = r.headers.get("X-x402-Nonce");
  const amount      = parseInt(r.headers.get("X-x402-Amount"), 10);
  const destinationStr = r.headers.get("X-x402-Payment-Destination");

  // 5. Sign the canonical payload with the Ed25519 secret
  const payload = JSON.stringify({ nonce, pubkey, amount, destination: destinationStr });
  const msgBytes = Buffer.from(payload, "utf8");
  const signature = nacl.sign.detached(msgBytes, agent.secretKey);
  const auth = `x402 ${bs58.encode(signature)}.${pubkey}.${bs58.encode(msgBytes)}`;

  // 6. Retry
  r = await fetch(SHIELD_URL + "/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json",
               "X-x402-Agent-Pubkey": pubkey,
               Authorization: auth },
    body: RPC_BODY,
  });
}
console.log(r.status, await r.json());   // → 200 + the upstream RPC result
```

That's the whole protocol. The rest of this doc breaks it down.

## 3. What x402 actually is

[x402](https://x402.org) is an HTTP payment standard (Coinbase, 2024–2025) that uses the long-dormant **HTTP 402 Payment Required** status code as a real, machine-paid handshake. **x402-priority** is its Solana subprotocol for RPC priority — sign a nonce with your Ed25519 wallet, debit a pre-funded escrow, get through. Full wire spec: [`docs/rfc/x402-priority.md`](./rfc/x402-priority.md).

## 4. Prerequisites

- **A Solana wallet** with some SOL: real SOL on mainnet, faucet SOL on devnet (`solana airdrop 1` or `https://faucet.solana.com`).
- **A shield endpoint URL** — pick one from §8 below.
- **An HTTP client** in your language of choice. The protocol needs only: HTTP, JSON, Ed25519 signing, base58 encoding. JS examples below; the same flow works in Python, Go, Rust, anywhere.

## 5. Step-by-step

### 5.1 Get an Ed25519 keypair

Solana wallets are Ed25519 keypairs. The same keypair you'd use to send a `SystemProgram.transfer` is the one that signs x402 challenges.

```js
const { Keypair } = require("@solana/web3.js");
const agent = Keypair.generate();
console.log(agent.publicKey.toBase58());       // your "pubkey" (base58, 32 bytes)
console.log(agent.secretKey.length);           // 64 — full Ed25519 secret
```

Persist `agent.secretKey` (a `Uint8Array`) somewhere safe. Lose it and you lose the escrow balance bound to that pubkey.

For pre-existing keypairs in `solana-keygen` JSON format, load via `Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(...))))`. From a base58 secret: `Keypair.fromSecretKey(bs58.decode(secretBs58))`.

### 5.2 Fund the escrow

The Shield only debits escrow that you've **pre-funded**. There are two paths:

- **Verified on-chain (production):** send a `SystemProgram.transfer` to the Shield's `PAYMENT_DESTINATION`, then `POST /escrow/deposit { "tx_signature": "<base58>" }`. The Shield fetches the tx, verifies sender + destination + amount, and credits at **1 lamport = 1000 µ-lamports**. Single-use — the same `tx_signature` cannot be deposited twice. Full worked example in [`examples/deposit-with-tx.js`](../examples/deposit-with-tx.js).

  ```js
  // Five lines that matter:
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: agent.publicKey, toPubkey: destination, lamports: 100,
  }));
  const sig = await sendAndConfirmTransaction(conn, tx, [agent], { commitment: "confirmed" });
  await fetch(SHIELD_URL + "/escrow/deposit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_signature: sig }),
  });
  ```

- **Trusted (demo only):** `POST /escrow/deposit-trusted { "pubkey", "amount_micro_lamports" }` — no on-chain check. Mounts only when the operator runs with `ESCROW_TRUST_DEPOSITS=1`. Use this against the demo deployment (e.g. for the Trust-Score progression) but **never** in production.

Check your balance any time:

```bash
curl -s https://devnet.rpcpriority.com/escrow/balance/<your_pubkey> | jq
# { "pubkey": "...", "balance_micro_lamports": 100000 }
```

### 5.3 Make a regular RPC request

If the upstream node is under its load threshold, your request passes through transparently. No signing, no payment.

```js
const r = await fetch(SHIELD_URL + "/rpc", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-x402-Agent-Pubkey": pubkey,    // optional — claims your Trust-Score discount
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
});
```

`X-x402-Agent-Pubkey` is **optional but recommended**. If you send it on the initial request and the Shield gates you, the issued nonce binds to that pubkey and applies any Trust-Score discount you've earned (§6). Send a different pubkey at retry time and you'll get `pubkey_hint_mismatch`.

### 5.4 Handle the 402 response

```js
if (r.status === 402) {
  const nonce       = r.headers.get("X-x402-Nonce");                // 32-hex-char single-use token
  const amount      = parseInt(r.headers.get("X-x402-Amount"), 10); // µ-lamports (final, after discount)
  const amountBase  = parseInt(r.headers.get("X-x402-Amount-Base"), 10); // pre-discount
  const trustScore  = parseInt(r.headers.get("X-x402-Trust-Score"), 10); // 0–100
  const nonceTtl    = parseInt(r.headers.get("X-x402-Nonce-TTL"), 10);   // seconds (default 30)
  const destination = r.headers.get("X-x402-Payment-Destination");       // base58 pubkey
}
```

The response body has the same fields under `body.payment.*` — use whichever you prefer, but headers are easier to parse and resilient to body corruption by intermediate proxies.

You have `nonceTtl` seconds to sign and retry. After that, the nonce expires and you'll need to make a fresh request to get a new one.

### 5.5 Sign the challenge

The canonical payload is a JSON object with **fixed key order** (`nonce, pubkey, amount, destination`), serialized with `JSON.stringify`, and signed over its UTF-8 bytes with Ed25519.

```js
const nacl = require("tweetnacl");
const bs58 = require("bs58");

const payload = JSON.stringify({ nonce, pubkey, amount, destination });
const msgBytes  = Buffer.from(payload, "utf8");
const signature = nacl.sign.detached(msgBytes, agent.secretKey);   // 64-byte Ed25519 sig
```

`@solana/web3.js` exposes the same primitive via `nacl.sign.detached(msg, secretKey)` — `tweetnacl` is the underlying library Solana web3 uses. Pick either.

### 5.6 Retry with the Authorization header

The header is three base58-encoded components joined by `.`:

```
Authorization: x402 <bs58(signature)>.<bs58(pubkey)>.<bs58(utf8(payload)))>
```

```js
const auth = `x402 ${bs58.encode(signature)}.${pubkey}.${bs58.encode(msgBytes)}`;

const r2 = await fetch(SHIELD_URL + "/rpc", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-x402-Agent-Pubkey": pubkey,   // must match the pubkey you hinted in 5.3 (if any)
    Authorization: auth,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
});
console.log(r2.status);   // 200 — the upstream RPC response is in the body
```

The Shield verifies the signature, atomically marks the nonce consumed + debits your escrow, and forwards the original RPC call upstream. The response body is the **upstream RPC's response** verbatim.

### 5.7 (Optional) Check your reputation

```bash
curl -s https://devnet.rpcpriority.com/reputation/<your_pubkey> | jq
# {
#   "pubkey": "...",
#   "trust_score": 47,
#   "paid_count": 12,
#   "total_paid_micro_lamports": 250000,
#   "sybil_risk": null,
#   "fraud_flags": [],
#   "churn_pattern": null
# }
```

## 6. Trust progression

Each paid request bumps your Trust-Score. Higher score = larger discount applied to future challenges (capped at 50% off; floored at `BASE_PRICE`).

The discount formula (from [`docs/rfc/x402-priority.md`](./rfc/x402-priority.md) §3.3):

```
final_amount = max(BASE_PRICE, round(amount * (1 - score / 200)))
```

Working demo in [`examples/trust-progression.js`](../examples/trust-progression.js) — 22 requests, ~26 % average savings as score climbs from 0 to ~100:

```bash
SHIELD_URL=https://devnet.rpcpriority.com node examples/trust-progression.js
```

Full reputation spec: [`docs/rfc/x402-trust-score.md`](./rfc/x402-trust-score.md).

## 7. Error codes

The Shield emits a closed vocabulary of `X-x402-Reason` values when it rejects a request. The full set (from [`lib/abuse-reasons.js`](../lib/abuse-reasons.js)):

| `X-x402-Reason` | What it means | What to do |
|---|---|---|
| `ip-rate-limit` | Too many requests from your IP in the window | Back off and retry. Consider rotating egress or paying earlier. |
| `pubkey-rate-limit` | Too many requests from your pubkey | Back off; reduce parallelism per agent. |
| `global-rate-limit` | Shield-wide cap hit (operator-side overload) | Retry with backoff; the cap recovers quickly. |
| `invalid-signature-burst` | Multiple bad signatures from your pubkey/IP in a short window — looks like a probe | Audit your signing code; the burst pattern triggers temporary enforcement. |
| `nonce-replay` | You presented the same nonce twice (or after it was already consumed by a parallel request) | Get a fresh nonce by making a new request — never retry with a used nonce. |
| `pubkey-hint-mismatch` | The pubkey in the signed payload (or `X-x402-Agent-Pubkey`) doesn't match the pubkey the nonce was issued to | Sign with the same key you hinted. Omit `X-x402-Agent-Pubkey` if you're not sure. |
| `wash-payment` | Your payment pattern looks self-dealing (paying yourself round-trip) | Stop. This is detected and counts against your reputation. |
| `coordinated-burst` | Your pubkey is part of a cluster firing in lockstep | Reduce coordination across agents you control, or split into independent sessions. |
| `dormant-revival` | Your pubkey was inactive for a long time, then woke up with a burst | Wait, or warm up gradually — sudden activity from dormant accounts looks like compromised credentials. |
| `deposit-signature-invalid` | `tx_signature` you posted doesn't decode or doesn't exist on-chain | Confirm the tx finalized; check you posted the right signature. |
| `deposit-amount-mismatch` | The on-chain transfer doesn't match the destination / sender the Shield expects | Send the transfer to the exact `PAYMENT_DESTINATION` from `/info`. |
| `body-too-large` | Your `/rpc` JSON body exceeds the per-route limit (default 32 KB) | Chunk the request; the Shield rejects oversized bodies at the edge. |
| `malformed-payload` | Authorization header doesn't have exactly 3 base58 parts, or the payload isn't valid JSON | Audit the signing code. The three components must be `bs58(sig).bs58(pubkey).bs58(utf8(payload))`. |

For 402 responses themselves, the response body always includes a fresh nonce so you can immediately re-sign and retry — no need for a separate request.

## 8. Live endpoints

| URL | Network | Notes |
|---|---|---|
| `https://api.rpcpriority.com` | **Mainnet** | Production. Real SOL. Deposits verified on-chain. Canonical hostname. |
| `https://mainnet.rpcpriority.com` | Mainnet | Alias for the canonical hostname above. |
| `https://devnet.rpcpriority.com` | Devnet | Test network. Faucet SOL. Deposits verified on-chain against devnet. |
| `https://app.rpcpriority.com/try` | n/a | Browser-based "try it" console — fires real requests against the devnet/mainnet shields and shows the 402 → sign → 200 flow live. |

Sanity-check any of them:

```bash
curl -s https://devnet.rpcpriority.com/info | jq
curl -s https://api.rpcpriority.com/health | jq
```

For a deeper integration reference, the TypeScript SDK in [`x402-client-sdk.ts`](../x402-client-sdk.ts) extends `@solana/web3.js` `Connection` so an existing codebase only swaps the constructor — 402 challenges are handled transparently.
