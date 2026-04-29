#!/usr/bin/env node
/**
 * tools/test-all-rpc-methods.js — Coverage test for the 4 RPC methods exposed
 * in /try.html's dropdown (getHealth, getBalance, getAccountInfo,
 * getProgramAccounts). Sends each through api.rpcpriority.com using proper
 * params (filling the agent's own pubkey where needed), signs the 402
 * challenge, and reports whether the upstream RPC returned a real result
 * or rejected the params.
 *
 *   AGENT_SECRET_KEY=<base58> node tools/test-all-rpc-methods.js
 */

const { Keypair } = require("@solana/web3.js");
const nacl = require("tweetnacl");
const bs58 = require("bs58");

const SHIELD = process.env.SHIELD_URL || "https://api.rpcpriority.com";
const SECRET = process.env.AGENT_SECRET_KEY;
if (!SECRET) { console.error("AGENT_SECRET_KEY env var required"); process.exit(1); }

const me = Keypair.fromSecretKey(bs58.decode(SECRET));
const myPub = me.publicKey.toBase58();

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const TESTS = [
  { label: "getHealth",                 method: "getHealth",          params: [] },
  { label: "getBalance(agent)",         method: "getBalance",         params: [myPub] },
  { label: "getAccountInfo(agent)",     method: "getAccountInfo",     params: [myPub, { encoding: "base64" }] },
  { label: "getProgramAccounts(System)",method: "getProgramAccounts", params: [SYSTEM_PROGRAM, { encoding: "base64", filters: [{ dataSize: 0 }] }] },
];

async function runOne({ label, method, params }) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

  const r1 = await fetch(`${SHIELD}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": myPub },
    body,
  });
  if (r1.status !== 402) {
    return { label, phase: "challenge", verdict: "NO_402", code: r1.status, detail: (await r1.text()).slice(0, 100) };
  }
  const ch = await r1.json();
  const amount = ch.payment.amount_micro_lamports;
  const nonce = ch.payment.nonce;

  const payload = JSON.stringify({ nonce, pubkey: myPub, amount, destination: ch.payment.destination });
  const msg = Buffer.from(payload, "utf8");
  const sig = nacl.sign.detached(msg, me.secretKey);
  const auth = `x402 ${bs58.encode(sig)}.${myPub}.${bs58.encode(msg)}`;

  const r2 = await fetch(`${SHIELD}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": auth },
    body,
  });

  let parsed;
  try { parsed = await r2.json(); } catch { parsed = { error: { message: `non-json ${r2.status}` } }; }

  if (parsed.error) {
    return { label, phase: "upstream", verdict: "UPSTREAM_ERROR", code: r2.status, amount, detail: (parsed.error.message || JSON.stringify(parsed.error)).slice(0, 120) };
  }
  if (parsed.result !== undefined) {
    return { label, phase: "ok", verdict: "OK", code: r2.status, amount, detail: JSON.stringify(parsed.result).slice(0, 100) };
  }
  return { label, phase: "?", verdict: "UNEXPECTED", code: r2.status, amount, detail: JSON.stringify(parsed).slice(0, 100) };
}

(async () => {
  console.log(`\nRPC method coverage  shield=${SHIELD}`);
  console.log(`agent=${myPub}\n`);
  console.log("  status                 method                            cost (µL)   detail");
  console.log("  --------------------   ------------------------------   -----------  --------------------------------------");
  for (const t of TESTS) {
    const r = await runOne(t);
    const tag = r.verdict === "OK" ? "\x1b[32m✓ OK\x1b[0m" : r.verdict === "UPSTREAM_ERROR" ? "\x1b[33m! UPSTREAM_ERR\x1b[0m" : `\x1b[31m✗ ${r.verdict}\x1b[0m`;
    console.log(`  ${tag.padEnd(36)}  ${r.label.padEnd(32)}  ${String(r.amount || "-").padStart(11)}  ${r.detail || ""}`);
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
