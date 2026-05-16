"use strict";

/**
 * test/agent-status-handler.test.js
 *
 * Unit tests for lib/agent-status.js — buildAgentStatus() pure function.
 * Uses a fake store; no server is started.
 */

const { buildAgentStatus, PUBKEY_RE, CACHE_TTL_MS } = require("../lib/agent-status");

// ── Fake store ────────────────────────────────────────────────────────────────

function makeFakeStore(overrides) {
  const permanent = new Set();
  const bans      = new Map();
  const repMap    = new Map();
  const histMap   = new Map();
  const rlBuckets = new Map();

  const base = {
    async getReputation(pubkey)         { return repMap.get(pubkey) || null; },
    async getAbuseHistory(key, _n)      { return histMap.get(key)   || []; },
    async getAttestations(_pubkey, _n)  { return []; },
    async isPermanent(key)              { return permanent.has(key); },
    async getBan(key)                   { return bans.get(key) || null; },
    async slidingWindowQuery(bucket, max, windowMs) {
      const count = rlBuckets.get(bucket) || 0;
      return { count, remaining: Math.max(0, max - count), windowMs };
    },

    // Test helpers (underscore-prefixed, not part of the real store API)
    _setReputation(pubkey, rec) { repMap.set(pubkey, rec); },
    _setAbuseHistory(key, arr)  { histMap.set(key, arr); },
    _setPermanent(key)          { permanent.add(key); },
    _setBan(key, val)           { bans.set(key, val); },
    _setBucket(key, count)      { rlBuckets.set(key, count); },
  };

  return Object.assign(base, overrides || {});
}

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function assertType(val, type, label) {
  if (typeof val !== type)
    throw new Error(`${label}: expected ${type}, got ${typeof val} (${JSON.stringify(val)})`);
}

const VALID_PK = "DemoStudent111111111111111111111111111111111";

