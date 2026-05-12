/**
 * test/permanent-ban-promotion.test.js
 *
 * Pinned regression for Section 8.1's normative tier-4 rule:
 *   - Default mainnet (ENFORCEMENT_TIER_MAX=3) NEVER auto-promotes to tier 4,
 *     no matter how many hard bans accumulate.
 *   - With ENFORCEMENT_TIER_MAX=4 + whitelist expired + score allows + 3 hard
 *     bans in 7d, auto-promotion fires.
 *   - Manual addPermanent (simulating /admin/ban from Phase 4) is the ONLY
 *     remaining route to permanent under default mainnet.
 */

const { recordOffense, checkBan, TIERS } = require("../lib/enforcement");
const { REASONS } = require("../lib/abuse-reasons");

const ONE_DAY_MS = 86_400_000, ONE_HOUR_MS = 3_600_000;

function makeStore() {
  const history = new Map(), bans = new Map(), perm = new Set(), reps = new Map();
  return {
    async pushAbuseHistory(k, e) { const a = history.get(k) || []; a.unshift(e); history.set(k, a); },
    async getAbuseHistory(k, since) { return (history.get(k) || []).filter(e => e.ts >= Date.now() - since); },
    async setBan(k, v) { bans.set(k, v); },
    async getBan(k) { return bans.get(k) || null; },
    async clearBan(k) { bans.delete(k); },
    async isPermanent(k) { return perm.has(k); },
    async addPermanent(k) { perm.add(k); },
    async getReputation(pk) { return reps.get(pk) || null; },
    _hist: history, _perm: perm, _setRep(pk, r) { reps.set(pk, r); },
  };
}

async function backdate(s, k, reason, tier, off) {
  const a = s._hist.get(k) || []; a.unshift({ ts: Date.now() - off, reason, tier }); s._hist.set(k, a);
}

async function buildHardBanScenario(s, key) {
  // 2 hard bans deep in past (within 7d window)
  await backdate(s, key, REASONS.IP_RATE_LIMIT, 3, 1 * ONE_DAY_MS);
  await backdate(s, key, REASONS.IP_RATE_LIMIT, 3, 3 * ONE_DAY_MS);
  // Then: stack 2 soft bans in last 24h
  await backdate(s, key, REASONS.IP_RATE_LIMIT, 2, 6 * ONE_HOUR_MS);
  await backdate(s, key, REASONS.IP_RATE_LIMIT, 2, 12 * ONE_HOUR_MS);
  // Plus 2 throttles in last 5min — triggering call adds the third
  for (let i = 0; i < 2; i++) await backdate(s, key, REASONS.IP_RATE_LIMIT, 1, i * 30_000);
}

let passed = 0, failed = 0;
function test(n, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✓ ${n}`); passed++; })
    .catch(e => { console.error(`  ✗ ${n}\n    ${e.message}`); failed++; });
}
function assertEq(a, b, l) { if (a !== b) throw new Error(`${l}: got ${a}, want ${b}`); }

(async () => {
  console.log("\nx402-shield permanent-ban promotion guard\n");

  await test("ENFORCEMENT_TIER_MAX=3: 3 hard bans in 7d → STAYS at tier 3", async () => {
    const s = makeStore();
    await buildHardBanScenario(s, "ip:flood-1");
    const r = await recordOffense(s, "ip:flood-1", REASONS.IP_RATE_LIMIT, {
      trustScore: 0, tierMax: 3, whitelistDays: 0,
    });
    assertEq(r.tier, TIERS.HARD_BAN, "must cap at hard ban");
    if (s._perm.has("ip:flood-1")) throw new Error("must NOT add permanent");
  });

  await test("ENFORCEMENT_TIER_MAX=3: even 10 hard bans → STAYS at tier 3", async () => {
    const s = makeStore();
    for (let i = 0; i < 10; i++) {
      await backdate(s, "ip:repeat", REASONS.IP_RATE_LIMIT, 3, (i + 1) * 12 * ONE_HOUR_MS);
    }
    await backdate(s, "ip:repeat", REASONS.IP_RATE_LIMIT, 2, 6 * ONE_HOUR_MS);
    await backdate(s, "ip:repeat", REASONS.IP_RATE_LIMIT, 2, 12 * ONE_HOUR_MS);
    for (let i = 0; i < 2; i++) await backdate(s, "ip:repeat", REASONS.IP_RATE_LIMIT, 1, i * 30_000);
    const r = await recordOffense(s, "ip:repeat", REASONS.IP_RATE_LIMIT, {
      trustScore: 0, tierMax: 3, whitelistDays: 0,
    });
    assertEq(r.tier, TIERS.HARD_BAN, "10 hard bans + TIER_MAX=3 must NOT promote");
  });

  await test("ENFORCEMENT_TIER_MAX=4 + score 0 + whitelist expired: promotes", async () => {
    const s = makeStore();
    await buildHardBanScenario(s, "ip:devnet-1");
    const r = await recordOffense(s, "ip:devnet-1", REASONS.IP_RATE_LIMIT, {
      trustScore: 0, tierMax: 4, whitelistDays: 0,
    });
    assertEq(r.tier, TIERS.PERMANENT, "auto-permanent fires under devnet config");
  });

  await test("ENFORCEMENT_TIER_MAX=4 but pubkey in whitelist: stays tier 3", async () => {
    const s = makeStore();
    s._setRep("FreshPk", { firstPaidAt: Date.now() - 10 * ONE_DAY_MS, paidCount: 5 });
    await buildHardBanScenario(s, "pk:FreshPk");
    const r = await recordOffense(s, "pk:FreshPk", REASONS.IP_RATE_LIMIT, {
      trustScore: 0, tierMax: 4, whitelistDays: 30,
      pubkeyFirstPaidAt: Date.now() - 10 * ONE_DAY_MS,
    });
    assertEq(r.tier, TIERS.HARD_BAN, "whitelist must cap at hard ban");
  });

  await test("ENFORCEMENT_TIER_MAX=4 but score 60 (≥51): stays tier 3", async () => {
    const s = makeStore();
    await buildHardBanScenario(s, "pk:HighTrust");
    const r = await recordOffense(s, "pk:HighTrust", REASONS.IP_RATE_LIMIT, {
      trustScore: 60, tierMax: 4, whitelistDays: 0,
    });
    if (r.tier === TIERS.PERMANENT) throw new Error("score 60 must not auto-promote");
  });

  await test("manual addPermanent path (simulates /admin/ban from Phase 4)", async () => {
    const s = makeStore();
    await s.addPermanent("ip:operator-action", { reason: "manual", by: "ops-2026-05" });
    const status = await checkBan(s, "ip:operator-action");
    assertEq(status.tier, TIERS.PERMANENT, "manual permanent works regardless of TIER_MAX");
  });

  console.log(`\n${passed}/${passed + failed} permanent-ban tests passed.`);
  if (failed) process.exit(1);
})();
