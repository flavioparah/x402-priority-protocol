const { recordOffense, checkBan, TIERS } = require("../lib/enforcement");
const { REASONS } = require("../lib/abuse-reasons");

const FIVE_MIN_MS  = 5 * 60 * 1000;
const ONE_HOUR_MS  = 60 * 60 * 1000;
const ONE_DAY_MS   = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS= 7 * ONE_DAY_MS;

// Deterministic fake store — supports `now` injection for time-travel.
function makeFakeStore() {
  const history = new Map();    // key → [{ts, reason, tier}]
  const bans = new Map();
  const permanent = new Set();
  return {
    async pushAbuseHistory(key, event, _ttlMs) {
      const arr = history.get(key) || [];
      arr.unshift(event);
      history.set(key, arr);
    },
    async getAbuseHistory(key, sinceMs) {
      const arr = history.get(key) || [];
      const cutoff = Date.now() - sinceMs;
      return arr.filter(e => e.ts >= cutoff);
    },
    async setBan(key, value, _ttlMs) { bans.set(key, value); },
    async getBan(key) { return bans.get(key) || null; },
    async clearBan(key) { bans.delete(key); },
    async isPermanent(key) { return permanent.has(key); },
    async addPermanent(key, _meta) { permanent.add(key); },
    // Test introspection
    _history: history,
    _bans: bans,
    _permanent: permanent,
  };
}

// Time-travel helper: insert an event with a specific past timestamp
async function backdateOffense(store, key, reason, tier, tsOffsetMs) {
  const arr = store._history.get(key) || [];
  arr.unshift({ ts: Date.now() - tsOffsetMs, reason, tier });
  store._history.set(key, arr);
}

