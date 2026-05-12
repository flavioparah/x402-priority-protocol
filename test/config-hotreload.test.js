"use strict";
/**
 * test/config-hotreload.test.js
 *
 * Unit tests for lib/config.js — hot-reload whitelist, range validation,
 * tier-4 promotion guard, and _resetForTest helper.
 *
 * Run: node test/config-hotreload.test.js
 */

const { strict: assert } = require("assert");
const {
  config,
  getConfig,
  getDefaults,
  applyUpdate,
  HOT_RELOADABLE,
  RANGES,
  _resetForTest,
} = require("../lib/config");

let passed = 0;
let failed = 0;
function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    failed++;
  } finally {
    _resetForTest();
  }
}

// ── getConfig / getDefaults return copies ────────────────────────────────────
test("getConfig returns a plain object copy", () => {
  const c = getConfig();
  assert.equal(typeof c, "object");
  assert.ok(c !== config, "should be a copy, not the live reference");
  assert.ok("RATE_IP_LIMIT" in c);
});

test("getDefaults returns compile-time values unchanged after mutation", () => {
  applyUpdate("RATE_IP_LIMIT", 42);
  const d = getDefaults();
  assert.ok(d.RATE_IP_LIMIT !== 42, "defaults should not be affected by applyUpdate");
});

// ── Hot-reload whitelist ──────────────────────────────────────────────────────
test("HOT_RELOADABLE is a Set and contains RATE_IP_LIMIT", () => {
  assert.ok(HOT_RELOADABLE instanceof Set);
  assert.ok(HOT_RELOADABLE.has("RATE_IP_LIMIT"));
});

test("structural key BODY_LIMIT_RPC_BYTES is NOT hot-reloadable", () => {
  const result = applyUpdate("BODY_LIMIT_RPC_BYTES", 65536);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "key_not_hot_reloadable");
});

test("unknown key returns key_not_hot_reloadable", () => {
  const result = applyUpdate("TOTALLY_UNKNOWN_KEY", 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "key_not_hot_reloadable");
});

// ── Range validation ──────────────────────────────────────────────────────────
test("applyUpdate accepts value within range", () => {
  const result = applyUpdate("RATE_IP_LIMIT", 50);
  assert.equal(result.ok, true);
  assert.equal(result.newValue, 50);
  assert.equal(config.RATE_IP_LIMIT, 50);
});

test("applyUpdate rejects value below range minimum", () => {
  const result = applyUpdate("RATE_IP_LIMIT", 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "value_out_of_range");
  assert.deepEqual(result.range, RANGES.RATE_IP_LIMIT);
});

test("applyUpdate rejects value above range maximum", () => {
  const result = applyUpdate("RATE_IP_LIMIT", 99999);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "value_out_of_range");
});

test("applyUpdate rejects non-numeric string", () => {
  const result = applyUpdate("RATE_IP_LIMIT", "banana");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "value_out_of_range");
});

test("applyUpdate accepts numeric string coercion", () => {
  const result = applyUpdate("LOG_SAMPLE_AFTER", "200");
  assert.equal(result.ok, true);
  assert.equal(result.newValue, 200);
});

// ── Tier-4 promotion guard ────────────────────────────────────────────────────
test("ENFORCEMENT_TIER_MAX accepts 2 without manual_promotion", () => {
  const result = applyUpdate("ENFORCEMENT_TIER_MAX", 2);
  assert.equal(result.ok, true);
});

test("ENFORCEMENT_TIER_MAX accepts 3 without manual_promotion", () => {
  const result = applyUpdate("ENFORCEMENT_TIER_MAX", 3);
  assert.equal(result.ok, true);
});

test("ENFORCEMENT_TIER_MAX rejects 4 without manual_promotion flag", () => {
  const result = applyUpdate("ENFORCEMENT_TIER_MAX", 4);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "tier4_requires_manual_promotion_flag");
});

test("ENFORCEMENT_TIER_MAX accepts 4 with manual_promotion: true", () => {
  const result = applyUpdate("ENFORCEMENT_TIER_MAX", 4, { manual_promotion: true });
  assert.equal(result.ok, true);
  assert.equal(result.newValue, 4);
  assert.equal(config.ENFORCEMENT_TIER_MAX, 4);
});

test("ENFORCEMENT_TIER_MAX rejects value > 4", () => {
  const result = applyUpdate("ENFORCEMENT_TIER_MAX", 5, { manual_promotion: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "value_out_of_range");
});

// ── applyUpdate return shape ──────────────────────────────────────────────────
test("successful applyUpdate returns oldValue and newValue", () => {
  const before = config.RATE_GLOBAL_LIMIT;
  const result = applyUpdate("RATE_GLOBAL_LIMIT", 1000);
  assert.equal(result.ok, true);
  assert.equal(result.oldValue, before);
  assert.equal(result.newValue, 1000);
});

// ── _resetForTest ─────────────────────────────────────────────────────────────
test("_resetForTest restores defaults after mutations", () => {
  applyUpdate("RATE_IP_LIMIT", 77);
  applyUpdate("LOG_SAMPLE_AFTER", 5000);
  _resetForTest();
  const d = getDefaults();
  assert.equal(config.RATE_IP_LIMIT, d.RATE_IP_LIMIT);
  assert.equal(config.LOG_SAMPLE_AFTER, d.LOG_SAMPLE_AFTER);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exitCode = 1;
