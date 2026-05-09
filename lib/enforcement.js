/**
 * lib/enforcement.js
 *
 * The deterministic 5-tier enforcement ladder (Section 8 of the design spec).
 *
 * Public API (this task — Task 4):
 *   - checkBan(store, key) → null | {tier, until, reason}
 *   - TIERS                — canonical numeric tier constants
 *   - TRUST_IMPACT         — closed vocabulary for X-x402-Trust-Impact header
 *
 * Public API extended in subsequent tasks:
 *   - recordOffense (Task 5)
 *   - inWhitelistWindow (Task 6)
 *   - enforcementResponse (Task 8)
 */

const { isKnownReason, REASONS } = require("./abuse-reasons");

const TIERS = Object.freeze({
  WARNING:   0,
  THROTTLE:  1,
  SOFT_BAN:  2,
  HARD_BAN:  3,
  PERMANENT: 4,
});

const TRUST_IMPACT = Object.freeze({
  NONE:      "none",
  WARN:      "warn",
  THROTTLE:  "throttle",
  SOFTBAN:   "softban",
  HARDBAN:   "hardban",
  PERMANENT: "permanent",
});

const TIER_TO_TRUST_IMPACT = Object.freeze({
  0: TRUST_IMPACT.WARN,
  1: TRUST_IMPACT.THROTTLE,
  2: TRUST_IMPACT.SOFTBAN,
  3: TRUST_IMPACT.HARDBAN,
  4: TRUST_IMPACT.PERMANENT,
});

/**
 * Look up the active enforcement state for `key`. Reads only; never mutates.
 * Permanent ban (`abuse:permanent`) takes precedence over any timed ban entry.
 *
 * @param {object} store — Phase-2 store with isPermanent + getBan
 * @param {string} key   — `ip:<ip>` or `pk:<pubkey>` (caller responsibility)
 * @returns {Promise<null | {tier:0|1|2|3|4, until: number|null, reason: string}>}
 */
async function checkBan(store, key) {
  if (!key) return null;
  if (await store.isPermanent(key)) {
    return { tier: TIERS.PERMANENT, until: null, reason: "permanent" };
  }
  const ban = await store.getBan(key);
  if (!ban) return null;
  return { tier: ban.tier, until: ban.until, reason: ban.reason };
}

// ─── Task 5: recordOffense ladder logic ──────────────────────────────────────

const FIVE_MIN_MS   = 5  * 60 * 1000;
const ONE_HOUR_MS   = 60 * 60 * 1000;
const ONE_DAY_MS    = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7  * ONE_DAY_MS;

// Default thresholds (Section 8.1). Multipliers from Trust-Score scale these
// up — see Task 7. "Score 0..20" treats these as the 1× baseline.
const DEFAULT_THRESHOLDS = Object.freeze({
  THROTTLES_5M_TO_SOFTBAN:       3,
  INVALID_SIGS_60S_TO_SOFTBAN:   10,
  SOFTBANS_24H_TO_HARDBAN:       3,
  HARDBANS_7D_TO_PERMANENT:      3,
  SOFT_BAN_DURATION_MS: parseInt(process.env.SOFT_BAN_DURATION_MS  || "300000",  10), // 5min
  HARD_BAN_DURATION_MS: parseInt(process.env.HARD_BAN_DURATION_MS  || "3600000", 10), // 1h
  HISTORY_TTL_MS: 7 * ONE_DAY_MS,
});

function _envInt(name, def) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : def;
}

function _resolveTierMax(opts) {
  if (typeof opts.tierMax === "number") return opts.tierMax;
  return _envInt("ENFORCEMENT_TIER_MAX", 3);
}

function _resolveWhitelistDays(opts) {
  if (typeof opts.whitelistDays === "number") return opts.whitelistDays;
  return _envInt("NEW_PUBKEY_WHITELIST_DAYS", 30);
}

/**
 * Count tier-N events in the last `windowMs`.
 * `tierFilter` may be a number or null (any).
 */
