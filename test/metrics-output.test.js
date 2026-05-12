"use strict";
/**
 * test/metrics-output.test.js — Phase 4 Task 18
 *
 * Asserts that getMetricsText() returns valid Prometheus text format and that
 * all expected x402_* metric names are present.
 */

// Each require of lib/metrics.js gets a FRESH registry because prom-client
// caches the Registry by reference (not by global singleton) when we pass
// `registers: [register]` explicitly.  However, since Node module cache means
// we always get the same instance across a single process run, we simply test
// the module as-is — which is the production scenario.
const {
  getMetricsText,
  incRequest,
  incAbuseEvent,
  incAdminAction,
  observeSolanaDuration,
  updateLiveGauges,
} = require("../lib/metrics");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((e) => {
      console.error(`  ✗ ${name}\n    ${e.message}`);
      failed++;
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertContains(text, needle) {
  if (!text.includes(needle))
    throw new Error(`Expected output to contain: ${JSON.stringify(needle)}`);
}

// Minimal fake store
function makeFakeStore(healthy = true) {
  return {
    async isStoreHealthy() {
      return healthy;
    },
  };
}

(async () => {
  console.log("\nx402-shield metrics-output — unit tests\n");

  // Seed some activity so the counters/gauges have values
  incRequest("/verify", "shield_ratelimit", "throttled");
  incRequest("/verify", "preflight", "ok");
  incAbuseEvent("ip-rate-limit");
  incAdminAction("ban", "ok");
  incAdminAction("unban");
  observeSolanaDuration(0.042);
  updateLiveGauges({ qosInflightCount: 3, qosQueueLen: 1 });

  const storeHealthy = makeFakeStore(true);
  const storeUnhealthy = makeFakeStore(false);

  // ── Test 1: output starts with # HELP
  await test("output starts with # HELP lines", async () => {
    const text = await getMetricsText(storeHealthy);
    assert(typeof text === "string", "should return a string");
    assert(text.startsWith("# HELP"), `text starts with: ${text.slice(0, 80)}`);
  });

  // ── Test 2: all expected metric names present
  await test("contains x402_requests_total", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, "x402_requests_total");
  });

  await test("contains x402_ratelimit_blocks_total", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, "x402_ratelimit_blocks_total");
  });

  await test("contains x402_solana_circuit_state", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, "x402_solana_circuit_state");
  });

  await test("contains x402_admin_actions_total", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, "x402_admin_actions_total");
  });

  await test("contains x402_store_healthy", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, "x402_store_healthy");
  });

  await test("contains x402_solana_rpc_duration_seconds", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, "x402_solana_rpc_duration_seconds");
  });

  // ── Test 3: Prometheus text format validation
  await test("every line is a comment, empty, or TYPE/HELP/metric line", async () => {
    const text = await getMetricsText(storeHealthy);
    const lines = text.split("\n");
    for (const line of lines) {
      if (line === "") continue;
      // Valid Prometheus text exposition lines
      if (line.startsWith("# HELP")) continue;
      if (line.startsWith("# TYPE")) continue;
      // Metric lines: name{labels} value [timestamp]  OR  name value [timestamp]
      if (/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+\S+/.test(line)) continue;
      throw new Error(`Unexpected line format: ${line}`);
    }
  });

  await test("# TYPE annotations present for x402 metrics", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, "# TYPE x402_requests_total counter");
    assertContains(text, "# TYPE x402_ratelimit_blocks_total counter");
    assertContains(text, "# TYPE x402_admin_actions_total counter");
    assertContains(text, "# TYPE x402_solana_circuit_state gauge");
    assertContains(text, "# TYPE x402_store_healthy gauge");
  });

  // ── Test 4: default labels applied
  await test("service label appears in output", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, 'service="x402-shield"');
  });

  // ── Test 5: store health reflects store state
  await test("x402_store_healthy is 1 for healthy store", async () => {
    const text = await getMetricsText(storeHealthy);
    // Find the metric line for x402_store_healthy
    const lines = text.split("\n").filter((l) => l.startsWith("x402_store_healthy"));
    assert(lines.length > 0, "x402_store_healthy metric line not found");
    const valuePart = lines[0].split(" ").pop();
    assert(valuePart === "1", `expected 1, got ${valuePart}`);
  });

  await test("x402_store_healthy is 0 for unhealthy store", async () => {
    const text = await getMetricsText(storeUnhealthy);
    const lines = text.split("\n").filter((l) => l.startsWith("x402_store_healthy"));
    assert(lines.length > 0, "x402_store_healthy metric line not found");
    const valuePart = lines[0].split(" ").pop();
    assert(valuePart === "0", `expected 0, got ${valuePart}`);
  });

  // ── Test 6: x402_requests_total has expected label dimensions
  await test("x402_requests_total carries route/stage/outcome labels", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, 'route="/verify"');
    assertContains(text, 'stage="preflight"');
    assertContains(text, 'outcome="ok"');
  });

  // ── Test 7: x402_admin_actions_total carries action + outcome labels
  await test("x402_admin_actions_total carries action and outcome labels", async () => {
    const text = await getMetricsText(storeHealthy);
    assertContains(text, 'action="ban"');
    assertContains(text, 'outcome="ok"');
  });

  // ── Test 8: circuit state is a numeric gauge
  await test("x402_solana_circuit_state is numeric (0, 1, or 2)", async () => {
    const text = await getMetricsText(storeHealthy);
    const lines = text.split("\n").filter((l) => l.startsWith("x402_solana_circuit_state{"));
    assert(lines.length > 0, "x402_solana_circuit_state gauge line not found");
    const val = Number(lines[0].split(" ").pop());
    assert([0, 1, 2].includes(val), `unexpected circuit state value: ${val}`);
  });

  // ── Test 9: getMetricsText works without a store argument
  await test("getMetricsText() works without store argument", async () => {
    const text = await getMetricsText();
    assert(typeof text === "string" && text.length > 0, "should return non-empty string");
    assertContains(text, "x402_requests_total");
  });

  console.log(`\n${passed}/${passed + failed} tests passed.`);
  if (failed) process.exit(1);
})();
