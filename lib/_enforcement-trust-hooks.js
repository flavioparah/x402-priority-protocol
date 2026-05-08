/**
 * lib/_enforcement-trust-hooks.js
 *
 * Stub — overridden in Task 7 once trust-multipliers integration lands.
 * Returns the baseline 1× multipliers with no corroboration requirement
 * and no immunity to tier 4.
 */

module.exports.applyTrust = function applyTrust(_trustScore, _fraudSignals) {
  return {
    thresholdsMultiplier:    1,
    requireFraudCorroboration: false,
    immuneToTier4:           false,
  };
};
