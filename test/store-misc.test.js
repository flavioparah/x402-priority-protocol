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

  await store.pushAuditAdmin({ ts: 100, key_id: "ops-A", path: "/admin/ban" });
  await store.pushAuditAdmin({ ts: 200, key_id: "ops-A", path: "/admin/unban" });
  await store.pushAuditAdmin({ ts: 300, key_id: "ops-B", path: "/admin/ban" });
  const all = await store.getAuditAdmin(10, 0);
  assert(`[${label}] audit list returns 3`, all.length === 3);
  assert(`[${label}] audit list newest-first (ts=300)`,
    all[0].ts === 300 && all[0].key_id === "ops-B");

  const since = await store.getAuditAdmin(10, 150);
  assert(`[${label}] sinceTs=150 returns 2 entries`, since.length === 2);
  assert(`[${label}] sinceTs filters out ts=100`,
    since.every((e) => e.ts >= 150));

  const before = await store.getTotalPaidVolume();
  await store.incrPaymentVolume(1000);
  await store.incrPaymentVolume(2500);
  const after = await store.getTotalPaidVolume();
  assert(`[${label}] payment volume incremented by 3500`,
    after - before === 3500);

  assert(`[${label}] isStoreHealthy true by default`,
    (await store.isStoreHealthy()) === true);
}

async function main() {
  console.log("\nx402-shield — admin audit + payment counter + health\n");

  const { createStore } = require(path.join(__dirname, "..", "lib", "store.js"));
  const mem = createStore({ forceMemory: true });
  await exercise("memory", mem);
  await mem.close();

  if (!REDIS_URL) {
    console.log("\n  ⚠ REDIS_URL unset — skipping Redis arm");
  } else {
    const Redis = require("ioredis");
    const r = new Redis(REDIS_URL);
    const keys = await r.keys("x402:audit*");
    if (keys.length) await r.del(...keys);
    await r.del("x402:stats:counters");
    await r.quit();

    const redis = createStore({ url: REDIS_URL });
    await exercise("redis", redis);
    await redis.close();
  }

  if (failed > 0) { console.error(`\n${failed} assertion(s) failed.\n`); process.exit(1); }
  console.log("\nAll misc-store assertions passed.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