function _countRecent(history, tierFilter, windowMs, reasonFilter) {
  const cutoff = Date.now() - windowMs;
  let n = 0;
  for (const ev of history) {
    if (ev.ts < cutoff) continue;
    if (tierFilter !== null && ev.tier !== tierFilter) continue;
    if (reasonFilter != null && ev.reason !== reasonFilter) continue;
    n++;
  }
  return n;
}

function _historySummary(history) {
  return {
    throttles_5m:      _countRecent(history, 1, FIVE_MIN_MS,   null),
    invalid_sigs_60s:  _countRecent(history, 1, 60_000,        REASONS.INVALID_SIGNATURE_BURST),
    soft_bans_24h:     _countRecent(history, 2, ONE_DAY_MS,    null),
    hard_bans_7d:      _countRecent(history, 3, SEVEN_DAYS_MS, null),
  };
}

/**
 * Whitelist eval. The pubkey is in the "fresh agent" window when its
 * `firstPaidAt` is younger than `whitelistDays * 24h`. Pubkeys in this window
 * NEVER auto-promote to tier 4 — only manual /admin/ban (Phase 4).
 *
 * Two call shapes supported:
 *   inWhitelistWindow(store, pubkeyOrKey, days?)
 *     – queries store.getReputation; days default = NEW_PUBKEY_WHITELIST_DAYS
 *   inWhitelistWindow(null, _, days, firstPaidAtMs)
 *     – pure variant (no store call); see also recordOffense's
 *       `pubkeyFirstPaidAt` opt for the same purpose.
 */
async function inWhitelistWindow(store, pubkeyOrKey, days, firstPaidAtMs) {
  const d = typeof days === "number" ? days : _envInt("NEW_PUBKEY_WHITELIST_DAYS", 30);
  if (d <= 0) return false;
  let firstPaidAt = firstPaidAtMs;
  if (firstPaidAt == null && store && pubkeyOrKey) {
    // Strip "pk:" prefix if caller passed a ban-key shape.
    const pk = pubkeyOrKey.startsWith("pk:") ? pubkeyOrKey.slice(3) : pubkeyOrKey;
    const rep = await store.getReputation(pk);
    if (!rep || !rep.firstPaidAt) return false;
    firstPaidAt = rep.firstPaidAt;
  }
  if (typeof firstPaidAt !== "number" || firstPaidAt <= 0) return false;
  return (Date.now() - firstPaidAt) < d * ONE_DAY_MS;
}

/**
 * Record an offense and decide tier escalation. Always pushes one history
 * entry; the tier returned reflects post-record state.
 *
 * Options:
 *   - trustScore: 0..100 (default 0)             — applies multipliers (Task 7)
 *   - fraudSignals: string[] (default [])         — closed-vocab reasons from
 *                                                   detection.getActiveFraudFlags
 *   - tierMax: number                             — overrides ENFORCEMENT_TIER_MAX
 *   - whitelistDays: number                       — overrides NEW_PUBKEY_WHITELIST_DAYS
 *   - pubkeyFirstPaidAt: epoch ms                 — for whitelist eval (Task 6)
 *   - thresholds: partial override                — for tests
 *
 * Returns:
 *   { tier, reason, until, history_summary, escalated }
 */
