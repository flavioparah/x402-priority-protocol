/**
 * broker/lib/weight.js
 *
 * Provider weight policy module per RFC v0.2 §5.2.
 *
 * "Provider weight" weight(p) is the broker's measure of operator credibility,
 * used to weigh /report submissions (e.g., 3 high-weight providers flagging the
 * same pubkey escalates to a fraud_flag). This is DELIBERATELY DECOUPLED from
 * the per-pubkey agent trust score: operator credibility (political/economic)
 * and agent behavior (per-pubkey aggregates) are computed independently.
 *
 * No I/O, no time-of-day surprises: `now` is injectable in every function that
 * touches a clock so tests stay deterministic.
 */

const TIER_BASE = Object.freeze({ alpha: 0.5, beta: 1.0, production: 1.5 });

const DEFAULT_POLICY = Object.freeze({
  pubkey_reach_threshold: 25,
  cap_multiple_of_active_median: 3,
  floor_weight: 0.3,
  active_window_days: 7,
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute raw_weight(p) per RFC §5.2.1.
 *
 *   raw_weight(p) = tier_base(p) × log10(1 + attested_count_30d)
 *                                × sqrt(max(1, months_in_network))
 *
 * @param {object} provider
 * @param {"alpha"|"beta"|"production"} provider.tier
 * @param {number} provider.attestedCount30d
 * @param {number} provider.monthsInNetwork
 * @returns {number}
 */
function rawWeight(provider) {
  if (!provider) return 0;
  const base = TIER_BASE[provider.tier];
  if (base == null) return 0;
  const count = Math.max(0, provider.attestedCount30d || 0);
  const months = Math.max(1, provider.monthsInNetwork || 1);
  return base * Math.log10(1 + count) * Math.sqrt(months);
}

/**
 * Filter providers down to the active cohort per §5.2.2.
 *
 * Active cohort = { p :
 *     raw_weight(p) > 0
 *     AND status(p) == "production"
 *     AND last_attest_at >= now - active_window_days
 *     AND distinct_pubkeys_attested_30d >= pubkey_reach_threshold
 * }
 *
 * Rationale: computing the median over all registered providers would collapse
 * to zero (most providers have raw_weight=0 at any given moment), inflating
 * the cap. The active cohort filter pins the median to providers actually
 * carrying traffic right now.
 *
 * @param {Array} providers
 * @param {object} [policy=DEFAULT_POLICY]
 * @param {number} [now=Date.now()]
 * @returns {Array} subset of providers in the active cohort
 */
function activeCohort(providers, policy = DEFAULT_POLICY, now = Date.now()) {
  if (!providers || providers.length === 0) return [];
  const windowMs = policy.active_window_days * 24 * 60 * 60 * 1000;
  const reach = policy.pubkey_reach_threshold;
  return providers.filter(p => {
    if (!p) return false;
    if (p.status !== "production") return false;
    if (rawWeight(p) <= 0) return false;
    if (p.lastAttestAt == null) return false;
    if ((now - p.lastAttestAt) > windowMs) return false;
    if ((p.distinctPubkeysAttested30d || 0) < reach) return false;
    return true;
  });
}

/**
 * Median raw_weight over the active cohort. Returns 0 if cohort is empty.
 *
 * For odd n: middle element. For even n: average of the two middle elements.
 *
 * Conflict-of-interest mitigation per BROKER-GOVERNANCE.md §8:
 * Providers tagged `isBrokerSelf: true` are excluded from this median to
 * prevent the broker operator from self-inflating the cap on its own weight
 * via its own attestation volume. The self provider's own `weight(p)` is
 * still computed normally — cap is derived from others, conditional floor
 * still applies — so the self provider gets a real weight assignment, it
 * just doesn't drag the cap upward through its own median contribution.
 *
 * The opts.excludeSelf flag (default true) is provided so tests can verify
 * the pre-filter shape explicitly. Production callers should leave it at
 * the default; the default IS the governance-mandated behavior.
 *
 * @param {Array} activeProviders
 * @param {object} [opts]
 * @param {boolean} [opts.excludeSelf=true] — when true (default), filter out
 *   any provider with `isBrokerSelf === true` before computing the median.
 * @returns {number}
 */
function networkMedian(activeProviders, opts = {}) {
  if (!activeProviders || activeProviders.length === 0) return 0;
  const excludeSelf = opts.excludeSelf !== false; // default true
  const eligible = excludeSelf
    ? activeProviders.filter(p => !(p && p.isBrokerSelf === true))
    : activeProviders;
  if (eligible.length === 0) return 0;
  const values = eligible.map(rawWeight).sort((a, b) => a - b);
  const n = values.length;
  if (n % 2 === 1) return values[Math.floor(n / 2)];
  return (values[n / 2 - 1] + values[n / 2]) / 2;
}

/**
 * Final weight(p) — cap and conditional floor applied. Per RFC §5.2.3.
 *
 *   floor(p)  = floor_weight  if  p in active_cohort  AND  no_disputes_30d(p)
 *             = 0              otherwise
 *
 *   weight(p) = max(floor(p), min(raw_weight(p),
 *                                 cap_multiple_of_active_median × median))
 *
 * Edge case: if median == 0 (empty cohort), cap == 0 and the inner min() is 0.
 * The floor still wins via max() if the provider qualifies. If the provider
 * doesn't qualify for the floor either, weight(p) = 0 — correct behavior for
 * a network with no active cohort yet (cold start).
 *
 * Conflict-of-interest note: `networkMedian(cohort)` is called with default
 * opts, so any provider in the cohort tagged `isBrokerSelf: true` is excluded
 * from the median per BROKER-GOVERNANCE.md §8. This applies even when the
 * subject provider being weighted is itself the self provider — cap derives
 * from non-self peers, but the self provider's own raw and floor still apply
 * normally, so the self provider does receive a real weight assignment.
 *
 * @param {object} provider
 * @param {Array} cohort — precomputed active cohort
 * @param {object} [policy=DEFAULT_POLICY]
 * @param {number} [now=Date.now()]
 * @returns {number}
 */
function weight(provider, cohort, policy = DEFAULT_POLICY, now = Date.now()) {
  if (!provider) return 0;
  const raw = rawWeight(provider);
  const median = networkMedian(cohort);
  const cap = policy.cap_multiple_of_active_median * median;
  const inCohort = Array.isArray(cohort)
    && cohort.some(p => p && p.id === provider.id);
  const noRecentDisputes = noDisputesInLast30d(provider, now);
  const floor = (inCohort && noRecentDisputes) ? policy.floor_weight : 0;
  return Math.max(floor, Math.min(raw, cap));
}

/**
 * Helper: provider has no disputes in the last 30 days.
 *
 * Reads `provider.lastDisputeAt` if present (epoch ms). If missing/null/0,
 * treat as no disputes. Boundary: a dispute exactly 30 days ago is treated
 * as "recent" (strict > 30d means "no recent"), matching the conservative
 * default the broker should take on the edge.
 *
 * @param {object} provider
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
function noDisputesInLast30d(provider, now = Date.now()) {
  if (!provider) return true;
  if (!provider.lastDisputeAt) return true;
  return (now - provider.lastDisputeAt) > THIRTY_DAYS_MS;
}

/**
 * The default governance policy. Brokers publish this in GET /info.
 * Returns a fresh copy so callers can mutate without affecting the constant.
 *
 * @returns {object}
 */
function defaultPolicy() {
  return { ...DEFAULT_POLICY };
}

module.exports = {
  rawWeight,
  activeCohort,
  networkMedian,
  weight,
  defaultPolicy,
  TIER_BASE,
  _internal: { noDisputesInLast30d, THIRTY_DAYS_MS, DEFAULT_POLICY },
};