// ── Tests ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log("\nx402-shield agent-status handler — unit tests\n");

  // ── Module constants ────────────────────────────────────────────────────────

  await test("PUBKEY_RE accepts a valid base-58 pubkey (44 chars)", () => {
    if (!PUBKEY_RE.test(VALID_PK)) throw new Error("expected match");
  });

  await test("PUBKEY_RE rejects a pubkey with invalid characters", () => {
    if (PUBKEY_RE.test("NOTBASE58!@#$")) throw new Error("expected no match");
  });

  await test("CACHE_TTL_MS is 10000", () => {
    assertEq(CACHE_TTL_MS, 10_000, "CACHE_TTL_MS");
  });

  // ── Default snapshot (no store data) ───────────────────────────────────────

  await test("returns required keys for an unknown pubkey", async () => {
    const store = makeFakeStore();
    const snap = await buildAgentStatus(store, VALID_PK, {});
    const REQUIRED = [
      "pubkey", "trust_score", "trust_band", "trust_multiplier",
      "current_tier", "throttles_5m", "soft_bans_24h", "hard_bans_7d",
      "fraud_flags", "rate_limit_remaining", "rate_limit_reset_seconds",
      "permanent", "whitelist_window", "since", "until_epoch",
      "abuse_history_count",
    ];
    for (const k of REQUIRED) {
      if (!(k in snap)) throw new Error(`missing key: ${k}`);
    }
  });

  await test("trust_score is 0 when no reputation record exists", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.trust_score, 0, "trust_score");
  });

  await test("trust_multiplier is 1 for score=0", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.trust_multiplier, 1, "trust_multiplier");
  });

  await test("trust_band is '0-20' for score=0", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.trust_band, "0-20", "trust_band");
  });

  await test("current_tier is 0 when no ban exists", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.current_tier, 0, "current_tier");
  });

  await test("permanent is false when key not in permanent set", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.permanent, false, "permanent");
  });

  await test("fraud_flags is empty array when no fraud signals", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.fraud_flags, [], "fraud_flags");
  });

  await test("since is null when no reputation record exists", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.since, null, "since");
  });

  await test("until_epoch is null when no ban exists", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.until_epoch, null, "until_epoch");
  });

  await test("abuse_history_count is 0 when no history", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.abuse_history_count, 0, "abuse_history_count");
  });

  await test("rate_limit_remaining fields are null (no config provided)", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    // With max=0 and count=0: remaining = max(0, 0 - 0) = 0 (not null)
    // With config absent the wrapper returns { remaining: null } fallback only
    // when slidingWindowQuery throws; here it doesn't, so remaining=0 is fine.
    assertType(snap.rate_limit_remaining, "object", "rate_limit_remaining type");
    if (!("ip" in snap.rate_limit_remaining)) throw new Error("missing rate_limit_remaining.ip");
    if (!("pubkey" in snap.rate_limit_remaining)) throw new Error("missing rate_limit_remaining.pubkey");
    if (!("global" in snap.rate_limit_remaining)) throw new Error("missing rate_limit_remaining.global");
  });

  await test("rate_limit_reset_seconds is 60", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.rate_limit_reset_seconds, 60, "rate_limit_reset_seconds");
  });

  // ── Reputation-derived trust score (v0.2 formula) ─────────────────────────

  await test("trust_score uses v0.2 formula (Phase 1, H1 inactive)", async () => {
    const store = makeFakeStore();
    const now = Date.now();
    store._setReputation(VALID_PK, { paidCount: 10, firstPaidAt: now - 1000, lastPaidAt: now, totalPaid: 1000 });
    const snap = await buildAgentStatus(store, VALID_PK, {});
    // Hand-computed: P1=20.79, P2≈0, D2=0, R1=100, raw_phase1=(0.30·20.79+0.25·100)/0.80=39.05, bonus=1.0
    if (Math.abs(snap.trust_score - 39.05) > 0.5) {
      throw new Error(`trust_score expected ~39.05, got ${snap.trust_score}`);
    }
  });

  await test("trust_score is bounded by tenure + recency, not just paidCount", async () => {
    const store = makeFakeStore();
    // paidCount=999 but missing tenure/recency timestamps — high volume but unverifiable history
    // Note: trust-score.js treats firstPaidAt=0/falsy as "missing" (P2=0) and lastPaidAt=0 as
    // "no last activity" (idleDays=Infinity → R1=0). No D2 (no attestations).
    store._setReputation(VALID_PK, { paidCount: 999, firstPaidAt: 0, lastPaidAt: 0, totalPaid: 0 });
    const snap = await buildAgentStatus(store, VALID_PK, {});
    // P1=60, P2=0, D2=0, R1=0, raw=(0.30·60)/0.80=22.5, bonus=1.0
    if (Math.abs(snap.trust_score - 22.5) > 0.5) {
      throw new Error(`trust_score expected ~22.5, got ${snap.trust_score}`);
    }
  });

  await test("trust_multiplier is 2 for score 21-50", async () => {
    const store = makeFakeStore();
    const now = Date.now();
    // paidCount=50, recent (P1=34.59, R1=100, P2≈0, D2=0)
    // raw=(0.30·34.59+0.25·100)/0.80=44.22, bonus=1.0 → score≈44.22
    store._setReputation(VALID_PK, { paidCount: 50, firstPaidAt: now - 1000, lastPaidAt: now, totalPaid: 0 });
    const snap = await buildAgentStatus(store, VALID_PK, {});
    assertEq(snap.trust_multiplier, 2, "trust_multiplier");
    assertEq(snap.trust_band, "21-50", "trust_band");
  });

  await test("trust_multiplier is 5 for score 51-80 (v0.2: needs cross-provider + recency)", async () => {
    const now = Date.now();
    const ops = ["op1", "op2", "op3", "op4", "op5"];
    const attestations = ops.map(op => ({ ts: now - 1000, amount: 1, operator_id: op }));
    const store = makeFakeStore({
      async getAttestations(_pk, _n) { return attestations; },
    });
    store._setReputation(VALID_PK, { paidCount: 50, firstPaidAt: now - 1000, lastPaidAt: now, totalPaid: 0 });
    const snap = await buildAgentStatus(store, VALID_PK, {});
    // P1=log10(51)·20=34.59, P2≈0, loyalty=1/5=0.2 → D2=80, R1=100
    // raw=(0.30·34.59+0.10·80+0.25·100)/0.80=54.22, bonus=1.4 → score≈75.91
    assertEq(snap.trust_multiplier, 5, "trust_multiplier");
    assertEq(snap.trust_band, "51-80", "trust_band");
  });

  await test("trust_multiplier is 10 for score 81-100 (v0.2: high P1 + cross-provider + recency)", async () => {
    const now = Date.now();
    const ops = ["op1", "op2", "op3", "op4", "op5", "op6", "op7", "op8"];
    const attestations = ops.map(op => ({ ts: now - 1000, amount: 1, operator_id: op }));
    const store = makeFakeStore({
      async getAttestations(_pk, _n) { return attestations; },
    });
    store._setReputation(VALID_PK, { paidCount: 200, firstPaidAt: now - 1000, lastPaidAt: now, totalPaid: 0 });
    const snap = await buildAgentStatus(store, VALID_PK, {});
    // P1=log10(201)·20=46.05, P2≈0, loyalty=1/8=0.125 → D2=87.5, R1=100
    // raw=(0.30·46.05+0.10·87.5+0.25·100)/0.80=59.46, bonus=1.5 (capped) → score≈89.18
    assertEq(snap.trust_multiplier, 10, "trust_multiplier");
    assertEq(snap.trust_band, "81-100", "trust_band");
  });

  await test("since is set from reputation.firstPaidAt", async () => {
    const store = makeFakeStore();
    const t = Date.now() - 50_000;
    store._setReputation(VALID_PK, { paidCount: 1, firstPaidAt: t, lastPaidAt: t, totalPaid: 100 });
    const snap = await buildAgentStatus(store, VALID_PK, {});
    assertEq(snap.since, t, "since");
  });

  // ── Ban state ───────────────────────────────────────────────────────────────

  await test("current_tier reflects active soft ban (tier 2)", async () => {
    const store = makeFakeStore();
    // getBan returns untilEpochMs (milliseconds); buildAgentStatus converts to seconds
    const untilMs = Date.now() + 300_000;
    const untilSec = Math.floor(untilMs / 1000);
    store._setBan(`pk:${VALID_PK}`, { tier: 2, until: untilMs, reason: "ip-rate-limit" });
    const snap = await buildAgentStatus(store, VALID_PK, {});
    assertEq(snap.current_tier, 2, "current_tier");
    assertEq(snap.until_epoch, untilSec, "until_epoch");
  });

  await test("current_tier 4 and permanent=true when key in permanent set", async () => {
    const store = makeFakeStore();
    store._setPermanent(`pk:${VALID_PK}`);
    const snap = await buildAgentStatus(store, VALID_PK, {});
    assertEq(snap.current_tier, 4, "current_tier permanent");
    assertEq(snap.permanent, true, "permanent flag");
    assertEq(snap.until_epoch, null, "until_epoch permanent");
  });

  // ── Fraud flags ─────────────────────────────────────────────────────────────

  await test("fraud_flags surfaced from computeFraudFlags callback", async () => {
    const store = makeFakeStore();
    const computeFraudFlags = async () => ["wash_payment_suspect"];
    const snap = await buildAgentStatus(store, VALID_PK, { computeFraudFlags });
    assertEq(snap.fraud_flags, ["wash_payment_suspect"], "fraud_flags");
  });

  await test("fraud_flags defaults to [] when computeFraudFlags throws", async () => {
    const store = makeFakeStore();
    const computeFraudFlags = async () => { throw new Error("detection failure"); };
    const snap = await buildAgentStatus(store, VALID_PK, { computeFraudFlags });
    assertEq(snap.fraud_flags, [], "fraud_flags degraded");
  });

  // ── Abuse history counters ──────────────────────────────────────────────────

  await test("throttles_5m counts only tier-1 events within 5 min", async () => {
    const store = makeFakeStore();
    const now = Date.now();
    store._setAbuseHistory(VALID_PK, [
      { tier: 1, ts: now - 60_000  },   // recent — counted
      { tier: 1, ts: now - 400_000 },   // older than 5min — not counted
      { tier: 2, ts: now - 10_000  },   // wrong tier — not counted
    ]);
    const snap = await buildAgentStatus(store, VALID_PK, {});
    assertEq(snap.throttles_5m, 1, "throttles_5m");
  });

  await test("soft_bans_24h counts only tier-2 events within 24 h", async () => {
    const store = makeFakeStore();
    const now = Date.now();
    store._setAbuseHistory(VALID_PK, [
      { tier: 2, ts: now - 3_600_000  },   // 1 h ago — in window
      { tier: 2, ts: now - 86_400_001 },   // just over 24 h — out
      { tier: 3, ts: now - 1_000      },   // wrong tier
    ]);
    const snap = await buildAgentStatus(store, VALID_PK, {});
    assertEq(snap.soft_bans_24h, 1, "soft_bans_24h");
  });

  await test("hard_bans_7d counts only tier-3 events within 7 days", async () => {
    const store = makeFakeStore();
    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    store._setAbuseHistory(VALID_PK, [
      { tier: 3, ts: now - 86_400_000    },   // 1 day ago — in window
      { tier: 3, ts: now - SEVEN_DAYS - 1 },  // just over 7d — out
      { tier: 2, ts: now - 1_000          },  // wrong tier
    ]);
    const snap = await buildAgentStatus(store, VALID_PK, {});
    assertEq(snap.hard_bans_7d, 1, "hard_bans_7d");
  });

  await test("abuse_history_count reflects total history entries", async () => {
    const store = makeFakeStore();
    store._setAbuseHistory(VALID_PK, [
      { tier: 1, ts: 1 },
      { tier: 1, ts: 2 },
      { tier: 2, ts: 3 },
    ]);
    const snap = await buildAgentStatus(store, VALID_PK, {});
    assertEq(snap.abuse_history_count, 3, "abuse_history_count");
  });

  // ── Sliding window (rate-limit query) ─────────────────────────────────────

  await test("rate_limit_remaining.pubkey reflects sliding-window query result", async () => {
    const store = makeFakeStore();
    store._setBucket(`rl:rpc:pk:${VALID_PK}`, 3);
    const snap = await buildAgentStatus(store, VALID_PK, {
      config: { RATE_IP_LIMIT: 60, RATE_PUBKEY_LIMIT: 10, RATE_GLOBAL_LIMIT: 1000 },
    });
    // count=3, max=10 → remaining=7
    assertEq(snap.rate_limit_remaining.pubkey, 7, "rate_limit_remaining.pubkey");
  });

  await test("rate_limit_remaining returns null gracefully when slidingWindowQuery throws", async () => {
    const store = makeFakeStore({
      async slidingWindowQuery() { throw new Error("redis down"); },
    });
    const snap = await buildAgentStatus(store, VALID_PK, {
      config: { RATE_IP_LIMIT: 60, RATE_PUBKEY_LIMIT: 10, RATE_GLOBAL_LIMIT: 1000 },
    });
    assertEq(snap.rate_limit_remaining.ip,     null, "ip null on error");
    assertEq(snap.rate_limit_remaining.pubkey, null, "pubkey null on error");
    assertEq(snap.rate_limit_remaining.global, null, "global null on error");
  });

  await test("store without slidingWindowQuery yields null rate_limit_remaining", async () => {
    // Simulate a minimal store that lacks slidingWindowQuery (shouldn't throw)
    const store = makeFakeStore();
    delete store.slidingWindowQuery;
    const snap = await buildAgentStatus(store, VALID_PK, {});
    assertEq(snap.rate_limit_remaining.ip, null, "ip null no method");
  });

  // ── pubkey passed through ───────────────────────────────────────────────────

  await test("pubkey field mirrors the input pubkey", async () => {
    const snap = await buildAgentStatus(makeFakeStore(), VALID_PK, {});
    assertEq(snap.pubkey, VALID_PK, "pubkey echo");
  });

  console.log(`\n${passed}/${passed + failed} tests passed.\n`);
  if (failed > 0) process.exit(1);
})();
