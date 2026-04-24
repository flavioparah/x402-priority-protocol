#!/usr/bin/env node
/**
 * examples/trust-progression.js
 *
 * Demonstrates the Trust-Score accumulation: as an agent pays across many
 * requests, its reputation climbs and the Shield's 402 challenges
 * discount the price. Prints a per-request table so the drop is visible.
 *
 * Usage:
 *   Terminal 1:  RPC_LOAD_THRESHOLD=0 npm start
 *   Terminal 2:  node examples/trust-progression.js
 */

const nacl = require("tweetnacl");
const bs58 = require("bs58");

const SHIELD_URL = process.env.SHIELD_URL || "http://localhost:3000";
const N = parseInt(process.env.N || "22", 10);
const METHOD = "getHealth";
const BODY = JSON.stringify({ jsonrpc: "2.0", id: "trust-demo", method: METHOD, params: [] });

const paint = (c, s) => `\x1b[${c}m${s}\x1b[0m`;

async function oneRequest(keypair, pubkey) {
  // 1. Challenge
  const challenge = await fetch(SHIELD_URL + "/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": pubkey },
    body: BODY,
  });
  await challenge.text();
  const base = parseInt(challenge.headers.get("X-x402-Amount-Base") ?? "0", 10);
  const price = parseInt(challenge.headers.get("X-x402-Amount") ?? "0", 10);
  const score = parseInt(challenge.headers.get("X-x402-Trust-Score") ?? "0", 10);
  const nonce = challenge.headers.get("X-x402-Nonce") ?? "";
  const destination = challenge.headers.get("X-x402-Payment-Destination") ?? "";

  // 2. Sign
  const payload = JSON.stringify({ nonce, pubkey, amount: price, destination });
  const msg = Buffer.from(payload, "utf8");
  const sig = nacl.sign.detached(msg, keypair.secretKey);
  const auth = `x402 ${bs58.encode(sig)}.${pubkey}.${bs58.encode(msg)}`;

  // 3. Retry
  const verified = await fetch(SHIELD_URL + "/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-x402-Agent-Pubkey": pubkey,
      Authorization: auth,
    },
    body: BODY,
  });
  const ok = verified.ok;
  await verified.text();

  return { base, price, score, ok };
}

async function main() {
  console.log(paint("1", "x402-shield — Trust-Score progression"));
  console.log(`  shield: ${SHIELD_URL}`);
  console.log(`  N:      ${N} requests\n`);

  const keypair = nacl.sign.keyPair();
  const pubkey = bs58.encode(keypair.publicKey);
  console.log(`  agent:  ${pubkey.slice(0, 16)}…${pubkey.slice(-4)}\n`);

  // Pre-fund
  const maxEstimate = N * 55_000;
  await fetch(SHIELD_URL + "/escrow/deposit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, amount_micro_lamports: maxEstimate }),
  });
  console.log(`  escrow: ${maxEstimate} µL pre-funded\n`);

  const header = ` # │ score │ base price │ paid price │ discount`;
  const sep    = `───┼───────┼────────────┼────────────┼──────────`;
  console.log(paint("1", header));
  console.log(sep);

  let totalBase = 0;
  let totalPaid = 0;

  for (let i = 1; i <= N; i++) {
    const { base, price, score, ok } = await oneRequest(keypair, pubkey);
    if (!ok) throw new Error(`Request ${i} failed`);
    totalBase += base;
    totalPaid += price;
    const discount = base > 0 ? ((1 - price / base) * 100).toFixed(1) + "%" : "–";
    const barWidth = Math.round(score / 5);
    const scoreBar = paint("32", "█".repeat(barWidth)) + "·".repeat(20 - barWidth);
    const row =
      `${String(i).padStart(2)} │ ${String(score).padStart(3)}   │ ` +
      `${String(base).padStart(8)} µL │ ` +
      `${String(price).padStart(8)} µL │ ${discount.padStart(6)}  ${scoreBar}`;
    console.log(row);
  }

  const avgDiscount = ((1 - totalPaid / totalBase) * 100).toFixed(1);
  console.log(sep);
  console.log(`   │       │ ${String(totalBase).padStart(8)} µL │ ${String(totalPaid).padStart(8)} µL │ ${paint("1", avgDiscount + "%")} avg savings`);

  const repRes = await fetch(SHIELD_URL + "/reputation/" + pubkey);
  const rep = await repRes.json();
  console.log(`\nFinal reputation: score=${rep.trust_score}, paid=${rep.paid_count}, total=${rep.total_paid_micro_lamports} µL`);
  console.log(`At full score (20+ payments) the agent pays ${paint("1", "50%")} of base price.`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
