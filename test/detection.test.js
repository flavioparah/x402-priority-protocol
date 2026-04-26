/**
 * test/detection.test.js
 *
 * Unit tests for lib/detection.js. No network, no Redis, no shield —
 * pure function tests over hand-crafted attestation logs.
 *
 * Run: node test/detection.test.js
 */

const { computeRisk, _internal } = require("../lib/detection");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * ONE_DAY_MS;
const HOUR_MS = 60 * 60 * 1000;

// ─── tiny test runner ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertContains(arr, item, label) {
  if (!arr.includes(item)) {
    throw new Error(`${label}: expected [${arr}] to contain ${item}`);
  }
}

function assertNotContains(arr, item, label) {
  if (arr.includes(item)) {
    throw new Error(`${label}: expected [${arr}] NOT to contain ${item}`);
  }
}

// ─── helpers to build attestation logs ───────────────────────────────────────

function attestation(tsOffset, amount, operator_id = "self") {
  return { ts: Date.now() - tsOffset, amount, operator_id };
}

function bulkAttestations(n, baseTsOffset, amount, operator_id = "self", spreadMs = 60_000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ ts: Date.now() - baseTsOffset - i * spreadMs, amount, operator_id });
  }
  return out;
}

// ─── individual signal tests ─────────────────────────────────────────────────

console.log("\nx402-trust-score detection — unit tests\n");

console.log("# washPaymentSuspect");

test("returns false for empty log", () => {
  assertEq(_internal.washPaymentSuspect([]), false, "empty");
});

test("returns false when fewer than 50 events", () => {
  const log = bulkAttestations(10, 0, 40200);
  assertEq(_internal.washPaymentSuspect(log), false, "<50");
});

test("flags when >50% of 50+ recent events have same amount", () => {
  // 60 events, 50 same, 10 varied → 50/60 = 83% > 50%
  const log = [
    ...bulkAttestations(50, HOUR_MS, 40200),
    ...bulkAttestations(10, HOUR_MS, 12345),
  ];
  assertEq(_internal.washPaymentSuspect(log), true, "wash detected");
});

test("does not flag when amounts are distributed (no >50% same)", () => {
  // 60 events with 6 distinct amounts → max ~16% per bucket
  const log = [];
  for (let i = 0; i < 60; i++) {
    log.push(attestation(HOUR_MS + i * 60_000, 10000 + (i % 6) * 5000));
  }
  assertEq(_internal.washPaymentSuspect(log), false, "varied amounts");
});

console.log("\n# dormantRevival");

test("returns false for empty log", () => {
  assertEq(_internal.dormantRevival([], null), false, "empty");
});

test("flags when oldest in log is >90d before newest AND recent burst >50", () => {
  const log = [];
  // 60 events in last 12h
  for (let i = 0; i < 60; i++) log.push(attestation(i * 60_000, 40200));
  // Older event 100 days ago
  log.push(attestation(100 * ONE_DAY_MS, 40200));
  // Pad to >50 entries (already done)
  const reputation = { firstPaidAt: Date.now() - 200 * ONE_DAY_MS, paidCount: 200, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.dormantRevival(log, reputation), true, "dormant detected");
});

test("does not flag a brand-new account with high burst", () => {
  const log = bulkAttestations(60, HOUR_MS, 40200);
  const reputation = { firstPaidAt: Date.now() - 12 * HOUR_MS, paidCount: 60, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.dormantRevival(log, reputation), false, "new account not dormant");
});

console.log("\n# crossProviderVelocity (cross-op signal)");

test("returns false when only 1 operator visible (current MVP state)", () => {
  const log = bulkAttestations(50, HOUR_MS, 40200, "self");
  const reputation = { firstPaidAt: Date.now() - 6 * HOUR_MS, paidCount: 50, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.crossProviderVelocity(log, reputation), false, "single-op inert");
});

test("flags when ≥3 operators in <24h on a <72h account", () => {
  const log = [
    ...bulkAttestations(20, HOUR_MS, 40200, "helius"),
    ...bulkAttestations(20, HOUR_MS, 40200, "triton"),
    ...bulkAttestations(20, HOUR_MS, 40200, "jito"),
  ];
  const reputation = { firstPaidAt: Date.now() - 12 * HOUR_MS, paidCount: 60, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.crossProviderVelocity(log, reputation), true, "cross-op velocity flagged");
});

