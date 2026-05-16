/**
 * test/trust-score.test.js
 *
 * Unit tests for lib/trust-score.js (v0.2 formula). Pure-function tests, no
 * I/O. Mirrors the style of test/detection.test.js.
 *
 * Run: node test/trust-score.test.js
 */

const {
  computeScoreV02,
  computeSubscores,
  extendReputationFields,
  defaultPolicy,
  DEFAULT_DECAY_DAYS,
  _internal,
} = require("../lib/trust-score");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

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

function approx(actual, expected, tol = 0.05, label = "") {
  if (typeof actual !== "number" || isNaN(actual)) {
    throw new Error(`${label}: expected number, got ${actual}`);
  }
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label}: expected ${expected} (±${tol}), got ${actual}`);
  }
}

function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── P1: paid_count, log-scaled ──────────────────────────────────────────────

console.log("\n— P1 (paid_count, log10 * 20) —");

test("P1: paid=0 → 0", () => approx(_internal.p1(0), 0));
test("P1: paid=1 → 6.02", () => approx(_internal.p1(1), 6.02));
test("P1: paid=10 → 20.79", () => approx(_internal.p1(10), 20.79));
test("P1: paid=50 → 34.15", () => approx(_internal.p1(50), 34.151));
test("P1: paid=100 → 40.04", () => approx(_internal.p1(100), 40.04));
test("P1: paid=1000 → 60.01", () => approx(_internal.p1(1000), 60.01));
test("P1: paid=100000 → 100 (saturation)", () => approx(_internal.p1(100000), 100, 0.5));
test("P1: paid=null → 0", () => approx(_internal.p1(null), 0));
test("P1: paid=-5 → 0 (defensive)", () => approx(_internal.p1(-5), 0));

// ─── P2: tenure, sqrt-scaled ─────────────────────────────────────────────────

console.log("\n— P2 (months_in_network, sqrt * 12) —");

test("P2: months=0 → 0", () => approx(_internal.p2(0), 0));
test("P2: months=1 → 12", () => approx(_internal.p2(1), 12));
test("P2: months=4 → 24", () => approx(_internal.p2(4), 24));
test("P2: months=6 → 29.39", () => approx(_internal.p2(6), 29.394));
test("P2: months=12 → 41.57", () => approx(_internal.p2(12), 41.569));
test("P2: months=70 → ~100 (saturation)", () => approx(_internal.p2(70), 100, 1));
test("P2: months=null → 0", () => approx(_internal.p2(null), 0));

// ─── D2: distribution across providers ───────────────────────────────────────

console.log("\n— D2 ((1 - loyalty_concentration) * 100) —");

test("D2: loyalty=1.0 (single op) → 0", () => approx(_internal.d2(1.0), 0));
test("D2: loyalty=0.5 → 50", () => approx(_internal.d2(0.5), 50));
test("D2: loyalty=0.25 (4 ops, equal) → 75", () => approx(_internal.d2(0.25), 75));
test("D2: loyalty=0 (perfectly distributed) → 100", () => approx(_internal.d2(0), 100));
test("D2: loyalty=null → 0 (defensive)", () => approx(_internal.d2(null), 0));
test("D2: loyalty=1.5 (out of range) → 0 (clamped)", () => approx(_internal.d2(1.5), 0));

// ─── H1: Laplace-smoothed no-dispute ratio ───────────────────────────────────

console.log("\n— H1 (Laplace: ((paid − disp + 1) / (paid + 2)) * 100) —");

test("H1: paid=0, disp=0 → 50 (Laplace floor — no evidence)", () => {
  approx(_internal.h1(0, 0), 50);
});
test("H1: paid=5, disp=0 → 85.71", () => approx(_internal.h1(5, 0), 85.714));
test("H1: paid=100, disp=0 → 99.02", () => approx(_internal.h1(100, 0), 99.02));
test("H1: paid=1000, disp=0 → 99.90", () => approx(_internal.h1(1000, 0), 99.90));
test("H1: paid=100, disp=10 → 89.22 (penalty proportional)", () => {
  approx(_internal.h1(100, 10), 89.22);
});
test("H1: paid=10, disp=10 → 8.33 (heavy penalty when ratio bad)", () => {
  approx(_internal.h1(10, 10), 8.33);
});
test("H1: paid=10, disp=5 → 50 (half disputes)", () => {
  approx(_internal.h1(10, 5), 50);
});

// ─── R1: recency decay ───────────────────────────────────────────────────────

console.log("\n— R1 (exp(-idle_days/60) * 100) —");

test("R1: idle=0 → 100", () => approx(_internal.r1(0), 100));
test("R1: idle=30 → 60.65", () => approx(_internal.r1(30), 60.65));
test("R1: idle=60 → 36.79 (one half-life)", () => approx(_internal.r1(60), 36.79));
test("R1: idle=120 → 13.53", () => approx(_internal.r1(120), 13.53));
test("R1: idle=Infinity → 0", () => approx(_internal.r1(Infinity), 0));
test("R1: idle=null → 100 (treat as just-active)", () => approx(_internal.r1(null), 100));
test("R1: idle=-5 → 100 (defensive: future ts treated as 0)", () => approx(_internal.r1(-5), 100));

// ─── Cross-provider bonus ────────────────────────────────────────────────────

console.log("\n— cross_provider_bonus (min(1.5, 1 + 0.1·(N−1))) —");

test("bonus: N=1 → 1.0", () => approx(_internal.crossProviderBonus(1), 1.0));
test("bonus: N=2 → 1.1", () => approx(_internal.crossProviderBonus(2), 1.1));
test("bonus: N=3 → 1.2", () => approx(_internal.crossProviderBonus(3), 1.2));
test("bonus: N=4 → 1.3", () => approx(_internal.crossProviderBonus(4), 1.3));
test("bonus: N=5 → 1.4", () => approx(_internal.crossProviderBonus(5), 1.4));
test("bonus: N=6 → 1.5 (cap)", () => approx(_internal.crossProviderBonus(6), 1.5));
test("bonus: N=10 → 1.5 (still capped)", () => approx(_internal.crossProviderBonus(10), 1.5));
test("bonus: N=0 → 1.0 (treated as N=1)", () => approx(_internal.crossProviderBonus(0), 1.0));

// ─── Helpers over attestation log ────────────────────────────────────────────

console.log("\n— distinctOperators / loyaltyConcentration —");

test("distinctOperators: empty log → empty set", () => {
  const set = _internal.distinctOperators([]);
  if (set.size !== 0) throw new Error(`expected size 0, got ${set.size}`);
});

test("distinctOperators: 3 distinct ops in log → size 3", () => {
  const log = [
    { ts: 1, amount: 100, operator_id: "op-A" },
    { ts: 2, amount: 100, operator_id: "op-B" },
    { ts: 3, amount: 100, operator_id: "op-C" },
    { ts: 4, amount: 100, operator_id: "op-A" },
  ];
  const set = _internal.distinctOperators(log);
  if (set.size !== 3) throw new Error(`expected size 3, got ${set.size}`);
});

test("loyaltyConcentration: empty log → 1.0 (single-op default)", () => {
  approx(_internal.loyaltyConcentration([]), 1.0);
});

test("loyaltyConcentration: single op → 1.0", () => {
  const log = [
    { ts: 1, amount: 100, operator_id: "self" },
    { ts: 2, amount: 100, operator_id: "self" },
  ];
  approx(_internal.loyaltyConcentration(log), 1.0);
});

test("loyaltyConcentration: 2 ops 50/50 → 0.5", () => {
  const log = [
    { ts: 1, amount: 100, operator_id: "op-A" },
    { ts: 2, amount: 100, operator_id: "op-B" },
  ];
  approx(_internal.loyaltyConcentration(log), 0.5);
});

test("loyaltyConcentration: 4 ops 40/30/20/10 → 0.4", () => {
  const log = [];
  for (let i = 0; i < 40; i++) log.push({ ts: i, amount: 100, operator_id: "op-A" });
  for (let i = 0; i < 30; i++) log.push({ ts: i, amount: 100, operator_id: "op-B" });
  for (let i = 0; i < 20; i++) log.push({ ts: i, amount: 100, operator_id: "op-C" });
  for (let i = 0; i < 10; i++) log.push({ ts: i, amount: 100, operator_id: "op-D" });
  approx(_internal.loyaltyConcentration(log), 0.4);
});

// ─── extendReputationFields ──────────────────────────────────────────────────

console.log("\n— extendReputationFields —");

test("extendReputationFields: empty inputs → null-friendly defaults", () => {
  const out = extendReputationFields(null, []);
  assertEq(out.active_in_n_providers, 0, "active_in_n_providers");
  approx(out.loyalty_concentration, 1.0);
  assertEq(out.per_provider, {}, "per_provider");
});

test("extendReputationFields: single op, 5 attestations → N=1, loyalty=1, per_provider populated", () => {
  const log = [];
  for (let i = 0; i < 5; i++) log.push({ ts: 1000 + i, amount: 100, operator_id: "self" });
  const rep = { paidCount: 5, firstPaidAt: 1000, lastPaidAt: 1004, totalPaid: 500 };
  const out = extendReputationFields(rep, log);
  assertEq(out.active_in_n_providers, 1, "N");
  approx(out.loyalty_concentration, 1.0);
  assertEq(Object.keys(out.per_provider), ["self"], "per_provider keys");
  assertEq(out.per_provider.self.paid_count, 5, "self.paid_count");
  assertEq(out.per_provider.self.total_paid_micro_lamports, 500, "self.total_paid");
});

test("extendReputationFields: 3 ops with skewed distribution → N=3, loyalty=correct", () => {
  const log = [
    { ts: 1, amount: 100, operator_id: "op-A" },
    { ts: 2, amount: 100, operator_id: "op-A" },
    { ts: 3, amount: 100, operator_id: "op-A" },
    { ts: 4, amount: 100, operator_id: "op-B" },
    { ts: 5, amount: 100, operator_id: "op-C" },
  ];
  const rep = { paidCount: 5, firstPaidAt: 1, lastPaidAt: 5, totalPaid: 500 };
  const out = extendReputationFields(rep, log);
  assertEq(out.active_in_n_providers, 3, "N");
  approx(out.loyalty_concentration, 0.6); // 3/5
});

// ─── Composite score (Phase 1 = H1 inactive) ─────────────────────────────────

console.log("\n— computeSubscores: edge cases + Phase 1 (H1 inactive) —");

test("score: null reputation → 0", () => {
  approx(computeScoreV02(null, []), 0);
});

test("score: paidCount=0 → 0", () => {
  const rep = { paidCount: 0, firstPaidAt: 0, lastPaidAt: 0, totalPaid: 0 };
  approx(computeScoreV02(rep, []), 0);
});

test("score: H2 gate (fraud_flag active) forces score → 0", () => {
  const now = Date.now();
  const rep = { paidCount: 1000, firstPaidAt: now - 6 * ONE_MONTH_MS, lastPaidAt: now, totalPaid: 1e6 };
  approx(computeScoreV02(rep, [], { h2Gate: false, now }), 0);
});

test("Phase 1, single-op, 1000 paid / 6mo / idle 1d → matches hand calc", () => {
  // Hand calc:
  // P1 = log10(1001)*20 = 60.009
  // P2 = sqrt(6)*12 = 29.394
  // D2 = (1 - 1.0)*100 = 0  (single op)
  // R1 = exp(-1/60)*100 = 98.347
  // raw_phase1 = (0.30*60.009 + 0.15*29.394 + 0.10*0 + 0.25*98.347) / 0.80
  //            = (18.003 + 4.409 + 0 + 24.587) / 0.80
  //            = 46.999 / 0.80
  //            = 58.749
  // bonus(N=1) = 1.0
  // score = min(100, 58.749 * 1.0) = 58.749
  const now = Date.now();
  const rep = {
    paidCount: 1000,
    firstPaidAt: now - 6 * ONE_MONTH_MS,
    lastPaidAt: now - 1 * ONE_DAY_MS,
    totalPaid: 1e6,
  };
  const result = computeSubscores(rep, [], { h1Active: false, now });
  approx(result.P1, 60.009, 0.05, "P1");
  approx(result.P2, 29.394, 0.05, "P2");
  approx(result.D2, 0, 0.05, "D2");
  approx(result.R1, 98.347, 0.5, "R1");
  approx(result.bonus, 1.0, 0.001, "bonus");
  approx(result.score, 58.749, 0.5, "score");
});

test("Phase 1, 4 ops (loyalty 0.4), 1000 paid / 6mo / idle 1d → cross-op bonus 1.3", () => {
  // P1 = 60.009, P2 = 29.394, D2 = (1-0.4)*100 = 60, R1 = 98.347
  // raw_phase1 = (0.30*60 + 0.15*29.4 + 0.10*60 + 0.25*98.35) / 0.80
  //            = (18.003 + 4.409 + 6 + 24.587) / 0.80
  //            = 52.999 / 0.80
  //            = 66.249
  // bonus(N=4) = 1.3
  // score = min(100, 66.249 * 1.3) = 86.124
  const now = Date.now();
  const rep = {
    paidCount: 1000,
    firstPaidAt: now - 6 * ONE_MONTH_MS,
    lastPaidAt: now - 1 * ONE_DAY_MS,
    totalPaid: 1e6,
  };
  // Build attestations: 40 to op-A, 30 op-B, 20 op-C, 10 op-D (loyalty=0.4)
  const attestations = [];
  for (let i = 0; i < 40; i++) attestations.push({ ts: now - i, amount: 100, operator_id: "op-A" });
  for (let i = 0; i < 30; i++) attestations.push({ ts: now - i, amount: 100, operator_id: "op-B" });
  for (let i = 0; i < 20; i++) attestations.push({ ts: now - i, amount: 100, operator_id: "op-C" });
  for (let i = 0; i < 10; i++) attestations.push({ ts: now - i, amount: 100, operator_id: "op-D" });
  const result = computeSubscores(rep, attestations, { h1Active: false, now });
  approx(result.D2, 60, 0.5, "D2");
  approx(result.bonus, 1.3, 0.001, "bonus");
  approx(result.score, 86.12, 0.5, "score");
});

test("Phase 1, new agent: 5 paid / 0.5mo / single op / idle 0 → ~38.7", () => {
  // P1 = log10(6)*20 = 15.563
  // P2 = sqrt(0.5)*12 = 8.485
  // D2 = 0 (single op)
  // R1 = 100 (idle 0)
  // raw_phase1 = (0.30*15.563 + 0.15*8.485 + 0.10*0 + 0.25*100) / 0.80
  //            = (4.669 + 1.273 + 0 + 25) / 0.80
  //            = 30.942 / 0.80
  //            = 38.677
  const now = Date.now();
  const rep = {
    paidCount: 5,
    firstPaidAt: now - 0.5 * ONE_MONTH_MS,
    lastPaidAt: now,
    totalPaid: 500,
  };
  const result = computeSubscores(rep, [], { h1Active: false, now });
  approx(result.score, 38.677, 0.5, "Phase 1 new agent");
});

// ─── Composite score (Phase 1.5+ = H1 active) ────────────────────────────────

console.log("\n— computeSubscores: Phase 1.5+ (H1 active with /report) —");

test("Phase 1.5+, top agent 1000 paid, 6mo, 4 ops, 0 disputes, idle 1d → ~94", () => {
  // P1 = 60.009, P2 = 29.394, D2 = 60, H1 = (1001/1002)*100 = 99.900, R1 = 98.347
  // raw = 0.30*60.009 + 0.15*29.394 + 0.10*60 + 0.20*99.900 + 0.25*98.347
  //     = 18.003 + 4.409 + 6 + 19.980 + 24.587
  //     = 72.979
  // bonus = 1.3
  // score = min(100, 72.979*1.3) = min(100, 94.872) = 94.872
  const now = Date.now();
  const rep = {
    paidCount: 1000,
    firstPaidAt: now - 6 * ONE_MONTH_MS,
    lastPaidAt: now - 1 * ONE_DAY_MS,
    totalPaid: 1e6,
  };
  const attestations = [];
  for (let i = 0; i < 40; i++) attestations.push({ ts: now - i, amount: 100, operator_id: "op-A" });
  for (let i = 0; i < 30; i++) attestations.push({ ts: now - i, amount: 100, operator_id: "op-B" });
  for (let i = 0; i < 20; i++) attestations.push({ ts: now - i, amount: 100, operator_id: "op-C" });
  for (let i = 0; i < 10; i++) attestations.push({ ts: now - i, amount: 100, operator_id: "op-D" });
  const result = computeSubscores(rep, attestations, { h1Active: true, disputes: 0, now });
  approx(result.H1, 99.90, 0.05, "H1");
  approx(result.score, 94.87, 0.5, "score");
});

test("Phase 1.5+, agent with 10 disputes / 100 paid → score drops via H1", () => {
  // H1 = ((100 - 10 + 1) / (100 + 2)) * 100 = (91/102)*100 = 89.22
  // (matches earlier subscore test)
  const now = Date.now();
  const rep = {
    paidCount: 100,
    firstPaidAt: now - 6 * ONE_MONTH_MS,
    lastPaidAt: now,
    totalPaid: 1e5,
  };
  const result = computeSubscores(rep, [], { h1Active: true, disputes: 10, now });
  approx(result.H1, 89.22, 0.05);
});

test("Phase 1.5+, new agent (5 paid / 0 disputes) → H1 ≈ 85.71 not 100", () => {
  const now = Date.now();
  const rep = {
    paidCount: 5,
    firstPaidAt: now - 0.5 * ONE_MONTH_MS,
    lastPaidAt: now,
    totalPaid: 500,
  };
  const result = computeSubscores(rep, [], { h1Active: true, disputes: 0, now });
  approx(result.H1, 85.71, 0.05);
});

// ─── defaultPolicy (for GET /info) ───────────────────────────────────────────

console.log("\n— defaultPolicy —");

test("defaultPolicy: spec_version is '0.2'", () => {
  assertEq(defaultPolicy().spec_version, "0.2", "spec_version");
});

test("defaultPolicy: H1 inactive_until_report_v1 by default", () => {
  const p = defaultPolicy();
  const h1c = p.score_components.find(c => c.id === "H1");
  assertEq(h1c.status, "inactive_until_report_v1", "H1 status default");
});

test("defaultPolicy: H1 active when h1Active=true", () => {
  const p = defaultPolicy({ h1Active: true });
  const h1c = p.score_components.find(c => c.id === "H1");
  assertEq(h1c.status, "active", "H1 status when h1Active=true");
});

test("defaultPolicy: weights sum to 1.0", () => {
  const p = defaultPolicy();
  const sum = p.score_components.reduce((s, c) => s + c.weight, 0);
  approx(sum, 1.0, 0.001);
});

test("defaultPolicy: cross_provider_bonus shape", () => {
  const p = defaultPolicy();
  approx(p.cross_provider_bonus.increment, 0.1);
  approx(p.cross_provider_bonus.max, 1.5);
  assertEq(p.decay_days, DEFAULT_DECAY_DAYS, "decay_days");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