async function recordOffense(store, key, reason, opts) {
  if (opts === undefined) opts = {};
  if (!key) throw new Error("recordOffense: key required");
  if (!isKnownReason(reason)) {
    throw new Error(`recordOffense: unknown reason "${reason}" (must be in abuse-reasons.REASONS)`);
  }

  const fraudSignals = Array.isArray(opts.fraudSignals) ? opts.fraudSignals : [];
  const T = Object.assign({}, DEFAULT_THRESHOLDS, opts.thresholds || {});
  const tierMax = _resolveTierMax(opts);

  // Trust-Score multiplier hooks (full implementation in Task 7) —
  // expose hook points NOW so test scenarios with non-zero scores still
  // reach the right thresholds.
  const { thresholdsMultiplier, requireFraudCorroboration, immuneToTier4 } =
    require("./_enforcement-trust-hooks").applyTrust(
      typeof opts.trustScore === "number" ? opts.trustScore : 0,
      fraudSignals
    );

  // Push the offense first, so the count reflects this event.
  const now = Date.now();
  await store.pushAbuseHistory(key, { ts: now, reason, tier: 1 }, T.HISTORY_TTL_MS);

  const history = await store.getAbuseHistory(key, T.HISTORY_TTL_MS);
  const summary = _historySummary(history);

  // Default: tier 1 (throttle, no ban set — caller's middleware already 429s)
  let resolvedTier = 1;
  let until = null;
  let escalated = false;

  // ── Step 1: detection-signal shortcut (tier 3) ─────────────────────────
  if (fraudSignals.length > 0 && summary.throttles_5m >= 1) {
    resolvedTier = 3;
    until = Math.floor((now + T.HARD_BAN_DURATION_MS) / 1000);
    escalated = true;
    await store.setBan(key, { tier: 3, until, reason }, T.HARD_BAN_DURATION_MS);
    await store.pushAbuseHistory(key, { ts: now, reason, tier: 3 }, T.HISTORY_TTL_MS);
  }
  // ── Step 2: 3 throttles in 5min OR 10 invalid-sigs in 60s → tier 2 ────
  else if (
    summary.throttles_5m >= Math.ceil(T.THROTTLES_5M_TO_SOFTBAN * thresholdsMultiplier) ||
    summary.invalid_sigs_60s >= Math.ceil(T.INVALID_SIGS_60S_TO_SOFTBAN * thresholdsMultiplier)
  ) {
    if (requireFraudCorroboration && fraudSignals.length === 0) {
      // High-trust pubkey — rate alone insufficient. Stay at throttle.
    } else {
      resolvedTier = 2;
      until = Math.floor((now + T.SOFT_BAN_DURATION_MS) / 1000);
      escalated = true;
      await store.setBan(key, { tier: 2, until, reason }, T.SOFT_BAN_DURATION_MS);
      await store.pushAbuseHistory(key, { ts: now, reason, tier: 2 }, T.HISTORY_TTL_MS);
    }
  }

  // ── Step 3: 3 soft bans in 24h → tier 3 ───────────────────────────────
  if (resolvedTier === 2 && summary.soft_bans_24h + 1 >= T.SOFTBANS_24H_TO_HARDBAN) {
    if (requireFraudCorroboration && fraudSignals.length === 0) {
      // Cap at tier 2 for high-trust without fraud corroboration.
    } else {
      resolvedTier = 3;
      until = Math.floor((now + T.HARD_BAN_DURATION_MS) / 1000);
      escalated = true;
      await store.setBan(key, { tier: 3, until, reason }, T.HARD_BAN_DURATION_MS);
      await store.pushAbuseHistory(key, { ts: now, reason, tier: 3 }, T.HISTORY_TTL_MS);
    }
  }

  // ── Step 4: 3 hard bans in 7d → tier 4 (heavily gated) ────────────────
  if (resolvedTier === 3 && summary.hard_bans_7d + 1 >= T.HARDBANS_7D_TO_PERMANENT) {
    const inWhitelist = await inWhitelistWindow(
      store,
      key,
      _resolveWhitelistDays(opts),
      opts.pubkeyFirstPaidAt
    );
    const allowedByEnv   = tierMax >= 4;
    const allowedByScore = !immuneToTier4;
    if (allowedByEnv && allowedByScore && !inWhitelist) {
      resolvedTier = 4;
      until = null;
      escalated = true;
      await store.addPermanent(key, { reason, by: "auto-ladder" });
      await store.pushAbuseHistory(key, { ts: now, reason, tier: 4 }, T.HISTORY_TTL_MS);
    }
    // else: stay at tier 3. Gating details surfaced via /agent/status (Phase 4).
  }

  return {
    tier:    resolvedTier,
    reason,
    until,
    escalated,
    history_summary: _historySummary(await store.getAbuseHistory(key, T.HISTORY_TTL_MS)),
  };
}

module.exports = {
  checkBan,
  TIERS,
  TRUST_IMPACT,
  TIER_TO_TRUST_IMPACT,
  recordOffense,
  inWhitelistWindow,
  DEFAULT_THRESHOLDS,
};
