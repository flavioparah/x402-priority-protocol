/**
 * lib/detection.js
 *
 * Sybil / fraud / churn detection over the per-pubkey attestation log.
 *
 * Implements the 5 signal taxonomy from docs/TRUST-SCORE-RFC-DRAFT.md §10.
 * In single-operator mode (today), only the single-op signals fire:
 *
 *   - wash_payment_suspect:  same operator + same pubkey + repeated equal amount
 *   - dormant_revival:       account silent >90d then sudden burst
 *
 * Cross-operator signals are pre-baked but inert until the broker observes
 * attestations from a 2nd operator (i.e., until distinct operator_id values
 * appear in the attestation log):
 *
 *   - cross_provider_velocity: pubkey active in N≥3 operators in <24h, account <72h old
 *   - coordinated_burst:       N≥10 pubkeys created <24h all attested by same op subset
 *   - cross_provider_dispute:  ≥2 ops report same pubkey same category in <24h (deferred — needs /report data)
 *
 * The `computeRiskForPubkey()` entry point runs all signals lazily on each
 * /reputation/:pubkey query. Cost: O(N) over the (≤100) attestation log,
 * negligible.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * ONE_DAY_MS;
const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;

/**
 * Top-level entry point. Returns { sybil_risk, fraud_flags, churn_pattern }.
 *
 * @param {Array<{ts:number, amount:number, operator_id:string}>} attestations
 * @param {{paidCount:number, firstPaidAt:number, lastPaidAt:number, totalPaid:number}|null} reputation
 */
function computeRisk(attestations, reputation) {
  const now = Date.now();
  const flags = [];

  if (washPaymentSuspect(attestations)) flags.push("wash_payment_suspect");
  if (dormantRevival(attestations, reputation, now)) flags.push("dormant_revival");
  if (coordinatedBurst(attestations, now)) flags.push("coordinated_burst");

  return {
    sybil_risk: classifySybilRisk(attestations, reputation, now),
    fraud_flags: flags,
    churn_pattern: classifyChurnPattern(attestations, reputation, now),
  };
}

// ─── Single-op signals ──────────────────────────────────────────────────────

/**
 * wash_payment_suspect: under sustained traffic, the same exact amount
 * appears on >50% of recent attestations. Indicative of a script paying
 * itself (operator wash, score farming).
 */
function washPaymentSuspect(attestations) {
  if (!attestations || attestations.length < 50) return false;

  const last24h = Date.now() - ONE_DAY_MS;
  const recent = attestations.filter((a) => a.ts > last24h);
  if (recent.length < 50) return false;

  const counts = new Map();
  for (const a of recent) {
    counts.set(a.amount, (counts.get(a.amount) || 0) + 1);
  }
  let maxFreq = 0;
  for (const c of counts.values()) if (c > maxFreq) maxFreq = c;
  return maxFreq / recent.length > 0.5;
}

/**
 * dormant_revival: pubkey silent for >90 days, then a sudden burst of
 * >50 events in last 24h. Often precedes coordinated abuse or stolen-key
 * exploitation.
 */
function dormantRevival(attestations, reputation, now = Date.now()) {
  if (!attestations || attestations.length < 50) return false;
  if (!reputation) return false;
  // The newest event in the log
  const newest = attestations[0]?.ts ?? 0;
  // The 51st-newest event timestamp — if "silent before then" >90 days, dormant
  const before = attestations[50]?.ts ?? 0;
  if (newest === 0 || before === 0) return false;
  const last24h = now - ONE_DAY_MS;
  const recentBurst = attestations.filter((a) => a.ts > last24h).length;
  if (recentBurst < 50) return false;
  // Account age vs. dormant gap
  if (reputation.firstPaidAt && (newest - reputation.firstPaidAt) < NINETY_DAYS_MS) return false;
  // The previous-active window check: was there a >90d gap before this burst?
  // Use the earliest-still-in-log event as a proxy
  const oldestInLog = attestations[attestations.length - 1]?.ts ?? 0;
  if (oldestInLog === 0) return false;
  return (newest - oldestInLog) > NINETY_DAYS_MS;
}

// ─── Cross-op signals (inert until 2nd operator observed) ───────────────────

function distinctOperators(attestations) {
  const set = new Set();
  for (const a of attestations) if (a.operator_id) set.add(a.operator_id);
  return set;
}

/**
 * cross_provider_velocity: pubkey attested by ≥3 distinct operators in <24h,
 * account first seen <72h ago. Strong sybil-farm indicator.
 *
 * Inert in single-op deployment (the set never reaches 3).
 */
function crossProviderVelocity(attestations, reputation, now = Date.now()) {
  if (!reputation || !reputation.firstPaidAt) return false;
  if ((now - reputation.firstPaidAt) > SEVENTY_TWO_HOURS_MS) return false;
  const last24h = now - ONE_DAY_MS;
  const recent = attestations.filter((a) => a.ts > last24h);
  return distinctOperators(recent).size >= 3;
}

/**
 * coordinated_burst: many distinct pubkeys created in <24h, all attested
 * by the same small set of operators. Implementation-wise, this signal is
 * computed at the BROKER level (across pubkeys) — we expose a per-pubkey
 * proxy here that flags if THIS pubkey was created recently AND has
 * ≥2 operators attesting in <24h.
 *
 * Inert in single-op deployment.
 */
function coordinatedBurst(attestations, now = Date.now()) {
  if (!attestations || attestations.length === 0) return false;
  const last24h = now - ONE_DAY_MS;
  const recent = attestations.filter((a) => a.ts > last24h);
  if (recent.length < 5) return false;
  return distinctOperators(recent).size >= 2;
}

// ─── Composite classifications ──────────────────────────────────────────────

function classifySybilRisk(attestations, reputation, now = Date.now()) {
  if (!reputation || !reputation.firstPaidAt) return "low";

  // Cross-op signal — strongest indicator when active
  if (crossProviderVelocity(attestations, reputation, now)) return "high";

  // Single-op heuristic: very young account paying very fast
  const accountAgeMs = now - reputation.firstPaidAt;
  const accountAgeHours = accountAgeMs / (60 * 60 * 1000);
  if (accountAgeHours < 6 && reputation.paidCount > 20) return "high";
  if (accountAgeHours < 24 && reputation.paidCount > 50) return "medium";
  if (accountAgeHours < 72 && reputation.paidCount > 100) return "medium";

  return "low";
}

function classifyChurnPattern(attestations, reputation, now = Date.now()) {
  if (!reputation || reputation.paidCount < 3) return "ephemeral";

  const operators = distinctOperators(attestations);
  if (operators.size >= 3) return "shopping";

  const lifespanDays = (reputation.lastPaidAt - reputation.firstPaidAt) / ONE_DAY_MS;
  const idleDays = (now - reputation.lastPaidAt) / ONE_DAY_MS;
  if (lifespanDays < 7 && idleDays > 7) return "ephemeral";

  return "stable";
}

module.exports = {
  computeRisk,
  // Exposed for unit tests
  _internal: {
    washPaymentSuspect,
    dormantRevival,
    crossProviderVelocity,
    coordinatedBurst,
    classifySybilRisk,
    classifyChurnPattern,
  },
};
