"use strict";
/**
 * Code of Conduct — Section 9.3 of the spec.
 *
 * IMMUTABLE within a major version. Breaking changes bump version.minor or
 * major, but never silent edit. Frozen recursively (deepFreeze) so a misbehaving
 * handler cannot mutate it at runtime — the JSON returned is a defensive
 * structural clone, but identity guarantees prevent accidental cross-test
 * pollution.
 */
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

const CODE_OF_CONDUCT_V1 = deepFreeze({
  version: "1.0",
  rate_budgets: {
    per_ip: { sustained_rps: 1.66, burst: 100, window_s: 60 },
    per_pubkey: { sustained_rps: 3.33, burst: 200, window_s: 60 },
    global: { sustained_rps: 83.3, burst: 5000, window_s: 60 },
  },
  backoff_protocol: {
    on_429: "respect Retry-After header; exponential after 3rd consecutive",
    on_402: "complete handshake; do not retry without payment",
    on_503: "exponential 1s..30s; check /agent/status before continuing",
  },
  identity_rules: {
    pubkey_hint_must_match_signer: true,
    nonce_single_use: true,
    pubkey_rotation_max_per_hour: 1,
    _note_pubkey_rotation_enforcement:
      "descritiva — enforced indiretamente via cross_provider_velocity / coordinated_burst signals em lib/detection.js, não via middleware dedicado",
  },
  deposit_rules: {
    signature_must_be_valid_base58: true,
    signature_must_credit_payment_destination: true,
    invalid_signatures_per_5min_max: 5,
  },
  enforcement: {
    tiers: ["warning", "throttle", "soft_ban", "hard_ban", "permanent"],
    trust_multipliers: { "0-20": 1, "21-50": 2, "51-80": 5, "81-100": 10 },
    new_pubkey_whitelist_days: 30,
    feedback_headers: ["X-x402-Tier", "X-x402-Reason", "X-x402-Until", "X-x402-Trust-Impact"],
  },
  operator_obligations: {
    audit_log_retention_days: 90,
    permanent_ban_must_have_reason: true,
    api_key_rotation_max_days: 90,
  },
});

const VERSIONS = { "1.0": CODE_OF_CONDUCT_V1 };

function getCodeOfConduct(version) {
  return VERSIONS[version || "1.0"] || null;
}

module.exports = { CODE_OF_CONDUCT_V1, getCodeOfConduct };
