/**
 * POST /attest — operator reports a paid challenge.
 *
 * Flow (per RFC §4):
 *   1. provider_id known? else 401
 *   2. provider_signature verifies over canonical body (sans signature)? else 401
 *   3. timestamp within ±TIMESTAMP_WINDOW_MS of server clock? else 400
 *   4. tx_signature seen? if yes → idempotent hit, return current reputation
 *   5. record + return updated ReputationRecord
 */

const express = require("express");
const router = express.Router();

const store = require("../store");
const { verify } = require("../lib/signature");
const { canonicalize } = require("../lib/canonical-json");
const {
  extendReputationFields,
  computeScoreV02,
} = require("../../lib/trust-score");

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

const REQUIRED_FIELDS = [
  "pubkey",
  "amount_micro_lamports",
  "tx_signature",
  "provider_id",
  "timestamp",
  "provider_signature",
];

function buildReputationRecord(pubkey) {
  const agg = store.getReputationAggregate(pubkey);
  const attestations = store.getAttestations(pubkey);

  if (!agg) {
    // Zeroed record for unknown / never-attested pubkey.
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
      fraud_flags: [],
      sybil_risk: "low",
      churn_pattern: "stable",
    };
  }

  const ext = extendReputationFields(agg, attestations);
  const disputes = store.reportsCount(pubkey);
  const score = computeScoreV02(agg, attestations, {
    h1Active: true,
    disputes,
  });

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
    // Stubs — full detection module lands in WS-C parte 2.
    fraud_flags: [],
    sybil_risk: "low",
    churn_pattern: "stable",
  };
}

router.post("/attest", (req, res) => {
  const body = req.body || {};

  // 0. Shape check
  for (const f of REQUIRED_FIELDS) {
    if (body[f] === undefined || body[f] === null || body[f] === "") {
      return res.status(400).json({ error: "missing_field", field: f });
    }
  }
  if (typeof body.amount_micro_lamports !== "number" || body.amount_micro_lamports < 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }
  if (typeof body.timestamp !== "number") {
    return res.status(400).json({ error: "invalid_timestamp" });
  }

  // 1. Provider known?
  const provider = store.getProvider(body.provider_id);
  if (!provider || provider.status !== "active") {
    return res.status(401).json({ error: "unknown_or_inactive_provider" });
  }

  // 2. Signature verify (over canonical body sans the sig field).
  const { provider_signature, ...signable } = body;
  let sigOk = false;
  try {
    sigOk = verify(signable, provider_signature, provider.pubkey);
  } catch (e) {
    return res.status(401).json({ error: "signature_verify_failed", reason: e.message });
  }
  if (!sigOk) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  // 3. Timestamp window.
  const skew = Math.abs(Date.now() - body.timestamp);
  if (skew > TIMESTAMP_WINDOW_MS) {
    return res.status(400).json({ error: "timestamp_out_of_window", skew_ms: skew });
  }

  // 4. Idempotency on tx_signature.
  if (store.hasSeenTx(body.tx_signature)) {
    return res.status(200).json(buildReputationRecord(body.pubkey));
  }

  // 5. Record + return.
  store.recordAttestation({
    pubkey: body.pubkey,
    amount: body.amount_micro_lamports,
    tx_signature: body.tx_signature,
    provider_id: body.provider_id,
    ts: body.timestamp,
  });

  // Touch canonicalize so the require isn't dead-weight (and to fail fast
  // if the sibling module is missing rather than crashing at signature time
  // under load). Cheap.
  canonicalize(signable);

  return res.status(200).json(buildReputationRecord(body.pubkey));
});

// Exported for the /reputation route to reuse.
router._buildReputationRecord = buildReputationRecord;

module.exports = router;
