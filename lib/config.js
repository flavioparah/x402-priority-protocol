"use strict";
/**
 * Central runtime configuration. Initial values seeded from process.env.
 * Whitelist controls which keys may be hot-reloaded via POST /admin/config.
 *
 * Promotion of ENFORCEMENT_TIER_MAX to 4 in mainnet requires both:
 *   - reason field includes manual_promotion: true
 *   - 4 conditions of Spec §8.1 audited and recorded out-of-band (runbook).
 */

const DEFAULTS = {
  RATE_IP_LIMIT: parseInt(process.env.RATE_IP_LIMIT || "100", 10),
  RATE_PUBKEY_LIMIT: parseInt(process.env.RATE_PUBKEY_LIMIT || "200", 10),
  RATE_PAID_PUBKEY_BASE: parseInt(process.env.RATE_PAID_PUBKEY_BASE || "200", 10),
  RATE_GLOBAL_LIMIT: parseInt(process.env.RATE_GLOBAL_LIMIT || "5000", 10),
  SOFT_BAN_DURATION_MS: parseInt(process.env.SOFT_BAN_DURATION_MS || "300000", 10),
  HARD_BAN_DURATION_MS: parseInt(process.env.HARD_BAN_DURATION_MS || "3600000", 10),
  ENFORCEMENT_TIER_MAX: parseInt(process.env.ENFORCEMENT_TIER_MAX || "3", 10),
  NEW_PUBKEY_WHITELIST_DAYS: parseInt(process.env.NEW_PUBKEY_WHITELIST_DAYS || "30", 10),
  BODY_LIMIT_RPC_BYTES: parseInt(process.env.BODY_LIMIT_RPC_BYTES || "32768", 10),
  DEPOSIT_PENDING_TTL_MS: parseInt(process.env.DEPOSIT_PENDING_TTL_MS || "15000", 10),
  DEPOSIT_NEGATIVE_CACHE_TTL_MS: parseInt(process.env.DEPOSIT_NEGATIVE_CACHE_TTL_MS || "60000", 10),
  SOLANA_CIRCUIT_THRESHOLD_PCT: parseInt(process.env.SOLANA_CIRCUIT_THRESHOLD_PCT || "50", 10),
  SOLANA_CIRCUIT_TIMEOUT_MS: parseInt(process.env.SOLANA_CIRCUIT_TIMEOUT_MS || "15000", 10),
  STORE_OP_TIMEOUT_MS: parseInt(process.env.STORE_OP_TIMEOUT_MS || "2000", 10),
  MASS_BAN_GUARD_PER_KEY_PER_MIN: parseInt(process.env.MASS_BAN_GUARD_PER_KEY_PER_MIN || "10", 10),
  MASS_BAN_GUARD_GLOBAL_PER_HOUR: parseInt(process.env.MASS_BAN_GUARD_GLOBAL_PER_HOUR || "50", 10),
  LOG_SAMPLE_AFTER: parseInt(process.env.LOG_SAMPLE_AFTER || "100", 10),
};

/** Live mutable config object — mutated by applyUpdate (hot-reload). */
const config = { ...DEFAULTS };

/**
 * Keys that may be changed at runtime via POST /admin/config.
 * Structural keys (BODY_LIMIT_RPC_BYTES, DEPOSIT_*, SOLANA_CIRCUIT_*,
 * STORE_OP_TIMEOUT_MS) require a restart and are intentionally excluded.
 */
const HOT_RELOADABLE = new Set([
  "RATE_IP_LIMIT",
  "RATE_PUBKEY_LIMIT",
  "RATE_PAID_PUBKEY_BASE",
  "RATE_GLOBAL_LIMIT",
  "SOFT_BAN_DURATION_MS",
  "HARD_BAN_DURATION_MS",
  "ENFORCEMENT_TIER_MAX",
  "NEW_PUBKEY_WHITELIST_DAYS",
  "MASS_BAN_GUARD_PER_KEY_PER_MIN",
  "MASS_BAN_GUARD_GLOBAL_PER_HOUR",
  "LOG_SAMPLE_AFTER",
]);

/**
 * Inclusive valid ranges for each hot-reloadable key.
 * Values outside these ranges are rejected by applyUpdate.
 */
const RANGES = {
  RATE_IP_LIMIT:                  [1, 10000],
  RATE_PUBKEY_LIMIT:              [1, 10000],
  RATE_PAID_PUBKEY_BASE:          [1, 10000],
  RATE_GLOBAL_LIMIT:              [10, 1000000],
  SOFT_BAN_DURATION_MS:           [60000, 86400000],
  HARD_BAN_DURATION_MS:           [60000, 604800000],
  ENFORCEMENT_TIER_MAX:           [2, 4],
  NEW_PUBKEY_WHITELIST_DAYS:      [0, 365],
  MASS_BAN_GUARD_PER_KEY_PER_MIN: [1, 100],
  MASS_BAN_GUARD_GLOBAL_PER_HOUR: [1, 1000],
  LOG_SAMPLE_AFTER:               [1, 100000],
};

/** Return a shallow copy of the current live config. */
function getConfig() { return { ...config }; }

/** Return a shallow copy of the compile-time defaults. */
function getDefaults() { return { ...DEFAULTS }; }

/**
 * Apply a single hot-reload update and return a result object.
 *
 * @param {string} key
 * @param {number|string} value  — coerced to integer
 * @param {object} [meta]        — { manual_promotion?: boolean } gates TIER_MAX→4
 * @returns {{ ok: boolean, key: string, oldValue?: number, newValue?: number, reason?: string }}
 */
function applyUpdate(key, value, meta = {}) {
  if (!HOT_RELOADABLE.has(key)) {
    return { ok: false, key, reason: "key_not_hot_reloadable" };
  }
  const [lo, hi] = RANGES[key] || [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  const n = typeof value === "number" ? value : parseInt(value, 10);
  if (!Number.isFinite(n) || n < lo || n > hi) {
    return { ok: false, key, reason: "value_out_of_range", range: [lo, hi] };
  }
  if (key === "ENFORCEMENT_TIER_MAX" && n === 4 && !meta.manual_promotion) {
    return { ok: false, key, reason: "tier4_requires_manual_promotion_flag" };
  }
  const oldValue = config[key];
  config[key] = n;
  return { ok: true, key, oldValue, newValue: n };
}

/**
 * Reset config to compile-time defaults. For use in tests only.
 * Not exported in the main bundle's public surface — callers import by name.
 */
function _resetForTest() { Object.assign(config, DEFAULTS); }

module.exports = {
  config,
  getConfig,
  getDefaults,
  applyUpdate,
  HOT_RELOADABLE,
  RANGES,
  _resetForTest,
};
