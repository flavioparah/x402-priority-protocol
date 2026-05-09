"use strict";
const crypto = require("crypto");
const { logger } = require("./logger");

// ─── Key map ────────────────────────────────────────────────────────────────
let KEY_MAP = null;
function parseAdminKeys() {
  if (KEY_MAP !== null) return KEY_MAP;
  const raw = process.env.ADMIN_KEYS_JSON || "";
  if (!raw) { KEY_MAP = new Map(); return KEY_MAP; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    logger.error({ kind: "admin", err: e.message }, "ADMIN_KEYS_JSON parse failed");
    KEY_MAP = new Map();
    return KEY_MAP;
  }
  KEY_MAP = new Map();
  for (const [keyId, secretHex] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(keyId)) continue;
    if (typeof secretHex !== "string" || !/^[0-9a-fA-F]{32,128}$/.test(secretHex)) continue;
    KEY_MAP.set(keyId, Buffer.from(secretHex, "hex"));
  }
  return KEY_MAP;
}
function _resetAdminKeysForTest() { KEY_MAP = null; }
function adminConfigured() { return parseAdminKeys().size > 0; }

// ─── Convenience: sha256 of a Buffer or string → hex string ─────────────────
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// ─── Raw body capture (must run before express.json) ────────────────────────
// Used by /admin/* HMAC verification (canonical string includes sha256 of body).
function captureRawBody(req, _res, next) {
  const chunks = [];
  let total = 0;
  const max = 4 * 1024;  // 4KB hard cap on /admin/* bodies
  req.on("data", chunk => {
    total += chunk.length;
    if (total > max) {
      // Drop further chunks; downstream will reject in verifyAdminAuth.
      req.rawBody = Buffer.concat([Buffer.from("BODY_TOO_LARGE")]);
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (total <= max) req.rawBody = Buffer.concat(chunks);
    next();
  });
  req.on("error", next);
}

// ─── Query string sort ───────────────────────────────────────────────────────
function sortQueryString(qs) {
  if (!qs) return "";
  const pairs = qs.split("&").filter(Boolean).map(kv => {
    const eq = kv.indexOf("=");
    return eq === -1 ? [kv, ""] : [kv.slice(0, eq), kv.slice(eq + 1)];
  });
  pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

// ─── Canonical string (§9.2) ─────────────────────────────────────────────────
// Input: a plain object OR an Express req.
//   Object form: { method, path, query, timestamp, keyId, bodySha256 }
//   Express req form: uses req.method, req.originalUrl/req.url,
//                     req.headers["x-admin-timestamp"], req.headers["x-admin-key-id"],
//                     req.rawBody
function buildCanonicalString(input) {
  // Detect object-param vs Express req
  if (input && typeof input.method === "string" && !input.originalUrl && !input.url) {
    // Plain object form: { method, path, query, timestamp, keyId, bodySha256 }
    const method = String(input.method).toUpperCase();
    const pathOnly = String(input.path || "");
    const sortedQuery = sortQueryString(String(input.query || ""));
    const ts = String(input.timestamp || "");
    const keyId = String(input.keyId || "");
    const bodySha = String(input.bodySha256 || sha256Hex(Buffer.alloc(0)));
    return [method, pathOnly, sortedQuery, ts, keyId, bodySha].join("\n");
  }

  // Express req form
  const req = input;
  const method = String(req.method).toUpperCase();
  const fullUrl = req.originalUrl || req.url || "";
  const qIdx = fullUrl.indexOf("?");
  const pathOnly = qIdx === -1 ? fullUrl : fullUrl.slice(0, qIdx);
  const queryRaw = qIdx === -1 ? "" : fullUrl.slice(qIdx + 1);
  const sortedQuery = sortQueryString(queryRaw);
  const ts = String(req.headers["x-admin-timestamp"] || "");
  const keyId = String(req.headers["x-admin-key-id"] || "");
  const bodyBuf = req.rawBody || Buffer.alloc(0);
  const bodySha = sha256Hex(bodyBuf);
  return [method, pathOnly, sortedQuery, ts, keyId, bodySha].join("\n");
}

module.exports = {
  parseAdminKeys, _resetAdminKeysForTest, adminConfigured,
  sha256Hex,
  captureRawBody, buildCanonicalString, sortQueryString,
};
