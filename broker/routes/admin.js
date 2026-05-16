/**
 * Admin HTTP routes — operator-only provider lifecycle management.
 *
 * Mounted under /admin. All routes require an `X-Admin-Token` header that
 * matches the `BROKER_ADMIN_TOKEN` env var. If the env var is unset OR the
 * supplied header does not match, every admin call returns 401. This is
 * intentionally simple bearer-token auth for the MVP — HMAC + replay window
 * land in WS-H parte 2 alongside the audit log.
 *
 * The CLI in `broker/bin/broker-admin.js` is the canonical client for these
 * routes. They are deliberately the broker's PUBLIC admin surface — CI/CD,
 * future remote ops, and Postgres-backed deployments will all reuse the same
 * shape.
 */

const express = require("express");
const bs58 = require("bs58");
const router = express.Router();

const store = require("../store");

const VALID_TIERS = ["alpha", "beta", "production"];

// ─── Auth middleware ────────────────────────────────────────────────────────

function requireAdminToken(req, res, next) {
  const expected = process.env.BROKER_ADMIN_TOKEN;
  if (!expected) {
    return res.status(401).json({ error: "admin_disabled", reason: "BROKER_ADMIN_TOKEN not set" });
  }
  const supplied = req.get("X-Admin-Token");
  if (!supplied || supplied !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

router.use(requireAdminToken);

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Validate a Solana-style Ed25519 pubkey: base58, decodes to exactly 32 bytes. */
function isValidPubkey(pk) {
  if (typeof pk !== "string" || pk.length === 0) return false;
  try {
    const decoded = bs58.decode(pk);
    return decoded.length === 32;
  } catch (_e) {
    return false;
  }
}

function decorateProvider(p) {
  return {
    id: p.id,
    pubkey: p.pubkey,
    tier: p.tier,
    registeredAt: p.registeredAt,
    status: p.status,
    lastAttestAt: store.getProviderLastAttestAt(p.id),
    attestedCount30d: store.getProviderAttestedCount30d(p.id),
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

router.post("/providers", (req, res) => {
  const body = req.body || {};
  const { id, pubkey, tier } = body;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "missing_field", field: "id" });
  }
  if (!pubkey || typeof pubkey !== "string") {
    return res.status(400).json({ error: "missing_field", field: "pubkey" });
  }
  if (!tier || typeof tier !== "string") {
    return res.status(400).json({ error: "missing_field", field: "tier" });
  }
  if (!VALID_TIERS.includes(tier)) {
    return res.status(400).json({ error: "invalid_tier", valid: VALID_TIERS });
  }
  if (!isValidPubkey(pubkey)) {
    return res.status(400).json({ error: "invalid_pubkey", reason: "must be base58, 32 bytes" });
  }
  if (store.getProvider(id)) {
    return res.status(409).json({ error: "provider_exists", id });
  }
  const entry = store.registerProvider(id, pubkey, tier);
  return res.status(200).json(decorateProvider(entry));
});

router.get("/providers", (req, res) => {
  const list = store.listProviders().map(decorateProvider);
  return res.status(200).json(list);
});

router.get("/providers/:id", (req, res) => {
  const p = store.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: "not_found", id: req.params.id });
  return res.status(200).json(decorateProvider(p));
});

router.post("/providers/:id/suspend", (req, res) => {
  const p = store.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: "not_found", id: req.params.id });
  const reason = (req.body && typeof req.body.reason === "string") ? req.body.reason : "";
  store.setProviderStatus(req.params.id, "suspended");
  // Reason is currently observational — surfaced in the response, persisted
  // properly in the audit log (WS-H parte 2). Keeps the contract honest now.
  return res.status(200).json({ ...decorateProvider(store.getProvider(req.params.id)), reason });
});

router.post("/providers/:id/unsuspend", (req, res) => {
  const p = store.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: "not_found", id: req.params.id });
  store.setProviderStatus(req.params.id, "active");
  return res.status(200).json(decorateProvider(store.getProvider(req.params.id)));
});

router.post("/providers/:id/promote", (req, res) => {
  const p = store.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: "not_found", id: req.params.id });
  let next;
  if (p.tier === "alpha") next = "beta";
  else if (p.tier === "beta") next = "production";
  else return res.status(400).json({ error: "already_at_top_tier", tier: p.tier });
  store.setProviderTier(req.params.id, next);
  return res.status(200).json(decorateProvider(store.getProvider(req.params.id)));
});

module.exports = router;
