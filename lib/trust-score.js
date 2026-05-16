/**
 * lib/trust-score.js
 *
 * Trust-Score v0.2 — implements docs/rfc/x402-trust-score.md §5.1.
 *
 * Pure functions. No I/O, no Redis, no Express. Inputs are the same shapes
 * already used by lib/store.js:
 *
 *   reputation:   { paidCount, firstPaidAt, lastPaidAt, totalPaid } | null
 *   attestations: Array<{ ts, amount, operator_id }>  (most-recent-first per store.js)
 *
 * Five subscores normalized to 0-100 BEFORE weighting (so published weights match
 * effective contribution — RFC §5.1.2):
 *
 *   P1  paid_count, log-scaled        weight 0.30
 *   P2  tenure (months in network)    weight 0.15
 *   D2  distribution across providers weight 0.10
 *   H1  Laplace-smoothed no-dispute   weight 0.20  (inactive without /report)
 *   R1  recency (60-day decay)        weight 0.25
 *
 * Plus a binary H2 gate (fraud_flag active → score = 0) and a binary-by-operator
 * cross_provider_bonus multiplier capped at 1.5 (§5.1.4).
 *
 * Phase 1 — H1 depends on /report which is not yet built. When opts.h1Active is
 * false (default), we drop H1 from the sum and renormalize the remaining weights
 * to sum to 1.0 (§5.1.3). Silently treating H1 as zero would lower the headline
 * ceiling without changing published weights — auditability footgun avoided.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

const DEFAULT_WEIGHTS = Object.freeze({
  P1: 0.30,
  P2: 0.15,
  D2: 0.10,
  H1: 0.20,
  R1: 0.25,
});

const DEFAULT_DECAY_DAYS = 60;
const BONUS_INCREMENT = 0.1;
const BONUS_MAX = 1.5;

// ─── Subscore primitives (each returns 0-100) ────────────────────────────────

function p1(paidCount) {
  if (!paidCount || paidCount <= 0) return 0;
  return Math.min(100, Math.log10(1 + paidCount) * 20);
}

function p2(monthsInNetwork) {
  if (!monthsInNetwork || monthsInNetwork <= 0) return 0;
  return Math.min(100, Math.sqrt(monthsInNetwork) * 12);
}

function d2(loyaltyConcentration) {
  if (loyaltyConcentration == null) return 0;
  const clamped = Math.max(0, Math.min(1, loyaltyConcentration));
  return (1 - clamped) * 100;
}

// Laplace (add-one) smoothing — paid=0/disputes=0 yields 50, not 100. New
// agents don't inherit a perfect hygiene score from absence of evidence.
function h1(paidCount, disputes = 0) {
  const p = Math.max(0, paidCount || 0);
  const d = Math.max(0, disputes || 0);
  return ((p - d + 1) / (p + 2)) * 100;
}

function r1(idleDays, decayDays = DEFAULT_DECAY_DAYS) {
  if (idleDays == null) return 100;
  if (!isFinite(idleDays)) return 0;
  if (idleDays <= 0) return 100;
  return Math.exp(-idleDays / decayDays) * 100;
}

function crossProviderBonus(activeInNProviders) {
  const n = Math.max(1, activeInNProviders || 1);
  return Math.min(BONUS_MAX, 1 + BONUS_INCREMENT * (n - 1));
}

// ─── Cross-op aggregates from the attestation log ────────────────────────────

function distinctOperators(attestations) {
  const set = new Set();
  if (!attestations) return set;
  for (const a of attestations) if (a.operator_id) set.add(a.operator_id);
  return set;
}

function loyaltyConcentration(attestations) {
  if (!attestations || attestations.length === 0) return 1.0;
  const counts = new Map();
  for (const a of attestations) {
    const op = a.operator_id || "self";
    counts.set(op, (counts.get(op) || 0) + 1);
  }
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  return max / attestations.length;
}

/**
 * Extends the existing reputation hashmap with the cross-op fields the
 * v0.2 ReputationRecord requires (RFC §3). Pure function — does not mutate
 * the input.
 */
function extendReputationFields(reputation, attestations) {
  const ops = distinctOperators(attestations);

  const per_provider = {};
  if (attestations) {
    for (const a of attestations) {
      const id = a.operator_id || "self";
      if (!per_provider[id]) {
        per_provider[id] = {
          paid_count: 0,
          total_paid_micro_lamports: 0,
          first_seen_at: a.ts,
          last_seen_at: a.ts,
        };
      }
      const p = per_provider[id];
      p.paid_count += 1;
      p.total_paid_micro_lamports += a.amount || 0;
      if (a.ts < p.first_seen_at) p.first_seen_at = a.ts;
      if (a.ts > p.last_seen_at) p.last_seen_at = a.ts;
    }
  }

  return {
    active_in_n_providers: ops.size > 0 ? ops.size : (reputation ? 1 : 0),
    loyalty_concentration: loyaltyConcentration(attestations),
    per_provider,
  };
}

