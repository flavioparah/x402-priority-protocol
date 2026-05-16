/**
 * GET /reputation/:pubkey — public read.
 *
 * Returns a v0.2 ReputationRecord. For unknown pubkey, returns a zeroed
 * record (NOT 404) so the calling Shield can still quote a price for a
 * fresh agent — the price quote is what drives the agent to its first
 * paid challenge, which then bootstraps reputation.
 */

const express = require("express");
const router = express.Router();

const store = require("../store");
const {
  extendReputationFields,
  computeScoreV02,
} = require("../../lib/trust-score");
const { computeBrokerRisk } = require("../lib/detection");

function buildReputationRecord(pubkey) {
  const agg = store.getReputationAggregate(pubkey);
  const attestations = store.getAttestations(pubkey);

  if (!agg) {
    // Zeroed record for unknown pubkey — but still run computeBrokerRisk on
    // the empty inputs so the shape (especially churn_pattern: "ephemeral"
    // for paidCount<3) matches what an attested-then-cleared pubkey would
    // return. Today this returns {fraud_flags:[], sybil_risk:"low",
    // churn_pattern:"ephemeral"} for the empty case.
    const emptyRisk = computeBrokerRisk([], null, []);
    return {
      pubkey,
      global_trust_score: 0,
      paid_count_total: 0,
      total_paid_micro_lamports: 0,
      first_seen_at: null,
      last_seen_at: null,
      active_in_n_providers: 0,
      loyalty_concentration: 1.0,
      per_provider: {},
      fraud_flags: emptyRisk.fraud_flags,
      sybil_risk: emptyRisk.sybil_risk,
      churn_pattern: emptyRisk.churn_pattern,
    };
  }

  const ext = extendReputationFields(agg, attestations);
  const disputes = store.reportsCount(pubkey);
  const score = computeScoreV02(agg, attestations, {
    h1Active: true,
    disputes,
  });
  const reports = store.getReports(pubkey);
  const risk = computeBrokerRisk(attestations, agg, reports);

  return {
    pubkey,
    global_trust_score: Math.round(score * 10) / 10,
    paid_count_total: agg.paidCount,
    total_paid_micro_lamports: agg.totalPaid,
    first_seen_at: agg.firstPaidAt,
    last_seen_at: agg.lastPaidAt,
    active_in_n_providers: ext.active_in_n_providers,
    loyalty_concentration: ext.loyalty_concentration,
    per_provider: ext.per_provider,
    fraud_flags: risk.fraud_flags,
    sybil_risk: risk.sybil_risk,
    churn_pattern: risk.churn_pattern,
  };
}

router.get("/reputation/:pubkey", (req, res) => {
  const pubkey = req.params.pubkey;
  if (!pubkey || pubkey.length < 32 || pubkey.length > 64) {
    return res.status(400).json({ error: "invalid_pubkey_format" });
  }
  return res.status(200).json(buildReputationRecord(pubkey));
});

module.exports = router;
