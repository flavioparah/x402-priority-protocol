const path = require("path");
const REDIS_URL = process.env.REDIS_URL || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function assert(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

async function exercise(label, store) {
  console.log(`\n  --- ${label} ---`);

  const key = `abuse-${label}-${Date.now()}`;
  const TTL_24H_MS = 24 * 60 * 60 * 1000;

  const empty = await store.getAbuseHistory(key, 10);
  assert(`[${label}] empty history returns []`,
    Array.isArray(empty) && empty.length === 0);

  await store.pushAbuseHistory(key, { ts: 1000, reason: "throttle", tier: 1 }, TTL_24H_MS);
  await store.pushAbuseHistory(key, { ts: 2000, reason: "throttle", tier: 1 }, TTL_24H_MS);
  await store.pushAbuseHistory(key, { ts: 3000, reason: "soft_ban",  tier: 2 }, TTL_24H_MS);

  const recent = await store.getAbuseHistory(key, 10);
  assert(`[${label}] history has 3 entries`, recent.length === 3);
  assert(`[${label}] newest entry first (ts=3000)`,
    recent[0].ts === 3000 && recent[0].reason === "soft_ban");
  assert(`[${label}] oldest entry last (ts=1000)`,
    recent[2].ts === 1000);

  const top1 = await store.getAbuseHistory(key, 1);
  assert(`[${label}] limit=1 returns 1 entry`, top1.length === 1);

  const capKey = `cap-${label}-${Date.now()}`;
  for (let i = 0; i < 105; i++) {
    await store.pushAbuseHistory(capKey, { ts: i, reason: "x" }, TTL_24H_MS);
  }
  const allCap = await store.getAbuseHistory(capKey, 1000);
  assert(`[${label}] capped at 100`, allCap.length === 100);
  assert(`[${label}] newest preserved (ts=104)`, allCap[0].ts === 104);
  assert(`[${label}] oldest dropped (ts=5 is the smallest kept)`,
    allCap[99].ts === 5);

  const expKey = `exp-${label}-${Date.now()}`;
  await store.pushAbuseHistory(expKey, { ts: 1, reason: "e" }, 200);
  await sleep(350);
  const expHist = await store.getAbuseHistory(expKey, 10);
  assert(`[${label}] entries expire after TTL`, expHist.length === 0);
}

async function main() {
  console.log("\nx402-shield — abuse history\n");

  const { createStore } = require(path.join(__dirname, "..", "lib", "store.js"));
  const mem = createStore({ forceMemory: true });
  await exercise("memory", mem);
  await mem.close();

  if (!REDIS_URL) {
    console.log("\n  ⚠ REDIS_URL unset — skipping Redis arm");
  } else {
    const Redis = require("ioredis");
    const r = new Redis(REDIS_URL);
    const keys = await r.keys("x402:abuse:*");
    if (keys.length) await r.del(...keys);
    await r.quit();

    const redis = createStore({ url: REDIS_URL });
    await exercise("redis", redis);
    await redis.close();
  }

  if (failed > 0) { console.error(`\n${failed} assertion(s) failed.\n`); process.exit(1); }
  console.log("\nAll abuse-history assertions passed.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
