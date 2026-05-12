/**
 * test/store-slidingwindow-query.test.js
 *
 * Unit tests for:
 *  - slidingWindowQuery (read-only count, in-memory backend)
 *  - incrMassBanCounter / getMassBanCounter (in-memory backend)
 *
 * Phase 4 — Task 1.
 * Redis variants are skipped when REDIS_URL is unset.
 */

const assert = require("assert");
const { createStore } = require("../lib/store");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
}

(async () => {
  console.log("\nx402-shield store.slidingWindowQuery + massBan counters — unit tests\n");

  // ─── slidingWindowQuery — in-memory ────────────────────────────────────────

  await test("query returns count=0 for empty bucket", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    const result = await store.slidingWindowQuery("rl:q:empty", 10, 60_000);
    assert.strictEqual(result.count, 0, "count");
    assert.strictEqual(result.remaining, 10, "remaining");
    assert.strictEqual(result.windowMs, 60_000, "windowMs echo");
  });

  await test("query sees entries inserted by slidingWindowConsume", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    const now = Date.now();
    await store.slidingWindowConsume("rl:q:bk1", 100, 60_000, now, `${now}:1:A`);
    const result = await store.slidingWindowQuery("rl:q:bk1", 100, 60_000);
    assert.strictEqual(result.count, 1, "count after one consume");
    assert.strictEqual(result.remaining, 99, "remaining");
  });

  await test("query is non-mutating — repeated calls return same count", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    const now = Date.now();
    await store.slidingWindowConsume("rl:q:bk2", 100, 60_000, now, `${now}:2:A`);
    const before = await store.slidingWindowQuery("rl:q:bk2", 100, 60_000);
    const after  = await store.slidingWindowQuery("rl:q:bk2", 100, 60_000);
    assert(before.count === 1 && after.count === 1, "query is non-mutating");
    assert(before.remaining === 99, "remaining computed");
  });

  await test("subsequent slidingWindowConsume after query still increments correctly", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    const now = Date.now();
    await store.slidingWindowConsume("rl:q:bk3", 100, 60_000, now, `${now}:3:A`);
    await store.slidingWindowQuery("rl:q:bk3", 100, 60_000);  // read-only
    await store.slidingWindowConsume("rl:q:bk3", 100, 60_000, now + 1, `${now}:3:B`);
    const result = await store.slidingWindowQuery("rl:q:bk3", 100, 60_000);
    assert.strictEqual(result.count, 2, "query did not inflate count");
  });

  await test("query excludes expired entries (older than windowMs)", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    const old = Date.now() - 120_000;  // 2 minutes ago — outside 60s window
    await store.slidingWindowConsume("rl:q:bk4", 100, 60_000, old, `${old}:4:old`);
    const result = await store.slidingWindowQuery("rl:q:bk4", 100, 60_000);
    // The old entry has ts <= cutoff so count should be 0
    assert.strictEqual(result.count, 0, "expired entry not counted");
    assert.strictEqual(result.remaining, 100, "full remaining when all expired");
  });

  await test("remaining is clamped to 0 when count exceeds max", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    const now = Date.now();
    // Fill exactly at limit
    for (let i = 0; i < 3; i++) {
      await store.slidingWindowConsume("rl:q:bk5", 3, 60_000, now + i, `${now}:5:${i}`);
    }
    const result = await store.slidingWindowQuery("rl:q:bk5", 3, 60_000);
    assert.strictEqual(result.count, 3, "count at limit");
    assert.strictEqual(result.remaining, 0, "remaining clamped to 0");
  });

  // ─── incrMassBanCounter / getMassBanCounter — in-memory ────────────────────

  await test("getMassBanCounter returns 0 for unknown scope", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    const v = await store.getMassBanCounter("rl:massban:unknown");
    assert.strictEqual(v, 0);
  });

  await test("incrMassBanCounter increments and getMassBanCounter reads it back", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    const v1 = await store.incrMassBanCounter("rl:massban:ops-2026-05", 3600);
    assert.strictEqual(v1, 1, "first incr returns 1");
    const v2 = await store.incrMassBanCounter("rl:massban:ops-2026-05", 3600);
    assert.strictEqual(v2, 2, "second incr returns 2");
    const read = await store.getMassBanCounter("rl:massban:ops-2026-05");
    assert.strictEqual(read, 2, "getMassBanCounter matches");
  });

  await test("incrMassBanCounter resets after TTL expires", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    // Use ttlSec=0 to simulate an already-expired window
    await store.incrMassBanCounter("rl:massban:ttl-test", 0);
    // expiresAt = now + 0*1000 = now; already expired on next check
    // We simulate expiry by calling with a scope that had ttl=0
    // The second increment should reset because expiresAt <= now
    const v2 = await store.incrMassBanCounter("rl:massban:ttl-test", 3600);
    assert.strictEqual(v2, 1, "resets to 1 after expiry");
  });

  await test("different scopes are independent", async () => {
    process.env.REDIS_URL = "";
    const store = createStore();
    await store.incrMassBanCounter("rl:massban:scope-A", 3600);
    await store.incrMassBanCounter("rl:massban:scope-A", 3600);
    await store.incrMassBanCounter("rl:massban:scope-B", 3600);
    const a = await store.getMassBanCounter("rl:massban:scope-A");
    const b = await store.getMassBanCounter("rl:massban:scope-B");
    assert.strictEqual(a, 2, "scope A = 2");
    assert.strictEqual(b, 1, "scope B = 1");
  });

  // ─── Redis smoke (skipped if REDIS_URL unset) ───────────────────────────────

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    await test("[redis] slidingWindowQuery returns correct count without inserting", async () => {
      const store = createStore({ url: redisUrl });
      try {
        const key = `rl:q:redis-smoke-${Date.now()}`;
        const now = Date.now();
        await store.slidingWindowConsume(key, 100, 60_000, now, `${now}:r:A`);
        const before = await store.slidingWindowQuery(key, 100, 60_000);
        const after  = await store.slidingWindowQuery(key, 100, 60_000);
        assert(before.count === 1 && after.count === 1, "non-mutating");
        assert(before.remaining === 99, "remaining");
      } finally {
        await store.close();
      }
    });

    await test("[redis] incrMassBanCounter + getMassBanCounter roundtrip", async () => {
      const store = createStore({ url: redisUrl });
      try {
        const scope = `massban:redis-smoke-${Date.now()}`;
        const v1 = await store.incrMassBanCounter(scope, 60);
        const v2 = await store.incrMassBanCounter(scope, 60);
        const read = await store.getMassBanCounter(scope);
        assert.strictEqual(v1, 1, "first incr");
        assert.strictEqual(v2, 2, "second incr");
        assert.strictEqual(read, 2, "read back");
      } finally {
        await store.close();
      }
    });
  } else {
    console.log("  SKIP [redis] tests — REDIS_URL not set");
  }

  console.log(`\n${passed}/${passed + failed} tests passed.`);
  if (failed) process.exit(1);
})();
