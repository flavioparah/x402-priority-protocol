/**
 * POST /report — operator flags suspicious pubkey.
 *
 * Same auth pattern as /attest. The presence of /report is what makes H1
 * (no-dispute hygiene) an active scoring component in this broker — see
 * lib/trust-score.js `h1Active` flag.
 */

const express = require("express");
const router = express.Router();

const store = require("../store");
const { verify } = require("../lib/signature");
const { canonicalize } = require("../lib/canonical-json");

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 1024;

const VALID_CATEGORIES = new Set([
  "spam_burst",
  "duplicate_signature",
  "wash_payment",
  "payment_dispute",
  "refund_abuse",
  "other",
]);

const REQUIRED_FIELDS = [
  "pubkey",
  "provider_id",
  "category",
  "timestamp",
  "provider_signature",
];

router.post("/report", (req, res) => {
  const body = req.body || {};

  for (const f of REQUIRED_FIELDS) {
    if (body[f] === undefined || body[f] === null || body[f] === "") {
      return res.status(400).json({ error: "missing_field", field: f });
    }
  }
  if (typeof body.timestamp !== "number") {
    return res.status(400).json({ error: "invalid_timestamp" });
  }
  if (!VALID_CATEGORIES.has(body.category)) {
    return res.status(400).json({
      error: "invalid_category",
      valid: Array.from(VALID_CATEGORIES),
    });
  }
  const evidence = typeof body.evidence === "string" ? body.evidence : "";
  if (Buffer.byteLength(evidence, "utf8") > MAX_EVIDENCE_BYTES) {
    return res.status(400).json({ error: "evidence_too_large", max_bytes: MAX_EVIDENCE_BYTES });
  }

  const provider = store.getProvider(body.provider_id);
  if (!provider || provider.status !== "active") {
    return res.status(401).json({ error: "unknown_or_inactive_provider" });
  }

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

  const skew = Math.abs(Date.now() - body.timestamp);
  if (skew > TIMESTAMP_WINDOW_MS) {
    return res.status(400).json({ error: "timestamp_out_of_window", skew_ms: skew });
  }

  // Same dead-weight guard as /attest.
  canonicalize(signable);

  store.recordReport({
    pubkey: body.pubkey,
    provider_id: body.provider_id,
    category: body.category,
    evidence,
    ts: body.timestamp,
  });

  return res.status(200).json({ accepted: true });
});

module.exports = router;
