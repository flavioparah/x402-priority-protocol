const {
  getTrustMultiplier,
  requiresFraudCorroboration,
  tier4ImmuneByScore,
  getTrustBand,
} = require("../lib/trust-multipliers");

// ── Unit tests (sync) ────────────────────────────────────────────────────────
let n = 0, syncFailed = 0;
function check(label, cond) {
  n++;
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); syncFailed++; }
}

// getTrustMultiplier
check("score 0 → 1×",   getTrustMultiplier(0)   === 1);
check("score 20 → 1×",  getTrustMultiplier(20)  === 1);
check("score 21 → 2×",  getTrustMultiplier(21)  === 2);
check("score 50 → 2×",  getTrustMultiplier(50)  === 2);
check("score 51 → 5×",  getTrustMultiplier(51)  === 5);
check("score 80 → 5×",  getTrustMultiplier(80)  === 5);
check("score 81 → 10×", getTrustMultiplier(81)  === 10);
check("score 100 → 10×",getTrustMultiplier(100) === 10);
check("undefined score → 1×", getTrustMultiplier(undefined) === 1);
check("null score → 1×",      getTrustMultiplier(null) === 1);
check("negative score → 1×",  getTrustMultiplier(-5) === 1);
check("score >100 → 10×",     getTrustMultiplier(150) === 10);

// requiresFraudCorroboration (≥ 81)
check("requires(80) === false", requiresFraudCorroboration(80) === false);
check("requires(81) === true",  requiresFraudCorroboration(81) === true);
check("requires(100) === true", requiresFraudCorroboration(100) === true);

// tier4ImmuneByScore (≥ 51)
check("tier4Immune(50) === false", tier4ImmuneByScore(50) === false);
check("tier4Immune(51) === true",  tier4ImmuneByScore(51) === true);

// getTrustBand
check("band(10)  === '0-20'",   getTrustBand(10)  === "0-20");
check("band(35)  === '21-50'",  getTrustBand(35)  === "21-50");
check("band(70)  === '51-80'",  getTrustBand(70)  === "51-80");
check("band(95)  === '81-100'", getTrustBand(95)  === "81-100");

console.log(`\nSync: ${n - syncFailed}/${n} assertions passed.\n`);

// ── integration with recordOffense ────────────────────────────────────────────
const { recordOffense, TIERS } = require("../lib/enforcement");
const { REASONS } = require("../lib/abuse-reasons");

function makeStore() {
  const history=new Map(),bans=new Map(),perm=new Set();
  return {
    async pushAbuseHistory(k,e){const a=history.get(k)||[];a.unshift(e);history.set(k,a);},
    async getAbuseHistory(k,since){const a=history.get(k)||[];return a.filter(e=>e.ts>=Date.now()-since);},
    async setBan(k,v){bans.set(k,v);},
    async getBan(k){return bans.get(k)||null;},
    async clearBan(k){bans.delete(k);},
    async isPermanent(k){return perm.has(k);},
    async addPermanent(k){perm.add(k);},
    async getReputation(){return null;},
    _history:history,_bans:bans,_perm:perm,
  };
}
async function backdate(s,k,reason,tier,off){
  const a=s._history.get(k)||[];a.unshift({ts:Date.now()-off,reason,tier});s._history.set(k,a);
}

