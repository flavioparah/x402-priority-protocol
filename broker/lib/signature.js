/**
 * broker/lib/signature.js
 *
 * Ed25519 signature helpers for Trust-Score Broker attestations.
 * Built on tweetnacl (the same curve impl the Shield uses) + bs58 (Solana
 * convention for encoding keys/signatures as text).
 *
 * The signed payload is always the RFC 8785 canonical JSON serialization
 * of the request body with the `provider_signature` field removed. Callers
 * must strip that field BEFORE calling verify/sign; this module does not
 * touch it (single-responsibility — canonicalize + sign/verify).
 *
 * All functions are synchronous (CPU-bound, sub-millisecond on modern HW)
 * and return false rather than throwing for malformed verification input.
 */

const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { canonicalize } = require("./canonical-json");

/**
 * Verify a provider's signature over a canonical body.
 *
 * Returns false (never throws) for any malformed input: bad base58, wrong
 * key/signature length, non-canonicalizable body, or curve verification
 * failure. This is intentional — verify() is called on untrusted external
 * input from providers and must be safe to invoke without try/catch.
 *
 * @param {object} body — the request body MINUS the provider_signature field
 * @param {string} signatureBs58 — base58-encoded Ed25519 signature (64 bytes)
 * @param {string} pubkeyBs58 — base58-encoded Ed25519 public key (32 bytes)
 * @returns {boolean}
 */
function verify(body, signatureBs58, pubkeyBs58) {
  try {
    if (typeof signatureBs58 !== "string" || typeof pubkeyBs58 !== "string") {
      return false;
    }
    if (body === null || typeof body !== "object") {
      return false;
    }
    const canonical = canonicalize(body);
    const msg = new TextEncoder().encode(canonical);
    const sig = bs58.decode(signatureBs58);
    const pk = bs58.decode(pubkeyBs58);
    if (sig.length !== 64) return false;
    if (pk.length !== 32) return false;
    return nacl.sign.detached.verify(msg, sig, pk);
  } catch (_e) {
    return false;
  }
}

/**
 * Sign a body with an Ed25519 secret key.
 *
 * FOR TESTS / dev use. Production providers sign with their own key material
 * out-of-band (HSM, cloud KMS, hardware wallet, etc.) — the broker only ever
 * verifies, never signs.
 *
 * @param {object} body — same shape passed to verify()
 * @param {Uint8Array} secretKey — 64-byte tweetnacl secret key (from generateKeypair)
 * @returns {string} base58-encoded signature
 */
function sign(body, secretKey) {
  const canonical = canonicalize(body);
  const msg = new TextEncoder().encode(canonical);
  const sig = nacl.sign.detached(msg, secretKey);
  return bs58.encode(sig);
}

/**
 * Generate an Ed25519 keypair. FOR TESTS only.
 *
 * @returns {{ publicKey: string, secretKey: Uint8Array }}
 *   publicKey is base58-encoded (Solana convention, 32 bytes).
 *   secretKey is the raw 64-byte tweetnacl secret key, kept as Uint8Array
 *   because it's only ever passed back into sign() in the same process.
 */
function generateKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: bs58.encode(kp.publicKey),
    secretKey: kp.secretKey,
  };
}

module.exports = { verify, sign, generateKeypair };
