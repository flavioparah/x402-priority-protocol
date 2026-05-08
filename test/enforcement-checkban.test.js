const { checkBan, TIERS, TRUST_IMPACT } = require("../lib/enforcement");

// In-memory fake store (mirrors what Phase 2 store primitives provide)
function makeFakeStore() {
  const permanent = new Set();
  const bans = new Map();
  return {
    async isPermanent(k) { return permanent.has(k); },
    async getBan(k) { return bans.get(k) || null; },
    _setPermanent(k) { permanent.add(k); },
    _setBan(k, v) { bans.set(k, v); },
  };
}

let passed = 0, failed = 0;
function test(n, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${n}`); passed++; })
    .catch(e => { console.error(`  ✗ ${n}\n    ${e.message}`); failed++; });
}
function assertEq(a, b, l) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${l}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

(async () => {
  console.log("\nx402-shield enforcement.checkBan — unit tests\n");

  await test("returns null for clean key", async () => {
    const s = makeFakeStore();
    assertEq(await checkBan(s, "ip:1.2.3.4"), null);
  });

  await test("returns tier 4 permanent for key in permanent set", async () => {
    const s = makeFakeStore();
    s._setPermanent("ip:1.2.3.4");
    const result = await checkBan(s, "ip:1.2.3.4");
    if (result.tier !== TIERS.PERMANENT) throw new Error(`tier=${result?.tier}`);
    if (result.until !== null) throw new Error("permanent must have until=null");
  });

  await test("returns tier 2 with until + reason for active soft ban", async () => {
    const s = makeFakeStore();
    const until = Math.floor(Date.now() / 1000) + 300;
    s._setBan("ip:1.2.3.4", { tier: 2, until, reason: "ip-rate-limit" });
    const result = await checkBan(s, "ip:1.2.3.4");
    assertEq(result, { tier: 2, until, reason: "ip-rate-limit" }, "soft ban shape");
  });

  await test("returns tier 3 for active hard ban", async () => {
    const s = makeFakeStore();
    const until = Math.floor(Date.now() / 1000) + 3600;
    s._setBan("pk:Abc", { tier: 3, until, reason: "wash-payment" });
    const result = await checkBan(s, "pk:Abc");
    if (result.tier !== 3) throw new Error(`tier=${result.tier}`);
  });

  await test("permanent takes precedence over a stale soft/hard ban entry", async () => {
    const s = makeFakeStore();
    s._setPermanent("ip:5.5.5.5");
    s._setBan("ip:5.5.5.5", { tier: 2, until: Date.now()/1000 + 60, reason: "ip-rate-limit" });
    const result = await checkBan(s, "ip:5.5.5.5");
    if (result.tier !== TIERS.PERMANENT) throw new Error("permanent must win");
  });

  await test("TIERS export uses canonical 0..4 numbers", () => {
    assertEq(TIERS.WARNING,   0);
    assertEq(TIERS.THROTTLE,  1);
    assertEq(TIERS.SOFT_BAN,  2);
    assertEq(TIERS.HARD_BAN,  3);
    assertEq(TIERS.PERMANENT, 4);
  });

  await test("TRUST_IMPACT vocabulary is closed (6 values)", () => {
    assertEq(Object.values(TRUST_IMPACT).sort(),
      ["hardban", "none", "permanent", "softban", "throttle", "warn"]);
  });

  console.log(`\n${passed}/${passed+failed} tests passed.`);
  if (failed) process.exit(1);
})();
