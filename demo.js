#!/usr/bin/env node
/**
 * demo.js — End-to-end x402-shield handshake demonstration
 *
 * Runs the complete 5-step protocol against a local Shield:
 *   1. Generate Ed25519 agent keypair
 *   2. Pre-fund the agent's escrow on the Shield (trusted shortcut)
 *   3. Send a JSON-RPC request (expect 402 under load)
 *   4. Verify budget, sign the challenge payload
 *   5. Retry with Authorization: x402 <sig>.<pubkey>.<msg>
 *
 * Usage:
 *   Terminal 1:  RPC_LOAD_THRESHOLD=0 ESCROW_TRUST_DEPOSITS=1 npm start
 *   Terminal 2:  node demo.js                         # or: npm run demo
 *
 * NB: uses /escrow/deposit-trusted (no on-chain tx) so the demo is
 * fast and deterministic. For the real verified-deposit flow, see
 * examples/deposit-with-tx.js.
 *
 * Requires Node 18+ (native fetch).
 */

const nacl = require("tweetnacl");
const bs58 = require("bs58");

const SHIELD_URL = process.env.SHIELD_URL || "http://localhost:3000";
const ESCROW_AMOUNT = parseInt(process.env.DEMO_ESCROW || "100000", 10);     // µL pre-deposited
const PRIORITY_BUDGET = parseInt(process.env.DEMO_BUDGET || "50000", 10);    // µL max per request
const RPC_METHOD = process.env.DEMO_METHOD || "getHealth";

// ─── Pretty logs ─────────────────────────────────────────────────────────────

const paint = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const c = {
  step: (n, m) => console.log(`\n${paint("1;36", `── Step ${n} ─`)} ${paint("1", m)}`),
  agent: (m) => console.log(`  ${paint("36", "[Agent]")}  ${m}`),
  shield: (m) => console.log(`  ${paint("33", "[Shield]")} ${m}`),
  ok: (m) => console.log(`  ${paint("32", "✓")} ${m}`),
  warn: (m) => console.log(`  ${paint("33", "!")} ${m}`),
  err: (m) => console.log(`  ${paint("31", "✗")} ${m}`),
};

// ─── Main flow ───────────────────────────────────────────────────────────────

async function main() {
  console.log(paint("1", "\nx402-shield — end-to-end handshake demo"));
  console.log(`  shield:  ${SHIELD_URL}`);
  console.log(`  method:  ${RPC_METHOD}`);

  // 1. Generate keypair
  c.step(1, "Generating agent keypair");
  const keypair = nacl.sign.keyPair();
  const pubkeyB58 = bs58.encode(keypair.publicKey);
  c.agent(`pubkey: ${pubkeyB58.slice(0, 12)}…${pubkeyB58.slice(-4)}`);

  // 2. Pre-fund escrow
  c.step(2, "Pre-funding escrow");
  const deposit = await postJson(`${SHIELD_URL}/escrow/deposit-trusted`, {
    pubkey: pubkeyB58,
    amount_micro_lamports: ESCROW_AMOUNT,
  });
  c.shield(`escrow credited — balance: ${deposit.balance} µL`);

  // 3. First request — expect 402
  c.step(3, "Sending RPC request without payment");
  const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: RPC_METHOD, params: [] });
  const tGateStart = performance.now();
  const first = await fetch(`${SHIELD_URL}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rpcBody,
  });

  if (first.status !== 402) {
    c.warn(`Shield returned ${first.status} (load below threshold)`);
    const data = await first.json().catch(() => ({}));
    c.agent(`RPC response: ${truncateJson(data)}`);
    c.warn("Restart the Shield with RPC_LOAD_THRESHOLD=0 to force 402 on every request.");
    return;
  }

  const challenge = {
    destination: first.headers.get("X-x402-Payment-Destination"),
    amount: parseInt(first.headers.get("X-x402-Amount"), 10),
    nonce: first.headers.get("X-x402-Nonce"),
    ttl: parseInt(first.headers.get("X-x402-Nonce-TTL"), 10),
  };
  c.shield(`402 Payment Required issued`);
  c.agent(`challenge — amount=${challenge.amount} µL  nonce=${challenge.nonce.slice(0, 10)}…  ttl=${challenge.ttl}s`);

  // 4. Budget check + sign
  c.step(4, "Evaluating budget & signing payload");
  if (challenge.amount > PRIORITY_BUDGET) {
    c.err(`amount ${challenge.amount} > budget ${PRIORITY_BUDGET} — aborting`);
    process.exit(2);
  }
  c.ok(`budget check: ${challenge.amount} ≤ ${PRIORITY_BUDGET}`);

  const payload = JSON.stringify({
    nonce: challenge.nonce,
    pubkey: pubkeyB58,
    amount: challenge.amount,
    destination: challenge.destination,
  });
  const messageBytes = Buffer.from(payload, "utf8");
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  const authToken = [bs58.encode(signature), pubkeyB58, bs58.encode(messageBytes)].join(".");
  c.agent(`signed ${messageBytes.length}-byte payload with Ed25519`);
  c.agent(`auth header: x402 ${authToken.slice(0, 28)}…`);

  // 5. Retry with proof
  c.step(5, "Retrying with payment proof");
  const tRetryStart = performance.now();
  const second = await fetch(`${SHIELD_URL}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `x402 ${authToken}`,
    },
    body: rpcBody,
  });
  const tRetryEnd = performance.now();

  if (!second.ok) {
    const body = await second.text();
    c.err(`Shield rejected proof — ${second.status}: ${body.slice(0, 200)}`);
    process.exit(3);
  }

  const result = await second.json();
  c.shield(`signature verified — escrow debited ${challenge.amount} µL`);
  c.agent(`RPC response: ${truncateJson(result)}`);

  // Balance after
  const balance = await (await fetch(`${SHIELD_URL}/escrow/balance/${pubkeyB58}`)).json();
  c.shield(`remaining balance: ${balance.balance_micro_lamports} µL  (started with ${ESCROW_AMOUNT})`);

  // Timing summary
  const overheadFirst = tRetryStart - tGateStart;      // 402 round-trip
  const overheadRetry = tRetryEnd - tRetryStart;       // signed retry round-trip
  const total = tRetryEnd - tGateStart;
  console.log(`\n${paint("1", "── Timing ─")}`);
  console.log(`  402 challenge round-trip:   ${overheadFirst.toFixed(1)} ms`);
  console.log(`  signed retry round-trip:    ${overheadRetry.toFixed(1)} ms`);
  console.log(`  ${paint("1", `total handshake overhead:   ${total.toFixed(1)} ms`)}`);
  console.log(`  KPI target (< 50 ms p95):   ${total < 50 ? paint("32", "✓ pass") : paint("33", "above target on single sample")}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${await res.text()}`);
  return res.json();
}

function truncateJson(obj) {
  const s = JSON.stringify(obj);
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`\n${paint("31", "Demo failed:")} ${err.message}`);
  process.exit(1);
});
