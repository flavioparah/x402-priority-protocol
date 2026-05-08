const path = require("path");
const REDIS_URL = process.env.REDIS_URL || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function assert(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

async function exerciseStore(label, store) {
  console.log(`\n  --- ${label} ---`);

  const bucket = `rl:test:${label}:${Date.now()}`;
  const max = 5;
  const windowMs = 1000;
  let now = 1_000_000;

  for (let i = 0; i < 5; i++) {
    const member = `${now}:${i}:${process.pid}`;
    const r = await store.slidingWindowConsume(bucket, max, windowMs, now, member);
    assert(`[${label}] consume #${i + 1} ok=true count=${i + 1}`,
      r.ok === true && r.count === i + 1);
    now += 10;
  }

  {
    const member = `${now}:6:${process.pid}`;
    const r = await store.slidingWindowConsume(bucket, max, windowMs, now, member);
    assert(`[${label}] 6th consume ok=false count=${max}`,
      r.ok === false && r.count === max);
    now += 10;
  }

  const dupMember = `${now - 100}:dup:${process.pid}`;
  await store.slidingWindowConsume(bucket, max, windowMs, now, dupMember).catch(() => {});

  now += windowMs + 100;
  {
    const member = `${now}:reborn:${process.pid}`;
    const r = await store.slidingWindowConsume(bucket, max, windowMs, now, member);
    assert(`[${label}] after window expiry, capacity returns (ok=true)`, r.ok === true);
  }

  const bucket2 = `rl:test2:${label}:${Date.now()}`;
  let okCount = 0;
  for (let i = 0; i < 100; i++) {
    const member = `${now}:${i}:${process.pid}`;
    const r = await store.slidingWindowConsume(bucket2, 100, windowMs, now, member);
    if (r.ok) okCount++;
  }
  assert(`[${label}] distinct memberIds: 100/100 succeed within cap=100`, okCount === 100);

  {
    const member = `${now}:101:${process.pid}`;
    const r = await store.slidingWindowConsume(bucket2, 100, windowMs, now, member);
    assert(`[${label}] 101st rejected (cap reached)`, r.ok === false && r.count === 100);
  }
}

async function main() {
  console.log("\nx402-shield — slidingWindowConsume\n");

  const { createStore } = require(path.join(__dirname, "..", "lib", "store.js"));

  const mem = createStore({ forceMemory: true });
  await exerciseStore("memory", mem);
  await mem.close();

  if (!REDIS_URL) {
    console.log("\n  ⚠ REDIS_URL unset — skipping Redis arm");
  } else {
    const redis = createStore({ url: REDIS_URL });
    const Redis = require("ioredis");
    const r = new Redis(REDIS_URL);
    const keys = await r.keys("rl:test*");
    if (keys.length) await r.del(...keys);
    await r.quit();
    await exerciseStore("redis", redis);
    await redis.close();
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed.\n`);
    process.exit(1);
  }
  console.log("\nAll slidingWindowConsume assertions passed.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
