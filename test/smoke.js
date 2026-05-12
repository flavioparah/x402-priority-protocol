#!/usr/bin/env node
/**
 * test/smoke.js — End-to-end smoke test for the SDK + Shield contract.
 *
 * This is the regression guard for the @solana/web3.js internal contract
 * the SDK depends on (we override `_rpcRequest` as an instance property
 * after super() — see D-005 in docs/ENGINEERING.md). Any web3.js upgrade
 * that moves or renames that hook will cause `rpc.getSlot()` below to
 * bypass our interception, fail, and fail this test.
 *
 * Requires:
 *   - A Shield running at $SHIELD_URL (default http://localhost:3000),
 *     preferably with RPC_LOAD_THRESHOLD=0 to force 402 on every call
 *     and ESCROW_TRUST_DEPOSITS=1 (smoke uses the trusted shortcut to
 *     stay self-contained; the verified on-chain path is covered by
 *     examples/deposit-with-tx.js against real devnet).
 *   - Compiled SDK in dist/ (run `npm run build` first).
 *
 * Exits 0 on pass, non-zero on any failure.
 */

const { X402Provider } = require("../dist/x402-client-sdk");
const { Keypair } = require("@solana/web3.js");

const SHIELD_URL = process.env.SHIELD_URL || "http://localhost:3000";

function ok(msg) { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg) { console.error(`\x1b[31m✗\x1b[0m ${msg}`); }

async function main() {
  const kp = Keypair.generate();
  const rpc = new X402Provider(SHIELD_URL + "/rpc", kp, {
    priorityBudget: 5_000_000,
    settlementMode: "offchain",
  });

  // 1. Escrow pre-funding (5M µL = 5× MAX_PRICE; covers worst-case challenge under 20× pricing tier)
  const before = await rpc.depositEscrowTrusted(SHIELD_URL, 5_000_000);
  if (before < 5_000_000) throw new Error(`deposit returned balance ${before}, expected >= 5000000`);
  ok(`escrow credited — balance ${before} µL`);

  // 2. Connection method routing through the _rpcRequest override.
  //    If web3.js ever changes how getSlot dispatches internally, this call
  //    will either hit a 402 (response un-handled by web3.js, superstruct
  //    throws) or skip the Shield entirely. Either way, this assertion
  //    fails loudly.
  const slot = await rpc.getSlot();
  if (typeof slot !== "number" || slot <= 0) {
    throw new Error(`rpc.getSlot() returned ${typeof slot} ${slot}, expected positive number`);
  }
  ok(`rpc.getSlot() returned slot ${slot} (Connection path intercepted)`);

  // 3. Explicit escape hatch
  const health = await rpc.request("getHealth", []);
  if (!health || health.result !== "ok") {
    throw new Error(`rpc.request('getHealth', []) unexpected body: ${JSON.stringify(health)}`);
  }
  ok(`rpc.request('getHealth', []) returned ${health.result} (escape hatch works)`);

  // 4. Escrow must have been debited — proves the 402 handshake ran twice
  //    and the signatures were verified.
  const after = await rpc.getEscrowBalance(SHIELD_URL);
  if (after >= before) {
    throw new Error(`escrow not debited: before=${before}, after=${after}`);
  }
  ok(`escrow debited ${before - after} µL across 2 requests`);

  // 5. Trust-Score header must be advertised on 402 responses.
  //    Prove it by making a raw POST that guarantees a 402 back.
  const pubkey = kp.publicKey.toBase58();
  const raw = await fetch(SHIELD_URL + "/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": pubkey },
    body: JSON.stringify({ jsonrpc: "2.0", id: "smoke", method: "getHealth", params: [] }),
  });
  if (raw.status !== 402) {
    throw new Error(`expected 402 on raw POST, got ${raw.status} (is RPC_LOAD_THRESHOLD=0?)`);
  }
  const trustHdr = raw.headers.get("X-x402-Trust-Score");
  if (trustHdr === null) {
    throw new Error("X-x402-Trust-Score header missing — Shield may predate Trust-Score support");
  }
  const trustScore = parseInt(trustHdr, 10);
  if (!(trustScore >= 10)) {
    throw new Error(`expected trust score >= 10 after 2 payments, got ${trustScore}`);
  }
  ok(`X-x402-Trust-Score: ${trustScore} (reputation accumulated from prior payments)`);

  // 6. /reputation/:pubkey inspector endpoint.
  const repRes = await fetch(SHIELD_URL + "/reputation/" + pubkey);
  const rep = await repRes.json();
  if (rep.paid_count < 2 || rep.trust_score !== trustScore) {
    throw new Error(`reputation endpoint mismatch: ${JSON.stringify(rep)}`);
  }
  ok(`/reputation/${pubkey.slice(0,8)}… reports paidCount=${rep.paid_count} score=${rep.trust_score}`);

  console.log("\n\x1b[32mSMOKE PASSED\x1b[0m");
}

main().catch((err) => {
  fail(err.message);
  console.error(`\nIs the Shield running at ${SHIELD_URL}?`);
  console.error(`  RPC_LOAD_THRESHOLD=0 npm start`);
  console.error(`Is the SDK built?`);
  console.error(`  npm run build`);
  process.exit(1);
});
