"use strict";

/**
 * Pure functions implementing the Trust-Score → enforcement-tolerance mapping
 * from spec §8.3. No I/O, no side effects.
 *
 *   Score 0..20  : 1× rate budget, normal ladder
 *   Score 21..50 : 2× rate budget, normal ladder
 *   Score 51..80 : 5× rate budget, tier-4 inaccessible by auto-trigger
 *   Score 81..100: 10× rate budget, tier-2/3 require co-evidence,
 *                  tier-4 inaccessible by auto-trigger
 */

function clampScore(s) {
  if (typeof s !== "number" || !Number.isFinite(s)) return 0;
  if (s < 0) return 0;
  if (s > 100) return 100;
  return s;
}

function getTrustMultiplier(score) {
  const s = clampScore(score);
  if (s <= 20) return 1;
  if (s <= 50) return 2;
  if (s <= 80) return 5;
  return 10;
}

function getTrustBand(score) {
  const s = clampScore(score);
  if (s <= 20) return "0-20";
  if (s <= 50) return "21-50";
  if (s <= 80) return "51-80";
  return "81-100";
}

function requiresFraudCorroboration(score) {
  return clampScore(score) >= 81;
}

function tier4ImmuneByScore(score) {
  return clampScore(score) >= 51;
}

module.exports = {
  getTrustMultiplier,
  getTrustBand,
  requiresFraudCorroboration,
  tier4ImmuneByScore,
};
