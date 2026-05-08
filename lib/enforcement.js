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

module.exports = {
  checkBan,
  TIERS,
  TRUST_IMPACT,
  TIER_TO_TRUST_IMPACT,
};
