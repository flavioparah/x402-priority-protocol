const {
  enforcementResponse,
  TIERS,
  TIER_TO_TRUST_IMPACT,
} = require("../lib/enforcement");
const { REASONS, ALL_REASONS } = require("../lib/abuse-reasons");

// Minimal Express response stub
function makeRes() {
  const headers = {};
  let _status = 200, _body = null, _ended = false;
  return {
    headers,
    status(c) { _status = c; return this; },
    set(k, v) {
      if (typeof k === "object") { for (const [a,b] of Object.entries(k)) headers[a]=String(b); }
      else { headers[k]=String(v); }
      return this;
    },
    setHeader(k, v) { headers[k]=String(v); return this; },
    json(o) { _body = o; _ended = true; return this; },
    end() { _ended = true; return this; },
    get statusCode() { return _status; },
    get body() { return _body; },
    get ended() { return _ended; },
  };
}

let passed=0,failed=0;
function test(n,fn){return Promise.resolve().then(fn).then(()=>{console.log(`  ✓ ${n}`);passed++;}).catch(e=>{console.error(`  ✗ ${n}\n    ${e.message}`);failed++;});}

(async () => {
  console.log("\nx402-shield enforcement feedback headers — unit tests\n");

  // ── Tier 0 (warning) ────────────────────────────────────────────
  console.log("# tier 0 — warning headers, NO 429 (next() expected)");

  await test("tier 0 sets warn headers, returns sendNext: true, no body", () => {
    const res = makeRes();
    const out = enforcementResponse(res, {
      tier: TIERS.WARNING,
      reason: REASONS.IP_RATE_LIMIT,
      remaining: 18,
      limit: 100,
      windowSeconds: 60,
    });
    if (res.headers["X-x402-Tier"] !== "0") throw new Error("X-x402-Tier");
    if (res.headers["X-x402-Reason"] !== REASONS.IP_RATE_LIMIT) throw new Error("X-x402-Reason");
    if (res.headers["X-x402-Limit-Remaining"] !== "18") throw new Error("limit-remaining");
    if (res.headers["X-x402-Warning"] !== "rate-limit-approaching") throw new Error("warning header");
    if (res.headers["X-x402-Trust-Impact"] !== "warn") throw new Error("trust impact");
    if (out.sendNext !== true) throw new Error("must signal next()");
    if (res.ended) throw new Error("must not end response");
  });

  // ── Tier 1 (throttle) ───────────────────────────────────────────
  console.log("\n# tier 1 — 429 + Retry-After");

  await test("tier 1 returns 429 with full header set", () => {
    const res = makeRes();
    const until = Math.floor(Date.now()/1000) + 47;
    enforcementResponse(res, {
      tier: TIERS.THROTTLE,
      reason: REASONS.IP_RATE_LIMIT,
      until,
      limit: 100,
      windowSeconds: 60,
      remaining: 0,
      yourScore: 12,
      historySummary: { throttles_5m: 3, soft_bans_24h: 0, hard_bans_7d: 0 },
      nextTierAt: "soft_ban after 1 more throttle in 5min",
    });
    if (res.statusCode !== 429) throw new Error(`status ${res.statusCode}`);
    if (res.headers["X-x402-Tier"] !== "1") throw new Error("tier");
    if (res.headers["X-x402-Reason"] !== "ip-rate-limit") throw new Error("reason");
    if (res.headers["X-x402-Until"] !== String(until)) throw new Error("until");
    const ra = parseInt(res.headers["Retry-After"], 10);
    if (Math.abs(ra - 47) > 2) throw new Error(`retry-after ${ra}`);
    if (res.headers["X-x402-Trust-Impact"] !== "throttle") throw new Error("impact");
    // Body shape (Section 8.5)
    const b = res.body;
    if (b.error !== "rate_limited") throw new Error("error");
    if (b.code !== 429) throw new Error("code");
    if (b.tier !== 1) throw new Error("body tier");
    if (b.reason !== "ip-rate-limit") throw new Error("body reason");
    if (b.your_score !== 12) throw new Error("your_score");
    if (!b.history) throw new Error("history");
    if (b.next_tier_at !== "soft_ban after 1 more throttle in 5min") throw new Error("next_tier_at");
    if (b.window_seconds !== 60) throw new Error("window");
    if (b.limit !== 100) throw new Error("limit");
  });

  // ── Tier 2 (soft ban) ───────────────────────────────────────────
  console.log("\n# tier 2 — soft ban 429");

  await test("tier 2 returns 429 with trust_impact=softban", () => {
    const res = makeRes();
    const until = Math.floor(Date.now()/1000) + 300;
    enforcementResponse(res, {
      tier: TIERS.SOFT_BAN,
      reason: REASONS.INVALID_SIGNATURE_BURST,
      until,
      yourScore: 0,
      historySummary: { throttles_5m: 5, soft_bans_24h: 1, hard_bans_7d: 0 },
    });
    if (res.statusCode !== 429) throw new Error("status");
    if (res.headers["X-x402-Tier"] !== "2") throw new Error("tier");
    if (res.headers["X-x402-Trust-Impact"] !== "softban") throw new Error("impact");
    if (res.body.tier !== 2) throw new Error("body");
    if (res.body.reason !== "invalid-signature-burst") throw new Error("body reason");
  });

  // ── Tier 3 (hard ban) ───────────────────────────────────────────
  console.log("\n# tier 3 — hard ban 403");

  await test("tier 3 returns 403 with trust_impact=hardban", () => {
    const res = makeRes();
    const until = Math.floor(Date.now()/1000) + 3600;
    enforcementResponse(res, {
      tier: TIERS.HARD_BAN,
      reason: REASONS.WASH_PAYMENT,
      until,
    });
    if (res.statusCode !== 403) throw new Error(`status ${res.statusCode}`);
    if (res.headers["X-x402-Tier"] !== "3") throw new Error("tier");
    if (res.headers["X-x402-Trust-Impact"] !== "hardban") throw new Error("impact");
  });

  // ── Tier 4 (permanent) ──────────────────────────────────────────
  console.log("\n# tier 4 — permanent 403, no Retry-After");

  await test("tier 4 returns 403 with no Retry-After / X-x402-Until=permanent", () => {
    const res = makeRes();
    enforcementResponse(res, {
      tier: TIERS.PERMANENT,
      reason: REASONS.PUBKEY_HINT_MISMATCH,
      until: null,
    });
    if (res.statusCode !== 403) throw new Error("status");
    if (res.headers["X-x402-Tier"] !== "4") throw new Error("tier");
    if ("Retry-After" in res.headers) throw new Error("must not set Retry-After");
    if (res.headers["X-x402-Until"] !== "permanent") throw new Error("until label");
    if (res.headers["X-x402-Trust-Impact"] !== "permanent") throw new Error("impact");
  });

  // ── vocabulary closure ──────────────────────────────────────────
  await test("rejects unknown reason at runtime (defensive)", () => {
    const res = makeRes();
    let threw = false;
    try { enforcementResponse(res, { tier: 1, reason: "made-up-reason", until: 0 }); }
    catch { threw = true; }
    if (!threw) throw new Error("must throw on unknown reason");
  });

  await test("every reason in ALL_REASONS round-trips through response", () => {
    for (const r of ALL_REASONS) {
      const res = makeRes();
      enforcementResponse(res, { tier: 1, reason: r, until: 0 });
      if (res.headers["X-x402-Reason"] !== r) throw new Error(`mismatch ${r}`);
    }
  });

  console.log(`\n${passed}/${passed+failed} feedback-header tests passed.`);
  if (failed) process.exit(1);
})();
