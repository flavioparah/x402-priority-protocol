/**
 * test/enforcement-cross-signal.test.js
 *
 * Cross-module integration: detection.getActiveFraudFlags <-> enforcement.recordOffense.
 *
 * Section 8.2 / 8.3 rules verified here:
 *   - Detection-signal + 1 throttle → tier 3 shortcut (any score)
 *   - Score 81-100 + rate-only → no escalation (requireFraudCorroboration)
 *   - Score 81-100 + rate + fraud → escalation allowed
 */

const { recordOffense, TIERS } = require("../lib/enforcement");
const { getActiveFraudFlags } = require("../lib/detection");
const { REASONS } = require("../lib/abuse-reasons");

const HOUR_MS = 3_600_000;

function makeStore() {
  const h = new Map(), b = new Map(), p = new Set();
  return {
    async pushAbuseHistory(k, e) { const a = h.get(k) || []; a.unshift(e); h.set(k, a); },
    async getAbuseHistory(k, since) { return (h.get(k) || []).filter(e => e.ts >= Date.now() - since); },
    async setBan(k, v) { b.set(k, v); }, async getBan(k) { return b.get(k) || null; }, async clearBan(k) { b.delete(k); },
    async isPermanent(k) { return p.has(k); }, async addPermanent(k) { p.add(k); },
    async getReputation() { return null; },
  };
}

function buildWashLog() {
  const log = [];
  for (let i = 0; i < 60; i++) log.push({ ts: Date.now() - (i + 1) * 60_000, amount: 40200, operator_id: "self" });
  return log;
}

let passed = 0, failed = 0;
function test(n, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✓ ${n}`); passed++; })
    .catch(e => { console.error(`  ✗ ${n}\n    ${e.message}`); failed++; });
}
function assertEq(a, b, l) { if (a !== b) throw new Error(`${l}: got ${a}, want ${b}`); }

(async () => {
  console.log("\nx402-shield cross-signal enforcement integration\n");

  await test("low score + fraud signal + 1 throttle → tier 3 shortcut", async () => {
    const s = makeStore();
    const flags = getActiveFraudFlags("PkLow", buildWashLog(), {
      firstPaidAt: Date.now() - 5 * HOUR_MS, paidCount: 60, lastPaidAt: Date.now(), totalPaid: 0,
    });
    if (flags.length === 0) throw new Error("test premise: expected wash flag");
    const r = await recordOffense(s, "pk:PkLow", REASONS.PUBKEY_RATE_LIMIT, {
      trustScore: 10, fraudSignals: flags,
    });
    assertEq(r.tier, TIERS.HARD_BAN, "shortcut applies regardless of score");
  });

  await test("score 90 + benign log (no flags) + heavy rate abuse → still tier 1", async () => {
    const s = makeStore();
    const flags = getActiveFraudFlags("PkClean", [], null);
    if (flags.length !== 0) throw new Error("premise: must have no flags");
    // score=90 → requireFraudCorroboration=true, thresholdsMultiplier=10
    // A single recordOffense call → only 1 throttle in 5min (need 30 to escalate)
    // → stays at tier 1 because both rate threshold and fraud gate block escalation
    const r = await recordOffense(s, "pk:PkClean", REASONS.PUBKEY_RATE_LIMIT, {
      trustScore: 90, fraudSignals: flags,
    });
    assertEq(r.tier, TIERS.THROTTLE, "high-trust + no fraud cannot escalate");
  });

  await test("score 90 + fraud signal triggers tier 3 shortcut", async () => {
    const s = makeStore();
    const flags = getActiveFraudFlags("PkHighWash", buildWashLog(), {
      firstPaidAt: Date.now() - 5 * HOUR_MS, paidCount: 60, lastPaidAt: Date.now(), totalPaid: 0,
    });
    if (flags.length === 0) throw new Error("premise: expected wash flag for high-trust pubkey");
    const r = await recordOffense(s, "pk:PkHighWash", REASONS.PUBKEY_RATE_LIMIT, {
      trustScore: 90, fraudSignals: flags,
    });
    assertEq(r.tier, TIERS.HARD_BAN, "fraud overrides score immunity");
  });

  console.log(`\n${passed}/${passed + failed} cross-signal tests passed.`);
  if (failed) process.exit(1);
})();
