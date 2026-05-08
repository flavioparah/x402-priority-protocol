"use strict";

const bs58 = require("bs58").default || require("bs58");

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;
const PK_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE_RE = /^[a-f0-9]{32}$/;

const MAX_MESSAGE_BYTES = 1024;

/**
 * Pure-string preflight. Closed reason vocabulary: feedback-headers depend on it.
 */
function preflightAuth(authHeader) {
  if (!authHeader || typeof authHeader !== "string") return "missing";
  if (!authHeader.startsWith("x402 ")) return "missing";
  const parts = authHeader.slice(5).split(".");
  if (parts.length !== 3) return "malformed";
  if (parts[0].length < 80 || parts[0].length > 100) return "sig_length";
  if (parts[1].length < 32 || parts[1].length > 44) return "pubkey_length";
  if (parts[2].length < 50 || parts[2].length > 500) return "msg_length";
  return null;
}

/**
 * Bounded nonce pre-check. Reads ONLY payload.nonce — pubkey/amount/destination
 * stay untrusted until nacl.verify authenticates the message.
 */
async function noncePreCheck(parts, store) {
  let messageBytes;
  try {
    messageBytes = bs58.decode(parts[2]);
  } catch {
    return { ok: false, reason: "bad_base58" };
  }
  if (messageBytes.length > MAX_MESSAGE_BYTES) {
    return { ok: false, reason: "message_too_large" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(messageBytes).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_json" };
  }

  const nonce = payload?.nonce;
  if (typeof nonce !== "string") return { ok: false, reason: "no_nonce" };
  if (!NONCE_RE.test(nonce)) return { ok: false, reason: "bad_nonce_format" };

  let nonceData;
  try {
    nonceData = await store.getNonce(nonce);
  } catch {
    return { ok: false, reason: "nonce_lookup_failed" };
  }
  if (!nonceData) return { ok: false, reason: "nonce_unknown" };

  return { ok: true, nonce, nonceData, messageBytes, payload };
}

module.exports = {
  preflightAuth,
  noncePreCheck,
  SIG_RE,
  PK_RE,
  NONCE_RE,
  MAX_MESSAGE_BYTES,
};
