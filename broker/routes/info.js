/**
 * GET /info — broker capability discovery.
 *
 * Publishes spec_version, score component weights, normalization mode,
 * cross-provider bonus parameters, provider-weight policy (from sibling
 * Agent C's `lib/weight.js`), count of registered providers, and a
 * federation_peers list (empty until WS-C parte 3).
 *
 * H1 is active in this broker because /report exists (unlike the Shield's
 * Phase 1, where H1 is `inactive_until_report_v1`).
 */

const express = require("express");
const router = express.Router();

const store = require("../store");
const { defaultPolicy: defaultScorePolicy } = require("../../lib/trust-score");
const { defaultPolicy: defaultWeightPolicy } = require("../lib/weight");
const { signalDefinitions } = require("../lib/detection");

const BROKER_ID = process.env.BROKER_ID || "x402-broker-mvp";

router.get("/info", (req, res) => {
  const scorePolicy = defaultScorePolicy({ h1Active: true });
  return res.status(200).json({
    spec_version: scorePolicy.spec_version,
    broker_id: BROKER_ID,
    score_components: scorePolicy.score_components,
    normalization: scorePolicy.normalization,
    cross_provider_bonus: scorePolicy.cross_provider_bonus,
    decay_days: scorePolicy.decay_days,
    provider_weight_policy: defaultWeightPolicy(),
    providers_registered: store.providersCount(),
    detection_signals: signalDefinitions(),
    federation_peers: [],
  });
});

module.exports = router;