let passed=0,intFailed=0;
function test(name,fn){return Promise.resolve().then(fn).then(()=>{console.log(`  ✓ ${name}`);passed++;}).catch(e=>{console.error(`  ✗ ${name}\n    ${e.message}`);intFailed++;});}
function assertEq(a,b,l){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`${l||"assertEq"}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);}

console.log("\n# Trust-Score integration with recordOffense");

(async () => {
  // Score 0-20 (1× multiplier) — baseline
  await test("score 0: 3 throttles in 5min → tier 2", async () => {
    const s = makeStore();
    await backdate(s,"pk:Pk0",REASONS.PUBKEY_RATE_LIMIT,1,30_000);
    await backdate(s,"pk:Pk0",REASONS.PUBKEY_RATE_LIMIT,1,60_000);
    const r = await recordOffense(s,"pk:Pk0",REASONS.PUBKEY_RATE_LIMIT,{trustScore:0});
    assertEq(r.tier, TIERS.SOFT_BAN, "score 0 → tier 2 at 3");
  });

  // Score 21-50 (2×) — needs 6 throttles
  await test("score 35: 3 throttles → still tier 1 (need 6)", async () => {
    const s = makeStore();
    await backdate(s,"pk:Pk35",REASONS.PUBKEY_RATE_LIMIT,1,30_000);
    await backdate(s,"pk:Pk35",REASONS.PUBKEY_RATE_LIMIT,1,60_000);
    const r = await recordOffense(s,"pk:Pk35",REASONS.PUBKEY_RATE_LIMIT,{trustScore:35});
    assertEq(r.tier, TIERS.THROTTLE, "score 35 absorbs 3");
  });

  await test("score 35: 6 throttles → tier 2", async () => {
    const s = makeStore();
    for (let i=0;i<5;i++) await backdate(s,"pk:Pk35b",REASONS.PUBKEY_RATE_LIMIT,1,(i+1)*30_000);
    const r = await recordOffense(s,"pk:Pk35b",REASONS.PUBKEY_RATE_LIMIT,{trustScore:35});
    assertEq(r.tier, TIERS.SOFT_BAN, "score 35 → tier 2 at 6");
  });

  // Score 51-80 (5×) — needs 15 throttles
  await test("score 80: 3 throttles → NO tier 2 (needs 15)", async () => {
    const s = makeStore();
    await backdate(s,"pk:Pk80",REASONS.PUBKEY_RATE_LIMIT,1,30_000);
    await backdate(s,"pk:Pk80",REASONS.PUBKEY_RATE_LIMIT,1,60_000);
    const r = await recordOffense(s,"pk:Pk80",REASONS.PUBKEY_RATE_LIMIT,{trustScore:80});
    assertEq(r.tier, TIERS.THROTTLE);
  });

  await test("score 80: 15 throttles in 5min → tier 2", async () => {
    const s = makeStore();
    for (let i=0;i<14;i++) await backdate(s,"pk:Pk80b",REASONS.PUBKEY_RATE_LIMIT,1,(i+1)*15_000);
    const r = await recordOffense(s,"pk:Pk80b",REASONS.PUBKEY_RATE_LIMIT,{trustScore:80});
    assertEq(r.tier, TIERS.SOFT_BAN);
  });

  // Score 81-100 (10×) — fraud corroboration required
  await test("score 90: 30 throttles in 5min, no fraud → STAYS tier 1", async () => {
    const s = makeStore();
    for (let i=0;i<29;i++) await backdate(s,"pk:Pk90",REASONS.PUBKEY_RATE_LIMIT,1,(i+1)*8_000);
    const r = await recordOffense(s,"pk:Pk90",REASONS.PUBKEY_RATE_LIMIT,{trustScore:90, fraudSignals: []});
    assertEq(r.tier, TIERS.THROTTLE, "no fraud, no escalation");
  });

  await test("score 90: 30 throttles + fraud signal → tier 3 (shortcut)", async () => {
    const s = makeStore();
    const r = await recordOffense(s,"pk:Pk90b",REASONS.PUBKEY_RATE_LIMIT,{
      trustScore: 90,
      fraudSignals: [REASONS.WASH_PAYMENT],
    });
    assertEq(r.tier, TIERS.HARD_BAN, "fraud-signal shortcut bypasses score gate");
  });

  await test("score 60: tier4ImmuneByScore prevents auto-permanent", async () => {
    const s = makeStore();
    // 3 prior hard bans
    await backdate(s,"pk:Pk60",REASONS.PUBKEY_RATE_LIMIT,3,1*86400_000);
    await backdate(s,"pk:Pk60",REASONS.PUBKEY_RATE_LIMIT,3,3*86400_000);
    // Escalate to a 3rd by completing the 2nd-soft-ban→hard-ban path
    await backdate(s,"pk:Pk60",REASONS.PUBKEY_RATE_LIMIT,2,6*3600_000);
    await backdate(s,"pk:Pk60",REASONS.PUBKEY_RATE_LIMIT,2,12*3600_000);
    // With score 60 + 5× multiplier need 15 throttles to escalate
    for (let i=0;i<14;i++) await backdate(s,"pk:Pk60",REASONS.PUBKEY_RATE_LIMIT,1,(i+1)*15_000);
    const r = await recordOffense(s,"pk:Pk60",REASONS.PUBKEY_RATE_LIMIT,{
      trustScore: 60, tierMax: 4, whitelistDays: 0,
    });
    if (r.tier === TIERS.PERMANENT) throw new Error("score 60 must not promote");
  });

  const totalFailed = syncFailed + intFailed;
  console.log(`\n${passed}/${passed+intFailed} integration tests passed.`);
  if (totalFailed > 0) {
    console.error(`\nTotal failures: ${totalFailed}\n`);
    process.exit(1);
  }
  console.log(`\nAll tests passed.\n`);
})();
