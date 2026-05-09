const { inWhitelistWindow, recordOffense, TIERS } = require("../lib/enforcement");
const { REASONS } = require("../lib/abuse-reasons");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function makeStore() {
  const history = new Map(), bans = new Map(), permanent = new Set(), reps = new Map();
  return {
    async pushAbuseHistory(k,e){const a=history.get(k)||[];a.unshift(e);history.set(k,a);},
    async getAbuseHistory(k,since){const a=history.get(k)||[];const c=Date.now()-since;return a.filter(e=>e.ts>=c);},
    async setBan(k,v){bans.set(k,v);},
    async getBan(k){return bans.get(k)||null;},
    async clearBan(k){bans.delete(k);},
    async isPermanent(k){return permanent.has(k);},
    async addPermanent(k){permanent.add(k);},
    async getReputation(pk){return reps.get(pk)||null;},
    _setRep(pk,rec){reps.set(pk,rec);},
    _history: history, _permanent: permanent, _bans: bans,
  };
}

async function backdate(s,k,reason,tier,off){
  const a = s._history.get(k)||[];
  a.unshift({ts: Date.now()-off, reason, tier});
  s._history.set(k,a);
}

let passed=0,failed=0;
function test(n,fn){return Promise.resolve().then(fn).then(()=>{console.log(`  ✓ ${n}`);passed++;}).catch(e=>{console.error(`  ✗ ${n}\n    ${e.message}`);failed++;});}
function assertEq(a,b,l){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`${l}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);}

(async () => {
  console.log("\nx402-shield enforcement whitelist — unit tests\n");

  await test("returns false when reputation has no firstPaidAt", async () => {
    const s = makeStore();
    if (await inWhitelistWindow(s, "Pk1", 30) !== false) throw new Error();
  });

  await test("pubkey first-paid 10 days ago, 30d window → IN whitelist", async () => {
    const s = makeStore();
    s._setRep("Pk1", { firstPaidAt: Date.now() - 10*ONE_DAY_MS, paidCount: 5 });
    if (await inWhitelistWindow(s, "Pk1", 30) !== true) throw new Error();
  });

  await test("pubkey first-paid 31 days ago, 30d window → OUT", async () => {
    const s = makeStore();
    s._setRep("Pk1", { firstPaidAt: Date.now() - 31*ONE_DAY_MS, paidCount: 5 });
    if (await inWhitelistWindow(s, "Pk1", 30) !== false) throw new Error();
  });

  await test("days=0 (devnet default) → never in whitelist", async () => {
    const s = makeStore();
    s._setRep("Pk1", { firstPaidAt: Date.now() - 1000, paidCount: 1 });
    if (await inWhitelistWindow(s, "Pk1", 0) !== false) throw new Error();
  });

  // ── Integration with recordOffense: cap at tier 3 ──────────────
  console.log("\n# whitelist forces auto-tier-4 cap");

  await test("pubkey 10 days old: 3 hard bans + TIER_MAX=4 → STAYS at tier 3", async () => {
    const s = makeStore();
    s._setRep("Pk_young", { firstPaidAt: Date.now() - 10*ONE_DAY_MS, paidCount: 5 });
    // Build 2 prior hard bans + escalating to a third
    await backdate(s, "pk:Pk_young", REASONS.IP_RATE_LIMIT, 3, 1*ONE_DAY_MS);
    await backdate(s, "pk:Pk_young", REASONS.IP_RATE_LIMIT, 3, 3*ONE_DAY_MS);
    await backdate(s, "pk:Pk_young", REASONS.IP_RATE_LIMIT, 2, 6*ONE_HOUR_MS);
    await backdate(s, "pk:Pk_young", REASONS.IP_RATE_LIMIT, 2, 12*ONE_HOUR_MS);
    for (let i=0;i<2;i++) await backdate(s,"pk:Pk_young",REASONS.IP_RATE_LIMIT,1,i*30_000);
    const r = await recordOffense(s, "pk:Pk_young", REASONS.IP_RATE_LIMIT, {
      trustScore: 0,
      tierMax: 4,
      whitelistDays: 30,
      pubkeyFirstPaidAt: Date.now() - 10*ONE_DAY_MS,
    });
    assertEq(r.tier, TIERS.HARD_BAN, "capped at hard ban");
    if (s._permanent.has("pk:Pk_young")) throw new Error("must NOT promote");
  });

  await test("pubkey 31 days old: same scenario → tier 4 PERMANENT", async () => {
    const s = makeStore();
    s._setRep("Pk_old", { firstPaidAt: Date.now() - 31*ONE_DAY_MS, paidCount: 5 });
    await backdate(s, "pk:Pk_old", REASONS.IP_RATE_LIMIT, 3, 1*ONE_DAY_MS);
    await backdate(s, "pk:Pk_old", REASONS.IP_RATE_LIMIT, 3, 3*ONE_DAY_MS);
    await backdate(s, "pk:Pk_old", REASONS.IP_RATE_LIMIT, 2, 6*ONE_HOUR_MS);
    await backdate(s, "pk:Pk_old", REASONS.IP_RATE_LIMIT, 2, 12*ONE_HOUR_MS);
    for (let i=0;i<2;i++) await backdate(s,"pk:Pk_old",REASONS.IP_RATE_LIMIT,1,i*30_000);
    const r = await recordOffense(s, "pk:Pk_old", REASONS.IP_RATE_LIMIT, {
      trustScore: 0,
      tierMax: 4,
      whitelistDays: 30,
      pubkeyFirstPaidAt: Date.now() - 31*ONE_DAY_MS,
    });
    assertEq(r.tier, TIERS.PERMANENT, "promoted");
  });

  console.log(`\n${passed}/${passed+failed} whitelist tests passed.`);
  if (failed) process.exit(1);
})();
