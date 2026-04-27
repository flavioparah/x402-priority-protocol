const fs = require('fs');
const path = require('path');

async function runTest() {
  console.log("--- Starting Deposit Rate Limit Tests ---");
  const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3000/rpc";
  const DEPOSIT_URL = GATEWAY_URL.replace("/rpc", "/escrow/deposit");
  const results = { tests: [] };

  console.log("Sending 6 deposit requests to trigger rate limit...");
  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(DEPOSIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "invalid-sig", pubkey: "invalid-pubkey" })
    });
    lastStatus = res.status;
    if (lastStatus === 429) break;
  }

  const passedRateLimit = lastStatus === 429;
  results.tests.push({
    id: "DEP-1",
    name: "Deposit Rate Limit",
    category: "Deposit Protection",
    status: passedRateLimit ? "PASSED" : "FAILED",
    evidence: `Final status: ${lastStatus}`,
    observations: passedRateLimit ? "Rate limited after 5 attempts" : "Not rate limited"
  });
  console.log(passedRateLimit ? "✅ PASSED" : "❌ FAILED");

  // Save results
  const existing = fs.existsSync("test-results/security-results.json") ? JSON.parse(fs.readFileSync("test-results/security-results.json")) : { tests: [] };
  existing.tests.push(...results.tests);
  fs.writeFileSync("test-results/security-results.json", JSON.stringify(existing, null, 2));
}

runTest().catch(console.error);