// ─── Composite score (RFC §5.1.2 + §5.1.3 + §5.1.4) ──────────────────────────

/**
 * @param {object|null} reputation
 * @param {Array} attestations
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.disputes=0] — count of /report submissions; only meaningful when h1Active
 * @param {boolean} [opts.h1Active=false] — true when /report endpoint is live and H1 should be weighted
 * @param {boolean} [opts.h2Gate=true] — false when any fraud_flag is active (forces score → 0)
 * @param {object} [opts.weights=DEFAULT_WEIGHTS]
 * @param {number} [opts.decayDays=60]
 */
function computeSubscores(reputation, attestations, opts = {}) {
  const now = opts.now || Date.now();
  const disputes = opts.disputes || 0;
  const h1Active = opts.h1Active === true;
  const h2Gate = opts.h2Gate !== false;
  const weights = opts.weights || DEFAULT_WEIGHTS;
  const decayDays = opts.decayDays || DEFAULT_DECAY_DAYS;

  if (!reputation || !reputation.paidCount) {
    return {
      P1: 0, P2: 0, D2: 0, H1: 0, R1: 0,
      raw: 0,
      bonus: 1.0,
      h2Gate,
      h1Active,
      activeInNProviders: distinctOperators(attestations).size || 0,
      score: 0,
    };
  }

  const monthsInNetwork = reputation.firstPaidAt
    ? Math.max(0, (now - reputation.firstPaidAt) / ONE_MONTH_MS)
    : 0;
  const idleDays = reputation.lastPaidAt
    ? Math.max(0, (now - reputation.lastPaidAt) / ONE_DAY_MS)
    : Infinity;
  const loyalty = loyaltyConcentration(attestations);

  const P1 = p1(reputation.paidCount);
  const P2 = p2(monthsInNetwork);
  const D2 = d2(loyalty);
  const H1 = h1(reputation.paidCount, disputes);
  const R1 = r1(idleDays, decayDays);

  let raw;
  if (h1Active) {
    raw = weights.P1 * P1
        + weights.P2 * P2
        + weights.D2 * D2
        + weights.H1 * H1
        + weights.R1 * R1;
  } else {
    // Renormalize remaining weights to sum to 1.0 (RFC §5.1.3).
    const remaining = weights.P1 + weights.P2 + weights.D2 + weights.R1;
    raw = (weights.P1 * P1
         + weights.P2 * P2
         + weights.D2 * D2
         + weights.R1 * R1) / remaining;
  }

  const activeInN = distinctOperators(attestations).size || 1;
  const bonus = crossProviderBonus(activeInN);

  const scoreBeforeGate = Math.min(100, raw * bonus);
  const score = h2Gate ? scoreBeforeGate : 0;

  return {
    P1, P2, D2, H1, R1,
    raw,
    bonus,
    h2Gate,
    h1Active,
    activeInNProviders: activeInN,
    score,
  };
}

/**
 * Top-level convenience returning just the 0-100 score. Drop-in replacement
 * for the legacy `Math.min(100, paidCount * 5)` callsites in:
 *   - index.js (4 occurrences)
 *   - lib/agent-status.js
 *   - lib/ratelimit.js
 *
 * Integration into those files is the next chunk of WS-B.
 */
function computeScoreV02(reputation, attestations, opts) {
  return computeSubscores(reputation, attestations, opts).score;
}

/**
 * Score policy that brokers SHOULD publish via GET /info (RFC §5.1.3 + §5.2.3).
 * Phase 1 default — H1 marked inactive_until_report_v1; flip when /report ships.
 */
function defaultPolicy({ h1Active = false } = {}) {
  return {
    spec_version: "0.2",
    score_components: [
      { id: "P1", weight: DEFAULT_WEIGHTS.P1, status: "active" },
      { id: "P2", weight: DEFAULT_WEIGHTS.P2, status: "active" },
      { id: "D2", weight: DEFAULT_WEIGHTS.D2, status: "active" },
      { id: "H1", weight: DEFAULT_WEIGHTS.H1, status: h1Active ? "active" : "inactive_until_report_v1" },
      { id: "R1", weight: DEFAULT_WEIGHTS.R1, status: "active" },
    ],
    normalization: "renormalize_remaining_to_one",
    cross_provider_bonus: { increment: BONUS_INCREMENT, max: BONUS_MAX },
    decay_days: DEFAULT_DECAY_DAYS,
  };
}

module.exports = {
  computeScoreV02,
  computeSubscores,
  extendReputationFields,
  defaultPolicy,
  DEFAULT_WEIGHTS,
  DEFAULT_DECAY_DAYS,
  // Exposed for unit tests
  _internal: { p1, p2, d2, h1, r1, crossProviderBonus, distinctOperators, loyaltyConcentration },
};