test("does not flag old account even with 3+ operators", () => {
  const log = [
    ...bulkAttestations(20, HOUR_MS, 40200, "helius"),
    ...bulkAttestations(20, HOUR_MS, 40200, "triton"),
    ...bulkAttestations(20, HOUR_MS, 40200, "jito"),
  ];
  const reputation = { firstPaidAt: Date.now() - 30 * ONE_DAY_MS, paidCount: 60, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.crossProviderVelocity(log, reputation), false, "old account not sybil");
});

console.log("\n# classifySybilRisk");

test("returns 'low' for empty / no reputation", () => {
  assertEq(_internal.classifySybilRisk([], null), "low", "no rep");
});

test("returns 'high' for very young account with many payments", () => {
  const reputation = { firstPaidAt: Date.now() - 4 * HOUR_MS, paidCount: 25, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.classifySybilRisk([], reputation), "high", "young + high count");
});

test("returns 'low' for slow established account", () => {
  const reputation = { firstPaidAt: Date.now() - 60 * ONE_DAY_MS, paidCount: 200, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.classifySybilRisk([], reputation), "low", "established");
});

console.log("\n# classifyChurnPattern");

test("returns 'ephemeral' for paid_count<3", () => {
  const reputation = { firstPaidAt: Date.now() - ONE_DAY_MS, paidCount: 2, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.classifyChurnPattern([], reputation), "ephemeral", "low count");
});

test("returns 'shopping' when ≥3 distinct operators in log", () => {
  const log = [
    attestation(HOUR_MS, 40200, "helius"),
    attestation(HOUR_MS * 2, 40200, "triton"),
    attestation(HOUR_MS * 3, 40200, "jito"),
  ];
  const reputation = { firstPaidAt: Date.now() - 7 * ONE_DAY_MS, paidCount: 30, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.classifyChurnPattern(log, reputation), "shopping", "3+ operators");
});

test("returns 'stable' for established single-op account", () => {
  const log = bulkAttestations(20, HOUR_MS, 40200, "self");
  const reputation = { firstPaidAt: Date.now() - 30 * ONE_DAY_MS, paidCount: 20, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(_internal.classifyChurnPattern(log, reputation), "stable", "single-op stable");
});

console.log("\n# computeRisk (top-level)");

test("benign: established account, no flags, low risk", () => {
  const log = bulkAttestations(10, HOUR_MS, 40200, "self");
  const reputation = { firstPaidAt: Date.now() - 30 * ONE_DAY_MS, paidCount: 10, lastPaidAt: Date.now(), totalPaid: 402000 };
  const risk = computeRisk(log, reputation);
  assertEq(risk.sybil_risk, "low", "low risk");
  assertEq(risk.fraud_flags, [], "no flags");
  assertEq(risk.churn_pattern, "stable", "stable");
});

test("malicious: wash payment + young account → flags + sybil risk", () => {
  const log = bulkAttestations(60, HOUR_MS, 40200, "self");
  const reputation = { firstPaidAt: Date.now() - 5 * HOUR_MS, paidCount: 60, lastPaidAt: Date.now(), totalPaid: 0 };
  const risk = computeRisk(log, reputation);
  assertContains(risk.fraud_flags, "wash_payment_suspect", "wash flag set");
  assertEq(risk.sybil_risk, "high", "young + many paid → high");
});

test("cross-op sybil ring: high risk + shopping", () => {
  const log = [
    ...bulkAttestations(15, HOUR_MS, 40200, "helius"),
    ...bulkAttestations(15, HOUR_MS, 40200, "triton"),
    ...bulkAttestations(15, HOUR_MS, 40200, "jito"),
  ];
  const reputation = { firstPaidAt: Date.now() - 12 * HOUR_MS, paidCount: 45, lastPaidAt: Date.now(), totalPaid: 0 };
  const risk = computeRisk(log, reputation);
  assertEq(risk.sybil_risk, "high", "cross-op velocity → high");
  assertEq(risk.churn_pattern, "shopping", "3+ ops → shopping");
});

// ─── summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed + failed} tests passed.\n`);
if (failed > 0) process.exit(1);
