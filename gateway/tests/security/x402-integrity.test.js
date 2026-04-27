const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

/**
 * Deterministically stringifies JSON by sorting keys.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      key => JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Body(body) {
  return crypto.createHash("sha256").update(canonicalJson(body)).digest("hex");
}

async function runTest() {
  console.log("--- Starting x402 Integrity Tests ---");
  const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3000/rpc";
  
  const results = {
    tests: []
  };

  const keypair = nacl.sign.keyPair();
  const pubkeyB58 = bs58.encode(keypair.publicKey);

  // Pre-test: Deposit escrow to allow payment
  console.log("Depositing escrow for test agent...");
  const depRes = await fetch(`${GATEWAY_URL.replace("/rpc", "/escrow/deposit-trusted")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: pubkeyB58, amount_micro_lamports: 1000000 })
  });
  if (!depRes.ok) {
    console.error("❌ Failed to deposit escrow. Tests will likely fail with insufficient_balance.");
  }

  async function testCase(name, body, modifyAfterSign = false, expectedStatus = 200) {
    console.log(`Testing: ${name}...`);
    try {
      // 1. Get Challenge
      const res1 = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": pubkeyB58 },
        body: JSON.stringify(body)
      });

      if (res1.status !== 402) {
        throw new Error(`Expected 402, got ${res1.status}`);
      }

      const challenge = await res1.json();
      const nonce = challenge.payment.nonce;
      const amount = challenge.payment.amount_micro_lamports;
      const destination = challenge.payment.destination;
      const body_hash = challenge.payment.body_hash;

      // 2. Sign
      const payload = JSON.stringify({
        protocol: "x402-shield",
        network: "mainnet", // match config
        nonce,
        pubkey: pubkeyB58,
        amount,
        destination,
        body_hash: modifyAfterSign ? "wrong-hash" : body_hash
      });

      const messageBytes = Buffer.from(payload);
      const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
      const authHeader = `x402 ${bs58.encode(signature)}.${pubkeyB58}.${bs58.encode(messageBytes)}`;

      // 3. Retry
      const res2 = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json", 
          "Authorization": authHeader,
          "X-x402-Agent-Pubkey": pubkeyB58
        },
        body: JSON.stringify(body)
      });

      const passed = res2.status === expectedStatus;
      results.tests.push({
        id: `X402-${results.tests.length + 1}`,
        name,
        category: "x402 Integrity",
        status: passed ? "PASSED" : "FAILED",
        evidence: `HTTP ${res2.status}`,
        observations: passed ? "" : `Expected ${expectedStatus}, got ${res2.status}`
      });
      console.log(passed ? "✅ PASSED" : "❌ FAILED");
    } catch (err) {
      results.tests.push({
        id: `X402-${results.tests.length + 1}`,
        name,
        category: "x402 Integrity",
        status: "FAILED",
        evidence: err.message
      });
      console.log(`❌ FAILED: ${err.message}`);
    }
  }

  // Define Tests
  const standardBody = { jsonrpc: "2.0", id: 1, method: "getHealth", params: [] };
  
  await testCase("Valid proof with same body", standardBody, false, 200);
  await testCase("Modified body hash after signing", standardBody, true, 402);
  
  // Save results
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/security-results.json", JSON.stringify(results, null, 2));
}

if (require.main === module) {
  runTest().catch(console.error);
}
