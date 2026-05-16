/**
 * broker/lib/detection.js
 *
 * Wraps the parent lib/detection.js for broker use. The broker stores
 * attestations in the same shape lib/detection.js expects (after the
 * provider_id → operator_id translation done by store.getAttestations).
 *
 * Why a wrapper instead of direct require: (1) gives us a stable seam for
 * future broker-only detection signals that aren't relevant to the Shield,
 * (2) when the broker is extracted to its own repo we replace this wrapper
 * with a self-contained copy and the call sites don't change.
 *
 * The cross_provider_dispute signal is computed here (not in the parent)
 * because it depends on /report data, which only the broker holds. The
 * parent module is single-operator-aware only.
 */

const { computeRisk, _internal } = require("../../lib/detection");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * cross_provider_dispute: ≥2 distinct providers POST /report with the same
 * category in <24h. Computed locally because the parent detection module
 * doesn't see reports — they're broker-only state today.
 *
 * Returns the flag string (e.g. "cross_provider_dispute:spam_burst") or
 * null if not triggered. If multiple categories qualify, the first one in
 * iteration order wins — deterministic enough for MVP; future versions can
 * emit one flag per category if downstream needs it.
 */
function crossProviderDisputeFromReports(reports, now = Date.now()) {
  if (!reports || reports.length < 2) return null;
  const cutoff = now - ONE_DAY_MS;
  const recent = reports.filter((r) => r.ts > cutoff);
  if (recent.length < 2) return null;

  const byCategory = new Map();
  for (const r of recent) {
    const cat = r.category;
    if (!byCategory.has(cat)) byCategory.set(cat, new Set());
    byCategory.get(cat).add(r.provider_id);
  }
  for (const [cat, providers] of byCategory) {
    if (providers.size >= 2) return `cross_provider_dispute:${cat}`;
  }
  return null;
}

/**
 * Broker-side risk computation. Delegates the 4 attestation-derived signals
 * (wash_payment_suspect, dormant_revival, cross_provider_velocity,
 * coordinated_burst) to the parent module, then layers in
 * cross_provider_dispute from /report data.
 *
 * @param {Array<{ts:number, amount:number, operator_id:string}>} attestations
 * @param {{paidCount:number, firstPaidAt:number, lastPaidAt:number, totalPaid:number}|null} reputation
 * @param {Array<{ts:number, provider_id:string, category:string, evidence:string}>} [reports]
 */
function computeBrokerRisk(attestations, reputation, reports) {
  const base = computeRisk(attestations, reputation);
  const disputeFlag = reports ? crossProviderDisputeFromReports(reports) : null;
  if (disputeFlag) {
    base.fraud_flags = [...base.fraud_flags, disputeFlag];
  }
  return base;
}

/**
 * Signal definitions for /info — published so SDK implementers know what
 * fraud_flags values to expect and what sybil_risk levels mean.
 */
function signalDefinitions() {
  return [
    {
      id: "wash_payment_suspect",
      type: "single_operator",
      triggers: "Same operator + same pubkey + ≥50% of last 24h attestations at identical amount (min 50 events)",
      effect: "fraud_flags",
    },
    {
      id: "dormant_revival",
      type: "single_operator",
      triggers: "Pubkey silent ≥90d, then ≥50 attestations in last 24h",
      effect: "fraud_flags + sybil_risk:high",
    },
    {
      id: "cross_provider_velocity",
      type: "cross_operator",
      triggers: "Pubkey attested by ≥3 distinct operators in <24h; first_seen <72h ago",
      effect: "sybil_risk:high",
    },
    {
      id: "coordinated_burst",
      type: "cross_operator",
      triggers: "≥5 attestations in <24h with ≥2 distinct operators (per-pubkey proxy)",
      effect: "fraud_flags",
    },
    {
      id: "cross_provider_dispute",
      type: "cross_operator",
      triggers: "≥2 providers POST /report with same category in <24h",
      effect: "fraud_flags (broker-computed; suffix is :<category>)",
    },
  ];
}

module.exports = {
  computeBrokerRisk,
  signalDefinitions,
  _crossProviderDisputeFromReports: crossProviderDisputeFromReports,
  _parent: _internal,
};
