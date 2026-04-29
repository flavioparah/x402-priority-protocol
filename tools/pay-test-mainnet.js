#!/usr/bin/env node
/**
 * tools/pay-test-mainnet.js — End-to-end paid RPC test against api.rpcpriority.com
 * (real Solana mainnet, real SOL).
 *
 * Steps:
 *   1. Load agent keypair from AGENT_SECRET_KEY (base58 of the 64-byte secret).
 *   2. Verify wallet has enough SOL for deposit + tx fee.
 *   3. SystemProgram.transfer DEPOSIT_LAMPORTS to the operator (CEH3...k6zp).
 *   4. POST tx_signature to /escrow/deposit — Shield verifies on-chain and
 *      credits 1000 µL per lamport into agent's escrow.
 *   5. Send a JSON-RPC request without auth → expect 402 with nonce.
 *   6. Sign the challenge payload with the same Ed25519 keypair, retry with
 *      Authorization: x402 <sig>.<pubkey>.<msg> → expect 200 + escrow debit.
 *   7. Print final escrow balance + Trust-Score progression.
 *
 * Usage:
 *   AGENT_SECRET_KEY=<base58> node tools/pay-test-mainnet.js
 *
 * Optional env:
 *   DEPOSIT_LAMPORTS=10000   amount transferred (default 10_000 = 0.00001 SOL)
 *   SKIP_DEPOSIT=1           skip steps 1-3 (use already-credited escrow)
 *   RPC_METHOD=getBalance    JSON-RPC method to test (default getBalance)
 *   SHIELD_URL=...           override (default api.rpcpriority.com)
 *   RPC_URL=...              upstream RPC for the on-chain tx (default mainnet-beta)
 *
 * Where to get AGENT_SECRET_KEY:
 *   - Phantom: Settings → Show secret recovery phrase isn't usable directly;
 *     instead use a wallet that exports the 64-byte secret in base58 (Solflare,
 *     Backpack do this), or derive via solana-keygen.
 *   - solana-keygen new --outfile /tmp/test-key.json
 *     then: node -e "const fs=require('fs'),bs58=require('bs58');console.log(bs58.encode(Buffer.from(JSON.parse(fs.readFileSync('/tmp/test-key.json')))))"
 *   - If you only have a Uint8Array/JSON of the 64-byte secret, base58-encode it.
 */

const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const nacl = require("tweetnacl");
const bs58 = require("bs58");

const SHIELD_URL = process.env.SHIELD_URL || "https://api.rpcpriority.com";
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const OPERATOR = "CEH3dGLaYQmYGGwDpszfuBRfcUmBbLNinrSdVdi7k6zp";
const DEPOSIT_LAMPORTS = parseInt(process.env.DEPOSIT_LAMPORTS || "10000", 10);

const SECRET = process.env.AGENT_SECRET_KEY;
if (!SECRET) {
  console.error("Error: AGENT_SECRET_KEY env var required (base58 of 64-byte secret).");
  process.exit(1);
}
const SKIP_DEPOSIT = process.env.SKIP_DEPOSIT === "1";
const RPC_METHOD = process.env.RPC_METHOD || "getBalance";

const paint = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const ok = (m) => console.log(`  ${paint("32", "✓")} ${m}`);
const warn = (m) => console.log(`  ${paint("33", "!")} ${m}`);
const step = (n, t) => console.log(`\n${paint("1;36", `── ${n} ─`)} ${paint("1", t)}`);

