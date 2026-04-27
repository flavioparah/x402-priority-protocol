const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

async function runTest() {
  console.log("--- Starting Batch Pricing Tests ---");
  const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3000/rpc";
  const results = { tests: [] };

  const keypair = nacl.sign.keyPair();
  const pubkeyB58 = bs58.encode(keypair.publicKey);

  async function getChallenge(body) {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": pubkeyB58 },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  // 1. Single cheap call
  const body1 = { jsonrpc: "2.0", id: 1, method: "getHealth", params: [] };
  const chal1 = await getChallenge(body1);
  const amount1 = chal1.payment.amount_micro_lamports;

  // 2. Batch with 3 cheap calls
  const body2 = [
    { jsonrpc: "2.0", id: 1, method: "getHealth", params: [] },
    { jsonrpc: "2.0", id: 2, method: "getHealth", params: [] },
    { jsonrpc: "2.0", id: 3, method: "getHealth", params: [] }
  ];
  const chal2 = await getChallenge(body2);
  const amount2 = chal2.payment.amount_micro_lamports;

  // Expected amount2 should be roughly 3 * amount1 (ignoring trust score changes if any)
  const passedBatchSum = Math.abs(amount2 - (3 * amount1)) < 10;
  results.tests.push({
    id: "BATCH-1",
    name: "Batch Sum Pricing",
    category: "Batch Pricing",
    status: passedBatchSum ? "PASSED" : "FAILED",
    evidence: `Single: ${amount1}, Batch(3): ${amount2}`,
    observations: passedBatchSum ? "Price correctly summed" : "Price was not summed correctly"
  });
  console.log(passedBatchSum ? "✅ PASSED (Batch Sum)" : "❌ FAILED (Batch Sum)");

  // 3. Batch > 50 items
  const body3 = Array(51).fill({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] });
  const res3 = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": pubkeyB58 },
    body: JSON.stringify(body3)
  });
  const passedBatchLimit = res3.status === 400; // Server should reject large batches
  results.tests.push({
    id: "BATCH-2",
    name: "Batch Size Limit",
    category: "Batch Pricing",
    status: passedBatchLimit ? "PASSED" : "FAILED",
    evidence: `Status: ${res3.status}`,
    observations: passedBatchLimit ? "Rejected batch > 50" : "Accepted batch > 50"
  });
  console.log(passedBatchLimit ? "✅ PASSED (Batch Limit)" : "❌ FAILED (Batch Limit)");

  // Save results
  const existing = fs.existsSync("test-results/security-results.json") ? JSON.parse(fs.readFileSync("test-results/security-results.json")) : { tests: [] };
  existing.tests.push(...results.tests);
  fs.writeFileSync("test-results/security-results.json", JSON.stringify(existing, null, 2));
}

runTest().catch(console.error);
