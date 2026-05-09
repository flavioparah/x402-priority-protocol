"use strict";
/**
 * test/admin-mass-ban-guard.test.js — Phase 4 Task 14
 *
 * Unit-level regression test for massBanGuard middleware.
 * Calls the middleware directly with mock req/res/store — no server spawn.
 *
 * Scenarios:
 *   A. First N bans (≤ per-key limit) all pass (next() called).
 *   B. (N+1)th ban from the same admin key triggers 429.
 *   C. Throttled entry is written to the audit log with action_outcome = "throttled_mass_ban".
 *   D. store error → 503 fail-closed, audit entry written.
 *
 * Run: node test/admin-mass-ban-guard.test.js
 */

// ── Minimal in-process store (mirrors lib/store.js memory impl) ──────────────
function makeMockStore({ throwOnIncr = false } = {}) {
  const counters = new Map();
  const auditLog = [];
  return {
    async incrMassBanCounter(scope, ttlSec) {
      if (throwOnIncr) throw new Error("redis_down_simulated");
      const now = Date.now();
      const entry = counters.get(scope);
      if (!entry || entry.expiresAt <= now) {
        counters.set(scope, { count: 1, expiresAt: now + ttlSec * 1000 });
        return 1;
      }
      entry.count++;
      return entry.count;
    },
    async pushAuditAdmin(entry) {
      auditLog.unshift(entry);
    },
    auditLog,
  };
}

// ── Load module under test ────────────────────────────────────────────────────
// Set ADMIN_KEYS_JSON before require so parseAdminKeys picks it up.
process.env.ADMIN_KEYS_JSON = JSON.stringify({ "ops-massban-test": "aa".repeat(32) });

const { makeAdminGuards, _resetAdminKeysForTest } = require("../lib/admin");
_resetAdminKeysForTest();

// ── Helpers ───────────────────────────────────────────────────────────────────
let asserts = 0;
let failures = 0;

function ok(label, cond) {
  asserts++;
  if (!cond) {
    console.error(`  ✗ ${label}`);
    failures++;
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
}

/**
 * Build a minimal mock Express req object for massBanGuard.
 * rawBody is needed by auditAdminWrite for body_sha256.
 */
function makeReq(keyId = "ops-massban-test", pubkey = "PubXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX") {
  return {
    adminKeyId: keyId,
    method: "POST",
    originalUrl: "/admin/ban",
    path: "/admin/ban",
    rawBody: Buffer.from(JSON.stringify({ key: pubkey, type: "pubkey", tier: 3, reason: "test" })),
    body: { key: pubkey, type: "pubkey", tier: 3, reason: "test" },
    id: null,
    headers: {},
  };
}

/**
 * Minimal mock res that captures status + json payload.
 */
function makeRes() {
  const res = {
    _status: null,
    _body: null,
    _headers: {},
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    set(k, v) { this._headers[k] = v; return this; },
  };
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Scenario A + B: per-key limit = 10, bans 1-10 pass, 11th → 429 ─────────
  console.log("\n--- Scenario A+B: per-key rate limit ---");
  {
    const PER_KEY_MAX = 10;
    const store = makeMockStore();
    const config = {
      MASS_BAN_GUARD_PER_KEY_PER_MIN: PER_KEY_MAX,
      MASS_BAN_GUARD_GLOBAL_PER_HOUR: 50,
    };
    const { massBanGuard } = makeAdminGuards({ store, config });

    let firstThrottle = -1;
    for (let i = 0; i < 12; i++) {
      const req = makeReq("ops-massban-test", `Pub${i}`.padEnd(44, "1"));
      const res = makeRes();
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      await massBanGuard(req, res, next);

      const throttled = res._status === 429;
      if (throttled && firstThrottle === -1) firstThrottle = i + 1;
    }

    ok("11th ban-by-same-key triggers 429 (firstThrottle === 11)", firstThrottle === 11);
  }

  // ── Scenario C: throttled entry appears in audit log ────────────────────────
  console.log("\n--- Scenario C: audit log entry ---");
  {
    const store = makeMockStore();
    const config = {
      MASS_BAN_GUARD_PER_KEY_PER_MIN: 2, // very low limit for quick test
      MASS_BAN_GUARD_GLOBAL_PER_HOUR: 50,
    };
    const { massBanGuard } = makeAdminGuards({ store, config });

    // First 2 calls pass, 3rd is throttled
    for (let i = 0; i < 3; i++) {
      const req = makeReq("ops-massban-test", `PubAudit${i}`.padEnd(44, "2"));
      const res = makeRes();
      await massBanGuard(req, res, () => {});
    }

    const throttledEntry = store.auditLog.find(e => e.action_outcome === "throttled_mass_ban");
    ok("throttled_mass_ban entry in audit log", throttledEntry !== undefined);
    ok("throttled entry has guard field", throttledEntry && typeof throttledEntry.guard === "string");
    ok("throttled entry guard is per_key", throttledEntry && throttledEntry.guard === "per_key");
  }

  // ── Scenario D: store.incrMassBanCounter throws → 503 fail-closed ───────────
  console.log("\n--- Scenario D: store error → 503 fail-closed ---");
  {
    const store = makeMockStore({ throwOnIncr: true });
    const config = {
      MASS_BAN_GUARD_PER_KEY_PER_MIN: 10,
      MASS_BAN_GUARD_GLOBAL_PER_HOUR: 50,
    };
    const { massBanGuard } = makeAdminGuards({ store, config });

    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    await massBanGuard(req, res, () => { nextCalled = true; });

    ok("store error → 503 (not 200 or 429)", res._status === 503);
    ok("next() not called on store error", !nextCalled);
    ok("503 body error = ban_guard_unavailable", res._body && res._body.error === "ban_guard_unavailable");

    const errEntry = store.auditLog.find(e => e.action_outcome === "throttled_mass_ban");
    ok("store-error path still writes audit entry", errEntry !== undefined);
  }

  // ── Scenario E: global limit fires when per-key is still OK ─────────────────
  console.log("\n--- Scenario E: global rate limit ---");
  {
    // Directly prime the global counter via the store, then call with a fresh key
    const store = makeMockStore();
    const GLOBAL_MAX = 5;
    const config = {
      MASS_BAN_GUARD_PER_KEY_PER_MIN: 100, // won't fire
      MASS_BAN_GUARD_GLOBAL_PER_HOUR: GLOBAL_MAX,
    };
    const { massBanGuard } = makeAdminGuards({ store, config });

    // Exhaust the global bucket using a first key
    for (let i = 0; i < GLOBAL_MAX; i++) {
      await massBanGuard(makeReq("ops-key-A"), makeRes(), () => {});
    }

    // Now use a DIFFERENT key whose per-key counter is fresh (count=1)
    // but global counter is already at GLOBAL_MAX and next call pushes it over
    const req = makeReq("ops-key-B");
    const res = makeRes();
    await massBanGuard(req, res, () => {});

    ok("fresh key blocked when global limit exhausted", res._status === 429);
    const globalEntry = store.auditLog.find(e =>
      e.action_outcome === "throttled_mass_ban" && e.guard === "global"
    );
    ok("global guard audit entry written", globalEntry !== undefined);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const passed = asserts - failures;
  console.log(`\n${passed}/${asserts} assertions passed${failures > 0 ? ` (${failures} failed)` : ""}.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
