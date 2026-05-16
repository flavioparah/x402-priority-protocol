/**
 * broker/test/weight.test.js
 *
 * Unit tests for broker/lib/weight.js — provider weight policy per RFC §5.2.
 * Pure function tests, no I/O. Deterministic clock via injected `now`.
 *
 * Run: node broker/test/weight.test.js
 */

const {
  rawWeight,
  activeCohort,
  networkMedian,
  weight,
  defaultPolicy,
  TIER_BASE,
  _internal,
} = require("../lib/weight");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed epoch ms for deterministic time math

// ─── tiny test runner ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let assertions = 0;

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

function approx(actual, expected, tol = 0.01, label = "") {
  assertions++;
  if (typeof actual !== "number" || Number.isNaN(actual)) {
    throw new Error(`${label}: expected number near ${expected}, got ${actual}`);
  }
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label}: expected ${expected} (±${tol}), got ${actual}`);
  }
}

function assertEq(actual, expected, label) {
  assertions++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertTrue(cond, label) {
  assertions++;
  if (!cond) throw new Error(`${label}: expected truthy, got ${cond}`);
}

function assertFalse(cond, label) {
  assertions++;
  if (cond) throw new Error(`${label}: expected falsy, got ${cond}`);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeProvider(overrides = {}) {
  return {
    id: "p-default",
    tier: "production",
    status: "production",
    attestedCount30d: 99,           // log10(100) = 2
    monthsInNetwork: 4,             // sqrt(4) = 2
    lastAttestAt: NOW - 1 * DAY_MS, // within default 7d window
    distinctPubkeysAttested30d: 50, // above default 25 threshold
    ...overrides,
  };
}

// ─── rawWeight ───────────────────────────────────────────────────────────────

console.log("rawWeight:");

test("null provider → 0", () => {
  assertEq(rawWeight(null), 0, "null");
  assertEq(rawWeight(undefined), 0, "undefined");
});

test("unknown tier → 0", () => {
  assertEq(rawWeight({ tier: "platinum", attestedCount30d: 99, monthsInNetwork: 4 }), 0, "platinum");
  assertEq(rawWeight({ tier: "", attestedCount30d: 99, monthsInNetwork: 4 }), 0, "empty");
  assertEq(rawWeight({ attestedCount30d: 99, monthsInNetwork: 4 }), 0, "missing tier");
});

test("alpha, count=0, months=1 → 0", () => {
  // 0.5 × log10(1) × sqrt(1) = 0.5 × 0 × 1 = 0
  approx(rawWeight({ tier: "alpha", attestedCount30d: 0, monthsInNetwork: 1 }), 0, 1e-9, "alpha-zero");
});

test("alpha, count=99, months=1 → 1.0", () => {
  // 0.5 × log10(100) × sqrt(1) = 0.5 × 2 × 1 = 1.0
  approx(rawWeight({ tier: "alpha", attestedCount30d: 99, monthsInNetwork: 1 }), 1.0, 1e-9, "alpha-99");
});

test("beta, count=99, months=4 → 4.0", () => {
  // 1.0 × log10(100) × sqrt(4) = 1.0 × 2 × 2 = 4.0
  approx(rawWeight({ tier: "beta", attestedCount30d: 99, monthsInNetwork: 4 }), 4.0, 1e-9, "beta-99-4");
});

test("production, count=999, months=9 → 13.5", () => {
  // 1.5 × log10(1000) × sqrt(9) = 1.5 × 3 × 3 = 13.5
  approx(rawWeight({ tier: "production", attestedCount30d: 999, monthsInNetwork: 9 }), 13.5, 1e-9, "prod-999-9");
});

test("months ≤ 0 defaults to 1 via max(1, …)", () => {
  // sqrt(max(1, 0)) = 1, so beta/99/0 → 1.0 × 2 × 1 = 2.0
  approx(rawWeight({ tier: "beta", attestedCount30d: 99, monthsInNetwork: 0 }), 2.0, 1e-9, "months=0");
  approx(rawWeight({ tier: "beta", attestedCount30d: 99, monthsInNetwork: -5 }), 2.0, 1e-9, "months=-5");
});

test("negative attestedCount30d clamped to 0", () => {
  // count clamped to 0 → log10(1) = 0 → raw = 0
  approx(rawWeight({ tier: "beta", attestedCount30d: -10, monthsInNetwork: 4 }), 0, 1e-9, "neg-count");
});

test("TIER_BASE values match spec", () => {
  assertEq(TIER_BASE.alpha, 0.5, "alpha base");
  assertEq(TIER_BASE.beta, 1.0, "beta base");
  assertEq(TIER_BASE.production, 1.5, "prod base");
});

// ─── activeCohort ────────────────────────────────────────────────────────────

console.log("\nactiveCohort:");

test("null/empty list → empty", () => {
  assertEq(activeCohort(null, defaultPolicy(), NOW), [], "null");
  assertEq(activeCohort([], defaultPolicy(), NOW), [], "empty");
});

test("status=beta excluded", () => {
  const p = makeProvider({ id: "beta-p", status: "beta" });
  const cohort = activeCohort([p], defaultPolicy(), NOW);
  assertEq(cohort.length, 0, "beta excluded");
});

test("status=alpha excluded", () => {
  const p = makeProvider({ id: "alpha-p", status: "alpha" });
  const cohort = activeCohort([p], defaultPolicy(), NOW);
  assertEq(cohort.length, 0, "alpha excluded");
});

test("status=production but lastAttestAt > 7d old excluded", () => {
  const p = makeProvider({ id: "stale", lastAttestAt: NOW - 8 * DAY_MS });
  const cohort = activeCohort([p], defaultPolicy(), NOW);
  assertEq(cohort.length, 0, "stale excluded");
});

test("status=production, recent, but distinctPubkeys < 25 excluded", () => {
  const p = makeProvider({ id: "narrow", distinctPubkeysAttested30d: 10 });
  const cohort = activeCohort([p], defaultPolicy(), NOW);
  assertEq(cohort.length, 0, "narrow excluded");
});

test("missing lastAttestAt excluded", () => {
  const p = makeProvider({ id: "no-attest", lastAttestAt: null });
  const cohort = activeCohort([p], defaultPolicy(), NOW);
  assertEq(cohort.length, 0, "null lastAttestAt excluded");
});

test("raw_weight=0 (unknown tier) excluded", () => {
  const p = makeProvider({ id: "no-tier", tier: "platinum" });
  const cohort = activeCohort([p], defaultPolicy(), NOW);
  assertEq(cohort.length, 0, "no-tier excluded");
});

test("provider with all criteria met included", () => {
  const p = makeProvider({ id: "good" });
  const cohort = activeCohort([p], defaultPolicy(), NOW);
  assertEq(cohort.length, 1, "good included");
  assertEq(cohort[0].id, "good", "good id");
});

test("custom policy: pubkey_reach_threshold=5 lets in narrower providers", () => {
  const p = makeProvider({ id: "narrow-but-ok", distinctPubkeysAttested30d: 10 });
  const policy = { ...defaultPolicy(), pubkey_reach_threshold: 5 };
  const cohort = activeCohort([p], policy, NOW);
  assertEq(cohort.length, 1, "narrow-but-ok in with lower threshold");
});

test("custom policy: active_window_days=30 lets in older attesters", () => {
  const p = makeProvider({ id: "old-but-ok", lastAttestAt: NOW - 20 * DAY_MS });
  const policy = { ...defaultPolicy(), active_window_days: 30 };
  const cohort = activeCohort([p], policy, NOW);
  assertEq(cohort.length, 1, "old-but-ok in with wider window");
});

test("mixed list: only qualifying providers returned", () => {
  const good = makeProvider({ id: "good" });
  const beta = makeProvider({ id: "beta-p", status: "beta" });
  const stale = makeProvider({ id: "stale", lastAttestAt: NOW - 30 * DAY_MS });
  const narrow = makeProvider({ id: "narrow", distinctPubkeysAttested30d: 1 });
  const cohort = activeCohort([good, beta, stale, narrow], defaultPolicy(), NOW);
  assertEq(cohort.length, 1, "one of four qualifies");
  assertEq(cohort[0].id, "good", "good qualifies");
});

// ─── networkMedian ───────────────────────────────────────────────────────────

console.log("\nnetworkMedian:");

test("empty cohort → 0", () => {
  assertEq(networkMedian([]), 0, "empty");
  assertEq(networkMedian(null), 0, "null");
});

test("odd-length cohort (raw weights 3, 5, 7) → 5", () => {
  // Synthesize providers whose rawWeight is exactly 3, 5, 7 by choosing inputs.
  // Easier: use the helper to pre-compute rawWeight, then arrange the providers.
  // rawWeight for beta/count=99/months=N is 2 × sqrt(N).
  // 3 → sqrt(N)=1.5 → N=2.25; 5 → 2.5 → 6.25; 7 → 3.5 → 12.25.
  const a = makeProvider({ id: "a", tier: "beta", attestedCount30d: 99, monthsInNetwork: 2.25 });
  const b = makeProvider({ id: "b", tier: "beta", attestedCount30d: 99, monthsInNetwork: 6.25 });
  const c = makeProvider({ id: "c", tier: "beta", attestedCount30d: 99, monthsInNetwork: 12.25 });
  approx(networkMedian([a, b, c]), 5, 1e-9, "median of 3,5,7");
});

test("even-length cohort (1, 3, 5, 7) → 4", () => {
  // rawWeight = 2 × sqrt(N): 1→0.25, 3→2.25, 5→6.25, 7→12.25
  const a = makeProvider({ id: "a", tier: "beta", attestedCount30d: 99, monthsInNetwork: 0.25 });
  const b = makeProvider({ id: "b", tier: "beta", attestedCount30d: 99, monthsInNetwork: 2.25 });
  const c = makeProvider({ id: "c", tier: "beta", attestedCount30d: 99, monthsInNetwork: 6.25 });
  const d = makeProvider({ id: "d", tier: "beta", attestedCount30d: 99, monthsInNetwork: 12.25 });
  approx(networkMedian([a, b, c, d]), 4, 1e-9, "median of 1,3,5,7");
});

test("single-element cohort → that element's rawWeight", () => {
  // beta/99/4 → 4.0
  const p = makeProvider({ id: "p", tier: "beta", attestedCount30d: 99, monthsInNetwork: 4 });
  approx(networkMedian([p]), 4.0, 1e-9, "single = 4");
});

test("unsorted input handled (sorted internally)", () => {
  // months 6.25, 0.25, 12.25, 2.25 → raws 5, 1, 7, 3 → sorted 1,3,5,7 → median 4
  const a = makeProvider({ id: "a", tier: "beta", attestedCount30d: 99, monthsInNetwork: 6.25 });
  const b = makeProvider({ id: "b", tier: "beta", attestedCount30d: 99, monthsInNetwork: 0.25 });
  const c = makeProvider({ id: "c", tier: "beta", attestedCount30d: 99, monthsInNetwork: 12.25 });
  const d = makeProvider({ id: "d", tier: "beta", attestedCount30d: 99, monthsInNetwork: 2.25 });
  approx(networkMedian([a, b, c, d]), 4, 1e-9, "unsorted → 4");
});

// ─── weight (final) ──────────────────────────────────────────────────────────

console.log("\nweight:");

test("below cap, in cohort, no disputes → returns rawWeight", () => {
  // Cohort of 3 producers with raws 3,5,7 → median 5 → cap = 15.
  // Subject raw = 4.0 (beta/99/4), in cohort, no disputes → expect 4.0.
  const a = makeProvider({ id: "a", tier: "beta", attestedCount30d: 99, monthsInNetwork: 2.25 });
  const b = makeProvider({ id: "b", tier: "beta", attestedCount30d: 99, monthsInNetwork: 6.25 });
  const c = makeProvider({ id: "c", tier: "beta", attestedCount30d: 99, monthsInNetwork: 12.25 });
  // But beta status doesn't qualify for the cohort — promote to production status.
  // The TIER (beta) drives rawWeight; the STATUS field is what cohort filters on.
  [a, b, c].forEach(p => { p.status = "production"; });
  const subject = { ...a, id: "subject" };
  const cohort = activeCohort([a, b, c, subject], defaultPolicy(), NOW);
  assertEq(cohort.length, 4, "all 4 in cohort");
  // median of 3,5,7,3 sorted (3,3,5,7) → (3+5)/2 = 4. cap = 12. subject raw = 3.
  // Hmm — subject has raw=3 (same as a). To test "below cap", that's fine: 3 < 12.
  const w = weight(subject, cohort, defaultPolicy(), NOW);
  approx(w, 3, 1e-9, "subject = raw, below cap");
});

test("above cap → capped at cap_multiple_of_active_median × median", () => {
  // Cohort medians: 3 providers raws 1, 2, 3 → median 2 → cap = 6.
  const lo = makeProvider({ id: "lo", tier: "alpha", attestedCount30d: 99, monthsInNetwork: 4 }); // 0.5*2*2 = 2.0
  const mid = makeProvider({ id: "mid", tier: "alpha", attestedCount30d: 99, monthsInNetwork: 9 }); // 0.5*2*3 = 3.0
  const hi  = makeProvider({ id: "hi",  tier: "alpha", attestedCount30d: 99, monthsInNetwork: 1 }); // 0.5*2*1 = 1.0
  const cohort = activeCohort([lo, mid, hi], defaultPolicy(), NOW);
  assertEq(cohort.length, 3, "3 in cohort");
  // median of 1,2,3 = 2. cap = 6.
  // Whale subject: production/999/9 → 13.5.
  const whale = makeProvider({
    id: "whale", tier: "production", status: "production",
    attestedCount30d: 999, monthsInNetwork: 9,
  });
  const w = weight(whale, cohort, defaultPolicy(), NOW);
  approx(w, 6, 1e-9, "whale capped at 6");
});

test("below floor, in cohort, no disputes → returns floor", () => {
  // Cohort with median 5 → cap 15. Subject raw is tiny (alpha/9/1 = 0.5*log10(10)*1 = 0.5).
  // Floor 0.3 < 0.5, so floor doesn't actually pull up here. Need a smaller raw.
  // alpha/1/1 → 0.5 × log10(2) × 1 ≈ 0.1505. Below floor 0.3.
  const peers = [
    makeProvider({ id: "p1", tier: "beta", attestedCount30d: 99, monthsInNetwork: 2.25 }),
    makeProvider({ id: "p2", tier: "beta", attestedCount30d: 99, monthsInNetwork: 6.25 }),
    makeProvider({ id: "p3", tier: "beta", attestedCount30d: 99, monthsInNetwork: 12.25 }),
  ];
  const subject = makeProvider({
    id: "tiny", tier: "alpha", attestedCount30d: 1, monthsInNetwork: 1,
  });
  const cohort = activeCohort([...peers, subject], defaultPolicy(), NOW);
  assertEq(cohort.length, 4, "subject is in cohort");
  const w = weight(subject, cohort, defaultPolicy(), NOW);
  approx(w, 0.3, 1e-9, "floored up to 0.3");
});

test("below floor, NOT in cohort → returns rawWeight (no floor)", () => {
  // Subject is status=beta so excluded from cohort. Floor should NOT apply.
  const peers = [
    makeProvider({ id: "p1", tier: "beta", attestedCount30d: 99, monthsInNetwork: 2.25 }),
    makeProvider({ id: "p2", tier: "beta", attestedCount30d: 99, monthsInNetwork: 6.25 }),
    makeProvider({ id: "p3", tier: "beta", attestedCount30d: 99, monthsInNetwork: 12.25 }),
  ];
  // beta-tier subject with raw weight ~0.15, status=beta so excluded.
  const subject = makeProvider({
    id: "newbie",
    tier: "beta",
    status: "beta",            // excluded from cohort
    attestedCount30d: 1,
    monthsInNetwork: 1,
  });
  // raw = 1.0 × log10(2) × 1 ≈ 0.301; below cap, above floor barely. Let's go smaller.
  const subjectAlpha = {
    ...subject,
    tier: "alpha",
    attestedCount30d: 1,
  };
  // raw = 0.5 × log10(2) × 1 ≈ 0.1505
  const cohort = activeCohort(peers, defaultPolicy(), NOW);
  assertEq(cohort.length, 3, "3 peers in cohort, subject excluded");
  const w = weight(subjectAlpha, cohort, defaultPolicy(), NOW);
  approx(w, 0.1505, 0.001, "no floor applied → raw");
});

test("below floor, in cohort, recent dispute → returns rawWeight (no floor)", () => {
  const peers = [
    makeProvider({ id: "p1", tier: "beta", attestedCount30d: 99, monthsInNetwork: 2.25 }),
    makeProvider({ id: "p2", tier: "beta", attestedCount30d: 99, monthsInNetwork: 6.25 }),
    makeProvider({ id: "p3", tier: "beta", attestedCount30d: 99, monthsInNetwork: 12.25 }),
  ];
  const subject = makeProvider({
    id: "disputed",
    tier: "alpha",
    attestedCount30d: 1,
    monthsInNetwork: 1,
    lastDisputeAt: NOW - 15 * DAY_MS, // recent
  });
  const cohort = activeCohort([...peers, subject], defaultPolicy(), NOW);
  assertEq(cohort.length, 4, "subject still in cohort");
  const w = weight(subject, cohort, defaultPolicy(), NOW);
  // raw = 0.5 × log10(2) ≈ 0.1505. No floor → 0.1505.
  approx(w, 0.1505, 0.001, "recent dispute blocks floor");
});

test("recent dispute exactly 30d ago → still 'recent' (floor blocked)", () => {
  const peers = [
    makeProvider({ id: "p1", tier: "beta", attestedCount30d: 99, monthsInNetwork: 2.25 }),
    makeProvider({ id: "p2", tier: "beta", attestedCount30d: 99, monthsInNetwork: 6.25 }),
    makeProvider({ id: "p3", tier: "beta", attestedCount30d: 99, monthsInNetwork: 12.25 }),
  ];
  const subject = makeProvider({
    id: "boundary",
    tier: "alpha",
    attestedCount30d: 1,
    monthsInNetwork: 1,
    lastDisputeAt: NOW - 30 * DAY_MS, // boundary: (now - x) > 30d → false
  });
  const cohort = activeCohort([...peers, subject], defaultPolicy(), NOW);
  const w = weight(subject, cohort, defaultPolicy(), NOW);
  approx(w, 0.1505, 0.001, "boundary dispute blocks floor");
});

test("empty cohort → cap=0, no floor possible → weight=0 regardless of raw", () => {
  const subject = makeProvider({ id: "lone", tier: "production", status: "production",
    attestedCount30d: 999, monthsInNetwork: 9 });
  // raw = 13.5 but cohort empty → median 0 → cap 0 → min(13.5, 0) = 0; subject not in [].
  const w = weight(subject, [], defaultPolicy(), NOW);
  assertEq(w, 0, "cold-start weight = 0");
});

test("null provider → 0", () => {
  assertEq(weight(null, [], defaultPolicy(), NOW), 0, "null subject");
});

test("custom policy: floor_weight=0.5 lifts more aggressively", () => {
  const peers = [
    makeProvider({ id: "p1", tier: "beta", attestedCount30d: 99, monthsInNetwork: 2.25 }),
    makeProvider({ id: "p2", tier: "beta", attestedCount30d: 99, monthsInNetwork: 6.25 }),
    makeProvider({ id: "p3", tier: "beta", attestedCount30d: 99, monthsInNetwork: 12.25 }),
  ];
  const subject = makeProvider({
    id: "tiny", tier: "alpha", attestedCount30d: 1, monthsInNetwork: 1,
  });
  const policy = { ...defaultPolicy(), floor_weight: 0.5 };
  const cohort = activeCohort([...peers, subject], policy, NOW);
  const w = weight(subject, cohort, policy, NOW);
  approx(w, 0.5, 1e-9, "lifted to 0.5");
});

test("custom policy: cap_multiple=1 binds tighter", () => {
  const lo = makeProvider({ id: "lo", tier: "alpha", attestedCount30d: 99, monthsInNetwork: 4 });
  const mid = makeProvider({ id: "mid", tier: "alpha", attestedCount30d: 99, monthsInNetwork: 9 });
  const hi = makeProvider({ id: "hi", tier: "alpha", attestedCount30d: 99, monthsInNetwork: 1 });
  const cohort = activeCohort([lo, mid, hi], defaultPolicy(), NOW);
  const whale = makeProvider({
    id: "whale", tier: "production", status: "production",
    attestedCount30d: 999, monthsInNetwork: 9,
  });
  const policy = { ...defaultPolicy(), cap_multiple_of_active_median: 1 };
  const w = weight(whale, cohort, policy, NOW);
  // median = 2, cap = 1 × 2 = 2.
  approx(w, 2, 1e-9, "cap = median when multiple=1");
});

// ─── defaultPolicy ───────────────────────────────────────────────────────────

console.log("\ndefaultPolicy:");

test("all 4 keys present with correct defaults", () => {
  const p = defaultPolicy();
  assertEq(p.pubkey_reach_threshold, 25, "pubkey_reach_threshold");
  assertEq(p.cap_multiple_of_active_median, 3, "cap_multiple_of_active_median");
  assertEq(p.floor_weight, 0.3, "floor_weight");
  assertEq(p.active_window_days, 7, "active_window_days");
  assertEq(Object.keys(p).sort(), [
    "active_window_days",
    "cap_multiple_of_active_median",
    "floor_weight",
    "pubkey_reach_threshold",
  ], "exactly 4 keys");
});

test("returns a copy (mutating result does not mutate constant)", () => {
  const a = defaultPolicy();
  a.floor_weight = 999;
  const b = defaultPolicy();
  assertEq(b.floor_weight, 0.3, "second call returns pristine defaults");
});

// ─── _internal.noDisputesInLast30d ───────────────────────────────────────────

console.log("\nnoDisputesInLast30d (internal):");

test("missing lastDisputeAt → true", () => {
  assertTrue(_internal.noDisputesInLast30d({}, NOW), "no dispute field");
  assertTrue(_internal.noDisputesInLast30d({ lastDisputeAt: null }, NOW), "null");
  assertTrue(_internal.noDisputesInLast30d({ lastDisputeAt: 0 }, NOW), "zero");
});

test("dispute 15d ago → false (is recent)", () => {
  assertFalse(_internal.noDisputesInLast30d({ lastDisputeAt: NOW - 15 * DAY_MS }, NOW), "15d");
});

test("dispute 31d ago → true (not recent)", () => {
  assertTrue(_internal.noDisputesInLast30d({ lastDisputeAt: NOW - 31 * DAY_MS }, NOW), "31d");
});

test("dispute exactly 30d ago → false (boundary is 'recent')", () => {
  assertFalse(_internal.noDisputesInLast30d({ lastDisputeAt: NOW - 30 * DAY_MS }, NOW), "30d boundary");
});

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed, ${assertions} assertions`);
process.exit(failed === 0 ? 0 : 1);
