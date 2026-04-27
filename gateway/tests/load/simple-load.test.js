const fs = require('fs');
const path = require('path');

async function runTest() {
  console.log("--- Starting Simple Load Test ---");
  const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3000/rpc";
  const results = { tests: [] };

  const durationMs = 10000;
  const start = Date.now();
  let count = 0;
  let errors = 0;
  let latencies = [];

  console.log(`Sending requests for ${durationMs/1000}s...`);

  while (Date.now() - start < durationMs) {
    const t0 = Date.now();
    try {
      const res = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: count, method: "getHealth", params: [] })
      });
      latencies.push(Date.now() - t0);
      if (![200, 402].includes(res.status)) errors++;
    } catch (err) {
      errors++;
    }
    count++;
    // throttle slightly to not kill the runner
    await new Promise(r => setTimeout(r, 10));
  }

  const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p95Lat = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];

  console.log(`Finished: ${count} requests, ${errors} errors, Avg Latency: ${avgLat.toFixed(2)}ms, P95: ${p95Lat}ms`);

  results.tests.push({
    id: "LOAD-1",
    name: "Standard RPC Load",
    category: "Load Test",
    status: errors / count < 0.05 ? "PASSED" : "FAILED",
    evidence: `Count: ${count}, Errors: ${errors}, P95: ${p95Lat}ms`,
    observations: `Successfully handled ${count} requests with ${(errors/count*100).toFixed(2)}% error rate.`
  });

  // Save results
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/load-results.json", JSON.stringify(results, null, 2));
}

runTest().catch(console.error);
