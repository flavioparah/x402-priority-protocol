"use strict";

const { createRateLimitMiddleware, getTrustMultiplier } = require("../lib/ratelimit");

let n = 0, failed = 0;
function check(label, cond) {
  n++;
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

function makeFakeStore({ rep = null, healthy = true } = {}) {
  const consumed = [];
  return {
    consumed,
    isStoreHealthy: () => healthy,
    getReputation: async () => rep,
    slidingWindowConsume: async (key, max, windowMs, now, memberId) => {
      consumed.push({ key, max, windowMs });
      return { ok: true, count: consumed.length };
    },
  };
}

const fakeLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

function fakeReqRes({ ip = "1.2.3.4", x402Verified = null } = {}) {
  return {
    req: { ip, socket: { remoteAddress: ip }, x402Verified, headers: {} },
    res: {
      _status: 200, _headers: {}, _body: null,
      setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
      set(o) { for (const [k, v] of Object.entries(o)) this._headers[k.toLowerCase()] = v; },
      status(c) { this._status = c; return this; },
      json(b) { this._body = b; return this; },
    },
  };
}

(async () => {
  console.log("\n— paid-lane is additive, not bypass (spec §6.4) —\n");

  // CASE 1: NO x402Verified → only ip + pubkey + global consumed (NOT paid)
  {
    const store = makeFakeStore();
    const mw = createRateLimitMiddleware({
      routeName: "rpc",
      ip:     { keyPrefix: "rl:rpc:ip", max: 100, windowMs: 60_000 },
      pubkey: { keyPrefix: "rl:rpc:pk", max: 200, windowMs: 60_000 },
      paid:   { keyPrefix: "rl:rpc:paid", baseMax: 200, windowMs: 60_000 },
      global: { key: "rl:global", max: 5000, windowMs: 60_000 },
    }, { store, logger: fakeLogger });
    const { req, res } = fakeReqRes({ ip: "1.2.3.4", x402Verified: null });
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    check("CASE 1 (no x402Verified): next() called", nextCalled);
    const dims = store.consumed.map((c) => c.key);
    check("CASE 1: global bucket consumed", dims.includes("rl:global"));
    check("CASE 1: ip bucket consumed", dims.some((k) => k.startsWith("rl:rpc:ip:")));
    check("CASE 1: pubkey bucket NOT consumed (no pubkey)",
      !dims.some((k) => k.startsWith("rl:rpc:pk:")));
    check("CASE 1: paid bucket NOT consumed (no x402Verified)",
      !dims.some((k) => k.startsWith("rl:rpc:paid:")));
  }

  // CASE 2: WITH x402Verified → ALL 4 buckets consumed (paid is additive)
  {
    const store = makeFakeStore({ rep: { paidCount: 5 } }); // score = 25 → multiplier 2x
    const mw = createRateLimitMiddleware({
      routeName: "rpc",
      ip:     { keyPrefix: "rl:rpc:ip", max: 100, windowMs: 60_000 },
      pubkey: { keyPrefix: "rl:rpc:pk", max: 200, windowMs: 60_000 },
      paid:   { keyPrefix: "rl:rpc:paid", baseMax: 200, windowMs: 60_000 },
      global: { key: "rl:global", max: 5000, windowMs: 60_000 },
    }, { store, logger: fakeLogger });
    const { req, res } = fakeReqRes({
      ip: "5.6.7.8",
      x402Verified: { pubkey: "PubXYZ" },
    });
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    check("CASE 2 (x402Verified): next() called", nextCalled);
    const dims = store.consumed.map((c) => c.key);
    check("CASE 2: global bucket consumed (no bypass)", dims.includes("rl:global"));
    check("CASE 2: ip bucket consumed (no bypass)",
      dims.some((k) => k === "rl:rpc:ip:5.6.7.8"));
    check("CASE 2: pubkey bucket consumed (no bypass)",
      dims.some((k) => k === "rl:rpc:pk:PubXYZ"));
    check("CASE 2: paid bucket consumed (additive)",
      dims.some((k) => k === "rl:rpc:paid:PubXYZ"));
  }

  // CASE 3: paid bucket max scales with trust multiplier
  {
    const store = makeFakeStore({ rep: { paidCount: 20 } }); // score = 100 → multiplier 10x
    const mw = createRateLimitMiddleware({
      routeName: "rpc",
      paid: { keyPrefix: "rl:rpc:paid", baseMax: 200, windowMs: 60_000 },
    }, { store, logger: fakeLogger });
    const { req, res } = fakeReqRes({
      ip: "1.1.1.1",
      x402Verified: { pubkey: "WhalePub" },
    });
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    check("CASE 3: next() called", nextCalled);
    const paidEntry = store.consumed.find((c) => c.key === "rl:rpc:paid:WhalePub");
    check("CASE 3: paid bucket max = baseMax * 10 (Trust 81-100)",
      paidEntry && paidEntry.max === 2000);
  }

  // Trust multiplier table sanity
  check("getTrustMultiplier(0)  = 1",  getTrustMultiplier(0)  === 1);
  check("getTrustMultiplier(20) = 1",  getTrustMultiplier(20) === 1);
  check("getTrustMultiplier(21) = 2",  getTrustMultiplier(21) === 2);
  check("getTrustMultiplier(50) = 2",  getTrustMultiplier(50) === 2);
  check("getTrustMultiplier(80) = 5",  getTrustMultiplier(80) === 5);
  check("getTrustMultiplier(81) = 10", getTrustMultiplier(81) === 10);
  check("getTrustMultiplier(100)= 10", getTrustMultiplier(100)=== 10);

  if (failed > 0) {
    console.error(`\n${failed} of ${n} assertions failed.\n`);
    process.exit(1);
  }
  console.log(`\nAll ${n} assertions passed.\n`);
})().catch((e) => { console.error(e); process.exit(1); });
