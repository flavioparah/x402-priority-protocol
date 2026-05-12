"use strict";

/**
 * Closed vocabulary of X-x402-Reason header values. Single source of truth.
 * Adding requires: (1) add here, (2) add to test, (3) document in spec §8.5.
 * Removing/renaming is a breaking SDK contract change.
 */

const REASONS = Object.freeze({
  IP_RATE_LIMIT:           "ip-rate-limit",
  PUBKEY_RATE_LIMIT:       "pubkey-rate-limit",
  GLOBAL_RATE_LIMIT:       "global-rate-limit",
  INVALID_SIGNATURE_BURST: "invalid-signature-burst",
  NONCE_REPLAY:            "nonce-replay",
  PUBKEY_HINT_MISMATCH:    "pubkey-hint-mismatch",
  WASH_PAYMENT:            "wash-payment",
  COORDINATED_BURST:       "coordinated-burst",
  DORMANT_REVIVAL:         "dormant-revival",
  DEPOSIT_SIGNATURE_INVALID: "deposit-signature-invalid",
  DEPOSIT_AMOUNT_MISMATCH: "deposit-amount-mismatch",
  BODY_TOO_LARGE:          "body-too-large",
  MALFORMED_PAYLOAD:       "malformed-payload",
});

const ALL_REASONS = Object.freeze(Object.values(REASONS));
const REASON_SET = new Set(ALL_REASONS);

function isKnownReason(s) {
  return typeof s === "string" && REASON_SET.has(s);
}

module.exports = { REASONS, ALL_REASONS, isKnownReason };
