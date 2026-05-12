"use strict";
/**
 * test/ratelimit-enforcement-headers.test.js
 *
 * Unit tests for the rate-limit → enforcement bridge.
 * No process spawning — tests the middleware in isolation.
 */
const { wrapRateLimitWithEnforcement } = require("../lib/ratelimit-enforcement");
const { REASONS } = require("../lib/abuse-reasons");

function makeRes() {
  const headers = {};
  let _status = 200, _body = null, _ended = false;
  return {
    headers,
    status(c) { _status = c; return this; },
    set(k, v) {
      if (typeof k === "object") {
        for (const [a, b] of Object.entries(k)) headers[a] = String(b);
      } else {
        headers[k] = String(v);
      }
      return this;
    },
    setHeader(k, v) { headers[k] = String(v); return this; },
    json(o) { _body = o; _ended = true; return this; },
    end() { _ended = true; return this; },
    get statusCode() { return _status; },
    get body() { return _body; },
    get ended() { return _ended; },
  };
}

function makeStore() {
  const h = new Map(), b = new Map(), p = new Set();
  return {
    async pushAbuseHistory(k, e) {
      const a = h.get(k) || []; a.unshift(e); h.set(k, a);
    },
    async getAbuseHistory(k, since) {
      return (h.get(k) || []).filter(e => e.ts >= Date.now() - since);
    },
    async setBan(k, v) { b.set(k, v); },
    async getBan(k) { return b.get(k) || null; },
    async clearBan(k) { b.delete(k); },
    async isPermanent(k) { return p.has(k); },
    async addPermanent(k) { p.add(k); },
    async getReputation() { return null; },
  };
}

let passed = 0, failed = 0;
function test(n, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${n}`); passed++; })
    .catch(e => { console.error(`  ✗ ${n}\n    ${e.message}`); failed++; });
}

(async () => {
  console.log("\nx402-shield rate-limit→enforcement bridge\n");

  await test("bucket below 80% → next() called, no tier headers added", async () => {
    const store = makeStore();
    const handler = wrapRateLimitWithEnforcement({
      store,
      reasonForDimension: () => REASONS.IP_RATE_LIMIT,
      keyFromReq: () => "ip:1.1.1.1",
    });
    let nextCalled = false;
    const res = makeRes();
    const req = {
      rateLimitState: {
        dimension: "ip", key: "ip:1.1.1.1",
        count: 50, max: 100, exceeded: false, remaining: 50,
      },
    };
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) throw new Error("next not called");
    if (res.headers["X-x402-Tier"]) throw new Error("must not set tier header below 80%");
  });

  await test("no rateLimitState → next() called passthrough", async () => {
    const store = makeStore();
    const handler = wrapRateLimitWithEnforcement({
      store,
      reasonForDimension: () => REASONS.IP_RATE_LIMIT,
      keyFromReq: () => "ip:1.1.1.1",
    });
    let nextCalled = false;
    const req = {};
    const res = makeRes();
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) throw new Error("next not called when no rateLimitState");
  });

  await test("bucket at 85% → tier 0 warning headers + next() called", async () => {
    const store = makeStore();
    const handler = wrapRateLimitWithEnforcement({
      store,
      reasonForDimension: () => REASONS.IP_RATE_LIMIT,
      keyFromReq: () => "ip:2.2.2.2",
    });
    let nextCalled = false;
    const res = makeRes();
    const req = {
      rateLimitState: {
        dimension: "ip", key: "ip:2.2.2.2",
        count: 85, max: 100, exceeded: false, remaining: 15,
      },
    };
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) throw new Error("must call next at warning tier");
    if (res.headers["X-x402-Tier"] !== "0") throw new Error(`tier 0 missing, got ${res.headers["X-x402-Tier"]}`);
    if (res.headers["X-x402-Warning"] !== "rate-limit-approaching") throw new Error("warning missing");
    if (res.headers["X-x402-Limit-Remaining"] !== "15") throw new Error(`remaining wrong: ${res.headers["X-x402-Limit-Remaining"]}`);
  });

  await test("bucket exceeded → tier 1, 429, recordOffense pushed history", async () => {
    const store = makeStore();
    const handler = wrapRateLimitWithEnforcement({
      store,
      reasonForDimension: () => REASONS.IP_RATE_LIMIT,
      keyFromReq: () => "ip:3.3.3.3",
    });
    let nextCalled = false;
    const res = makeRes();
    const req = {
      rateLimitState: {
        dimension: "ip", key: "ip:3.3.3.3",
        count: 101, max: 100, exceeded: true, remaining: 0, windowMs: 60_000,
      },
    };
    await handler(req, res, () => { nextCalled = true; });
    if (nextCalled) throw new Error("must NOT call next when exceeded");
    if (res.statusCode !== 429) throw new Error(`status ${res.statusCode}`);
    if (res.headers["X-x402-Tier"] !== "1") throw new Error(`tier 1 expected, got ${res.headers["X-x402-Tier"]}`);
    const hist = await store.getAbuseHistory("ip:3.3.3.3", 60_000);
    if (hist.length === 0) throw new Error("recordOffense did not push history");
  });

  await test("dim=pubkey exceeded → REASONS.PUBKEY_RATE_LIMIT reason used", async () => {
    const store = makeStore();
    const handler = wrapRateLimitWithEnforcement({
      store,
      reasonForDimension: (dim) =>
        dim === "pubkey" ? REASONS.PUBKEY_RATE_LIMIT : REASONS.IP_RATE_LIMIT,
      keyFromReq: () => "pk:TestPubkey1111111111",
    });
    const res = makeRes();
    const req = {
      rateLimitState: {
        dimension: "pubkey", key: "pk:TestPubkey1111111111",
        count: 201, max: 200, exceeded: true, remaining: 0, windowMs: 60_000,
      },
    };
    await handler(req, res, () => {});
    if (res.statusCode !== 429) throw new Error(`status ${res.statusCode}`);
    if (res.body?.reason !== REASONS.PUBKEY_RATE_LIMIT)
      throw new Error(`reason: ${res.body?.reason}`);
  });

  console.log(`\n${passed}/${passed + failed} bridge tests passed.`);
  if (failed) process.exit(1);
})();