let passed = 0, failed = 0;
function test(n, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✓ ${n}`); passed++; })
    .catch(e => { console.error(`  ✗ ${n}\n    ${e.message}`); failed++; });
}
function assertEq(a, b, l) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${l}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

(async () => {
  console.log("\nx402-shield enforcement ladder — integration tests\n");

  // ── Tier 1 → Tier 2 escalation ─────────────────────────────────────
  console.log("# 3 throttles in 5min → soft ban (tier 2)");

  await test("first throttle: tier stays at 1", async () => {
    const s = makeFakeStore();
    const r = await recordOffense(s, "ip:1.1.1.1", REASONS.IP_RATE_LIMIT, { trustScore: 0 });
    assertEq(r.tier, TIERS.THROTTLE, "tier 1");
    assertEq(await s.getBan("ip:1.1.1.1"), null, "no ban yet");
  });

  await test("third throttle in 5min → escalates to soft ban", async () => {
    const s = makeFakeStore();
    await backdateOffense(s, "ip:2.2.2.2", REASONS.IP_RATE_LIMIT, 1, 60_000);
    await backdateOffense(s, "ip:2.2.2.2", REASONS.IP_RATE_LIMIT, 1, 30_000);
    const r = await recordOffense(s, "ip:2.2.2.2", REASONS.IP_RATE_LIMIT, { trustScore: 0 });
    assertEq(r.tier, TIERS.SOFT_BAN, "tier escalated");
    const ban = await s.getBan("ip:2.2.2.2");
    if (!ban || ban.tier !== 2) throw new Error("soft ban not set");
    if (ban.until <= Math.floor(Date.now()/1000)) throw new Error("until in past");
  });

  await test("3 throttles spread > 5min → no escalation", async () => {
    const s = makeFakeStore();
    await backdateOffense(s, "ip:3.3.3.3", REASONS.IP_RATE_LIMIT, 1, 6 * 60_000);
    await backdateOffense(s, "ip:3.3.3.3", REASONS.IP_RATE_LIMIT, 1, 7 * 60_000);
    const r = await recordOffense(s, "ip:3.3.3.3", REASONS.IP_RATE_LIMIT, { trustScore: 0 });
    assertEq(r.tier, TIERS.THROTTLE, "stays tier 1");
  });

  // ── Invalid signature burst (parallel trigger for tier 2) ──────────
  console.log("\n# 10 invalid-signature events in 60s → soft ban");

  await test("10th invalid-sig event in 60s → tier 2", async () => {
    const s = makeFakeStore();
    for (let i = 0; i < 9; i++) {
      await backdateOffense(s, "ip:4.4.4.4", REASONS.INVALID_SIGNATURE_BURST, 1, i * 5_000);
    }
    const r = await recordOffense(s, "ip:4.4.4.4", REASONS.INVALID_SIGNATURE_BURST, { trustScore: 0 });
    assertEq(r.tier, TIERS.SOFT_BAN, "burst escalates");
  });

  // ── Tier 2 → Tier 3 ────────────────────────────────────────────────
  console.log("\n# 3 soft bans in 24h → hard ban (tier 3)");

  await test("third soft ban in 24h → escalates to hard ban", async () => {
    const s = makeFakeStore();
    // Two prior soft bans within 24h
    await backdateOffense(s, "ip:5.5.5.5", REASONS.IP_RATE_LIMIT, 2, 6 * ONE_HOUR_MS);
    await backdateOffense(s, "ip:5.5.5.5", REASONS.IP_RATE_LIMIT, 2, 12 * ONE_HOUR_MS);
    // Trigger a third
    for (let i = 0; i < 2; i++) {
      await backdateOffense(s, "ip:5.5.5.5", REASONS.IP_RATE_LIMIT, 1, i * 30_000);
    }
    const r = await recordOffense(s, "ip:5.5.5.5", REASONS.IP_RATE_LIMIT, { trustScore: 0 });
    assertEq(r.tier, TIERS.HARD_BAN, "tier 3");
    const ban = await s.getBan("ip:5.5.5.5");
    if (ban.tier !== 3) throw new Error(`ban tier ${ban.tier}`);
  });

  await test("detection signal + 1 throttle → hard ban shortcut", async () => {
    const s = makeFakeStore();
    const r = await recordOffense(s, "pk:Abc", REASONS.IP_RATE_LIMIT, {
      trustScore: 0,
      fraudSignals: [REASONS.WASH_PAYMENT],
    });
    assertEq(r.tier, TIERS.HARD_BAN, "shortcut to tier 3");
  });

  // ── Tier 3 → Tier 4 (gated by ENFORCEMENT_TIER_MAX) ────────────────
  console.log("\n# 3 hard bans in 7d behavior depends on ENFORCEMENT_TIER_MAX");

  await test("with TIER_MAX=4: 3 hard bans in 7d → permanent", async () => {
    const s = makeFakeStore();
    await backdateOffense(s, "ip:6.6.6.6", REASONS.IP_RATE_LIMIT, 3, 1 * ONE_DAY_MS);
    await backdateOffense(s, "ip:6.6.6.6", REASONS.IP_RATE_LIMIT, 3, 3 * ONE_DAY_MS);
    // Build up to a third hard ban: 2 prior soft bans in 24h, then trigger
    await backdateOffense(s, "ip:6.6.6.6", REASONS.IP_RATE_LIMIT, 2, 6 * ONE_HOUR_MS);
    await backdateOffense(s, "ip:6.6.6.6", REASONS.IP_RATE_LIMIT, 2, 12 * ONE_HOUR_MS);
    for (let i = 0; i < 2; i++) {
      await backdateOffense(s, "ip:6.6.6.6", REASONS.IP_RATE_LIMIT, 1, i * 30_000);
    }
    const r = await recordOffense(s, "ip:6.6.6.6", REASONS.IP_RATE_LIMIT, {
      trustScore: 0,
      tierMax: 4,
      whitelistDays: 0,
    });
    assertEq(r.tier, TIERS.PERMANENT, "promoted to permanent");
    if (!s._permanent.has("ip:6.6.6.6")) throw new Error("addPermanent not called");
  });

  await test("with TIER_MAX=3: same scenario stops at hard ban (no promotion)", async () => {
    const s = makeFakeStore();
    await backdateOffense(s, "ip:7.7.7.7", REASONS.IP_RATE_LIMIT, 3, 1 * ONE_DAY_MS);
    await backdateOffense(s, "ip:7.7.7.7", REASONS.IP_RATE_LIMIT, 3, 3 * ONE_DAY_MS);
    await backdateOffense(s, "ip:7.7.7.7", REASONS.IP_RATE_LIMIT, 2, 6 * ONE_HOUR_MS);
    await backdateOffense(s, "ip:7.7.7.7", REASONS.IP_RATE_LIMIT, 2, 12 * ONE_HOUR_MS);
    for (let i = 0; i < 2; i++) {
      await backdateOffense(s, "ip:7.7.7.7", REASONS.IP_RATE_LIMIT, 1, i * 30_000);
    }
    const r = await recordOffense(s, "ip:7.7.7.7", REASONS.IP_RATE_LIMIT, {
      trustScore: 0,
      tierMax: 3,
      whitelistDays: 0,
    });
    assertEq(r.tier, TIERS.HARD_BAN, "capped at hard ban");
    if (s._permanent.has("ip:7.7.7.7")) throw new Error("must NOT add permanent");
  });

  await test("history entry written for every offense", async () => {
    const s = makeFakeStore();
    await recordOffense(s, "ip:8.8.8.8", REASONS.IP_RATE_LIMIT, { trustScore: 0 });
    const arr = s._history.get("ip:8.8.8.8");
    if (!arr || arr.length !== 1) throw new Error(`history len ${arr?.length}`);
    if (arr[0].reason !== REASONS.IP_RATE_LIMIT) throw new Error("reason mismatch");
  });

  await test("returns full state object {tier, until, reason, history_summary}", async () => {
    const s = makeFakeStore();
    const r = await recordOffense(s, "ip:9.9.9.9", REASONS.IP_RATE_LIMIT, { trustScore: 0 });
    if (typeof r.tier !== "number") throw new Error("tier missing");
    if (typeof r.reason !== "string") throw new Error("reason missing");
    if (!r.history_summary || typeof r.history_summary.throttles_5m !== "number")
      throw new Error("history_summary missing");
  });

  console.log(`\n${passed}/${passed+failed} ladder tests passed.`);
  if (failed) process.exit(1);
})();