async function main() {
  console.log(paint("1", "\nx402 mainnet end-to-end test"));
  console.log(`  shield:    ${SHIELD_URL}`);
  console.log(`  rpc:       ${RPC_URL}`);
  console.log(`  operator:  ${OPERATOR}`);
  console.log(`  deposit:   ${DEPOSIT_LAMPORTS} lamports (${DEPOSIT_LAMPORTS / LAMPORTS_PER_SOL} SOL)`);

  const me = Keypair.fromSecretKey(bs58.decode(SECRET));
  const myPubB58 = me.publicKey.toBase58();
  console.log(`  agent:     ${myPubB58}`);
  if (SKIP_DEPOSIT) console.log(`  ${paint("33", "[SKIP_DEPOSIT=1]")} steps 1-3 skipped`);

  if (!SKIP_DEPOSIT) {
    const conn = new Connection(RPC_URL, "confirmed");

    step(1, "Wallet balance check");
    const myBalance = await conn.getBalance(me.publicKey);
    console.log(`  balance: ${myBalance} lamports (${myBalance / LAMPORTS_PER_SOL} SOL)`);
    if (myBalance < DEPOSIT_LAMPORTS + 5000) {
      console.error(`Need at least ${DEPOSIT_LAMPORTS + 5000} lamports (${DEPOSIT_LAMPORTS} for deposit + ~5000 for fee).`);
      process.exit(1);
    }
    ok("balance sufficient");

    step(2, "On-chain transfer to operator");
    const dest = new PublicKey(OPERATOR);
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: me.publicKey, toPubkey: dest, lamports: DEPOSIT_LAMPORTS,
    }));
    const txSig = await sendAndConfirmTransaction(conn, tx, [me], { commitment: "confirmed" });
    ok(`tx confirmed — ${txSig}`);
    console.log(`  https://explorer.solana.com/tx/${txSig}`);

    step(3, "Posting signature to Shield /escrow/deposit");
    const dep = await fetch(`${SHIELD_URL}/escrow/deposit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_signature: txSig }),
    });
    if (!dep.ok) {
      console.error(`Shield rejected: ${dep.status} ${await dep.text()}`);
      process.exit(2);
    }
    const depJson = await dep.json();
    ok(`shield credited ${depJson.credited_micro_lamports} µL  (escrow balance: ${depJson.balance})`);
  }

  step(4, `First RPC request (${RPC_METHOD}) — expect 402`);
  const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: RPC_METHOD, params: RPC_METHOD === "getBalance" ? [myPubB58] : [] });
  const r1 = await fetch(`${SHIELD_URL}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": myPubB58 },
    body: rpcBody,
  });
  if (r1.status !== 402) {
    warn(`expected 402, got ${r1.status}`);
    console.log(`  body: ${(await r1.text()).slice(0, 200)}`);
    process.exit(3);
  }
  const ch = await r1.json();
  ok(`402 received  amount=${ch.payment.amount_micro_lamports} µL  nonce=${ch.payment.nonce.slice(0, 12)}…  trust=${ch.payment.trust_score}`);

  step(5, "Sign nonce + retry with payment proof");
  const payload = JSON.stringify({
    nonce: ch.payment.nonce, pubkey: myPubB58,
    amount: ch.payment.amount_micro_lamports, destination: ch.payment.destination,
  });
  const msg = Buffer.from(payload, "utf8");
  const sig = nacl.sign.detached(msg, me.secretKey);
  const auth = `x402 ${bs58.encode(sig)}.${myPubB58}.${bs58.encode(msg)}`;

  const r2 = await fetch(`${SHIELD_URL}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": auth },
    body: rpcBody,
  });
  if (!r2.ok) {
    console.error(`retry failed: ${r2.status} ${await r2.text()}`);
    process.exit(4);
  }
  const result = await r2.json();
  ok(`rpc response: ${JSON.stringify(result).slice(0, 150)}${JSON.stringify(result).length > 150 ? "…" : ""}`);

  step(6, "Final escrow balance + trust score");
  const [bal, rep] = await Promise.all([
    fetch(`${SHIELD_URL}/escrow/balance/${myPubB58}`).then((r) => r.json()),
    fetch(`${SHIELD_URL}/reputation/${myPubB58}`).then((r) => r.json()),
  ]);
  ok(`escrow remaining: ${bal.balance_micro_lamports} µL`);
  ok(`trust score:      ${rep.trust_score}/100  (${rep.current_discount_percent}% off next request)`);
  ok(`paid count:       ${rep.paid_count}`);
  ok(`total paid:       ${rep.total_paid_micro_lamports} µL`);

  console.log(paint("32", "\n✓ END-TO-END PASSED — operator received real SOL on mainnet"));
  console.log(`  https://explorer.solana.com/address/${OPERATOR}`);
}

main().catch((e) => {
  console.error(paint("31", `\nFailed: ${e.message}`));
  if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
});
