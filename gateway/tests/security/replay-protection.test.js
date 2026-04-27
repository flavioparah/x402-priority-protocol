const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runTest() {
  console.log("--- Starting Replay Protection Tests ---");
  const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3000/rpc";
  const results = { tests: [] };

  const keypair = nacl.sign.keyPair();
  const pubkeyB58 = bs58.encode(keypair.publicKey);

  // Credit escrow
  await fetch(`${GATEWAY_URL.replace("/rpc", "/escrow/deposit-trusted")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: pubkeyB58, amount_micro_lamports: 1000000 })
  });

  async function getChallenge(body) {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": pubkeyB58 },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  function signPayload(challenge, body) {
    const payload = JSON.stringify({
      protocol: "x402-shield",
      network: "mainnet",
      nonce: challenge.payment.nonce,
      pubkey: pubkeyB58,
      amount: challenge.payment.amount_micro_lamports,
      destination: challenge.payment.destination,
      body_hash: crypto.createHash("sha256").update(canonicalJson(body)).digest("hex")
    });
    const messageBytes = Buffer.from(payload);
    const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
    return `x402 ${bs58.encode(signature)}.${pubkeyB58}.${bs58.encode(messageBytes)}`;
  }

  // 1. Same Proof Replay
  const body = { jsonrpc: "2.0", id: 1, method: "getHealth", params: [] };
  const challenge = await getChallenge(body);
  const auth = signPayload(challenge, body);

  console.log("Testing: Reusing same proof...");
  const res1 = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": auth },
    body: JSON.stringify(body)
  });
  const res2 = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": auth },
    body: JSON.stringify(body)
  });

  console.log(`Statuses: res1=${res1.status}, res2=${res2.status}`);
  const passedReplay = res1.status === 200 && res2.status === 402;
  results.tests.push({
    id: "REPLAY-1",
    name: "Same Proof Replay",
    category: "Replay Protection",
    status: passedReplay ? "PASSED" : "FAILED",
    evidence: `First: ${res1.status}, Second: ${res2.status}`,
    observations: passedReplay ? "Rejected on second use" : "Accepted twice or failed prematurely"
  });
  console.log(passedReplay ? "✅ PASSED" : "❌ FAILED");

  // Save results (append if exists or new)
  const existing = fs.existsSync("test-results/security-results.json") ? JSON.parse(fs.readFileSync("test-results/security-results.json")) : { tests: [] };
  existing.tests.push(...results.tests);
  fs.writeFileSync("test-results/security-results.json", JSON.stringify(existing, null, 2));
}

runTest().catch(console.error);
