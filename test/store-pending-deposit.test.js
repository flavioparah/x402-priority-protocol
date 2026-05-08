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

  const sig = `sig-${label}-${Date.now()}`;

  const c1 = await store.claimPendingDeposit(sig, "req-1", 5000);
  assert(`[${label}] first claim ok=true`, c1.ok === true);

  const c2 = await store.claimPendingDeposit(sig, "req-2", 5000);
  assert(`[${label}] second claim ok=false`, c2.ok === false);

  const ttl = await store.pendingDepositPttl(sig);
  assert(`[${label}] pttl in (0, 5000]`, ttl > 0 && ttl <= 5000);

  await store.clearPendingDeposit(sig);
  const c3 = await store.claimPendingDeposit(sig, "req-3", 5000);
  assert(`[${label}] re-claim after clear ok=true`, c3.ok === true);
  await store.clearPendingDeposit(sig);

  const sigShort = `sig-short-${label}-${Date.now()}`;
  const cShort1 = await store.claimPendingDeposit(sigShort, "req-x", 200);
  assert(`[${label}] short claim ok=true`, cShort1.ok === true);
  await sleep(350);
  const cShort2 = await store.claimPendingDeposit(sigShort, "req-y", 200);
  assert(`[${label}] re-claim after TTL ok=true`, cShort2.ok === true);
  await store.clearPendingDeposit(sigShort);

  const badSig = `bad-${label}-${Date.now()}`;
  assert(`[${label}] isDepositKnownBad initially false`,
    (await store.isDepositKnownBad(badSig)) === false);
  await store.markDepositKnownBad(badSig, 5000);
  assert(`[${label}] isDepositKnownBad true after mark`,
    (await store.isDepositKnownBad(badSig)) === true);

  const badShort = `bad-short-${label}-${Date.now()}`;
  await store.markDepositKnownBad(badShort, 200);
  await sleep(350);
  assert(`[${label}] known-bad expires after TTL`,
    (await store.isDepositKnownBad(badShort)) === false);
}

async function main() {
  console.log("\nx402-shield — pending deposit lock + known-bad cache\n");

  const { createStore } = require(path.join(__dirname, "..", "lib", "store.js"));
  const mem = createStore({ forceMemory: true });
  await exercise("memory", mem);
  await mem.close();

  if (!REDIS_URL) {
    console.log("\n  ⚠ REDIS_URL unset — skipping Redis arm");
  } else {
    const Redis = require("ioredis");
    const r = new Redis(REDIS_URL);
    const keys = await r.keys("x402:deposit:*");
    if (keys.length) await r.del(...keys);
    await r.quit();

    const redis = createStore({ url: REDIS_URL });
    await exercise("redis", redis);
    await redis.close();
  }

  if (failed > 0) { console.error(`\n${failed} assertion(s) failed.\n`); process.exit(1); }
  console.log("\nAll pending-deposit assertions passed.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
