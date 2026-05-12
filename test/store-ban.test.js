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

  const k = `ip:1.2.3.4:${label}:${Date.now()}`;

  assert(`[${label}] getBan empty initially`, (await store.getBan(k)) === null);

  await store.setBan(k, 2, "soft_ban_3_throttles", 5000);
  const b1 = await store.getBan(k);
  assert(`[${label}] tier 2 ban present`,
    b1 && b1.tier === 2 && b1.reason === "soft_ban_3_throttles");
  assert(`[${label}] ban has untilEpochMs > now`, b1.untilEpochMs > Date.now());

  await store.clearBan(k);
  assert(`[${label}] cleared ban returns null`, (await store.getBan(k)) === null);

  await store.setBan(k, 3, "hard_ban_3_soft_24h", 200);
  await sleep(350);
  assert(`[${label}] tier 3 ban expires after TTL`, (await store.getBan(k)) === null);

  const pk = `pk:Abc${label}${Date.now()}`;
  assert(`[${label}] isPermanent false initially`,
    (await store.isPermanent(pk)) === false);
  await store.addPermanent(pk, "operator action: tx 0xdead");
  assert(`[${label}] isPermanent true after add`,
    (await store.isPermanent(pk)) === true);

  await store.removePermanent(pk, "appeal accepted");
  assert(`[${label}] isPermanent false after remove`,
    (await store.isPermanent(pk)) === false);

  await store.addPermanent(pk, "re-banned");
  await store.addPermanent(pk, "re-banned again");
  assert(`[${label}] re-add idempotent`, (await store.isPermanent(pk)) === true);
  await store.removePermanent(pk, "cleanup");
}

async function main() {
  console.log("\nx402-shield — ban tiers + permanent set\n");

  const { createStore } = require(path.join(__dirname, "..", "lib", "store.js"));
  const mem = createStore({ forceMemory: true });
  await exercise("memory", mem);
  await mem.close();

  if (!REDIS_URL) {
    console.log("\n  ⚠ REDIS_URL unset — skipping Redis arm");
  } else {
    const Redis = require("ioredis");
    const r = new Redis(REDIS_URL);
    const keys = await r.keys("x402:ban*");
    if (keys.length) await r.del(...keys);
    await r.quit();

    const redis = createStore({ url: REDIS_URL });
    await exercise("redis", redis);
    await redis.close();
  }

  if (failed > 0) { console.error(`\n${failed} assertion(s) failed.\n`); process.exit(1); }
  console.log("\nAll ban-tier assertions passed.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
