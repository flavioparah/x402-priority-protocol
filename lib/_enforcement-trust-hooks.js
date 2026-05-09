const {
  getTrustMultiplier,
  requiresFraudCorroboration,
  tier4ImmuneByScore,
} = require("./trust-multipliers");

/**
 * Hook consulted by lib/enforcement.js#recordOffense to fold Trust-Score
 * into the ladder thresholds.
 *
 * @param {number} trustScore   0..100
 * @param {string[]} fraudSignals from detection.getActiveFraudFlags
 * @returns {{thresholdsMultiplier: number, requireFraudCorroboration: boolean, immuneToTier4: boolean}}
 */
function applyTrust(trustScore, fraudSignals) {
  return {
    thresholdsMultiplier: getTrustMultiplier(trustScore),
    requireFraudCorroboration: requiresFraudCorroboration(trustScore),
    immuneToTier4: tier4ImmuneByScore(trustScore),
  };
}

module.exports = { applyTrust };
