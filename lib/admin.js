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

// ─── CORS lockdown for /admin/* ───────────────────────────────────────────────
const ORIGIN_ALLOWLIST_DEFAULT = "https://api.rpcpriority.com,https://ops.rpcpriority.com";
const TS_SKEW_S = 60;

/**
 * Middleware: restrict Origin to an explicit allowlist (or no Origin = server-to-server).
 * Must run before verifyAdminAuth in the /admin/* middleware chain.
 *
 * NEVER sends Access-Control-Allow-Origin: * for /admin paths.
 */
function corsAdminLockdown(req, res, next) {
  const allowlist = (process.env.ADMIN_ORIGIN_ALLOWLIST || ORIGIN_ALLOWLIST_DEFAULT)
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;

  // Strip any inherited wide-open CORS headers.
  res.removeHeader("Access-Control-Allow-Origin");
  res.removeHeader("Access-Control-Allow-Credentials");

  if (origin) {
    if (!allowlist.includes(origin)) {
      return res.status(403).json({ error: "origin_forbidden", code: 403 });
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers",
      "Content-Type, X-Admin-Key-Id, X-Admin-Timestamp, X-Admin-Auth");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

// ─── Timing-safe hex comparison ──────────────────────────────────────────────
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// ─── HMAC admin auth middleware ───────────────────────────────────────────────
/**
 * Middleware: verify HMAC-SHA256 admin authentication headers.
 *
 * Required headers:
 *   X-Admin-Key-Id      — key identifier matching ADMIN_KEYS_JSON
 *   X-Admin-Timestamp   — Unix seconds (must be within TS_SKEW_S of server clock)
 *   X-Admin-Auth        — HMAC-SHA256 hex over the canonical string
 *
 * On success: sets req.adminKeyId and calls next().
 * On failure: responds 401 with { error, code }.
 */
function verifyAdminAuth(req, res, next) {
  const keys = parseAdminKeys();
  if (keys.size === 0) {
    res.set("X-Admin-Status", "not_configured");
    return res.status(503).json({ error: "admin_not_configured", code: 503 });
  }

  // Sentinel value written by captureRawBody when the body exceeded the 4 KB cap.
  if (req.rawBody &&
      req.rawBody.length === Buffer.byteLength("BODY_TOO_LARGE") &&
      req.rawBody.toString() === "BODY_TOO_LARGE") {
    res.set("X-Admin-Status", "body_too_large");
    return res.status(413).json({ error: "body_too_large", code: 413 });
  }

  const keyId  = req.headers["x-admin-key-id"];
  const tsStr  = req.headers["x-admin-timestamp"];
  const sigHex = req.headers["x-admin-auth"];

  if (!keyId || !tsStr || !sigHex) {
    res.set("X-Admin-Status", "missing_headers");
    return res.status(401).json({ error: "missing_admin_headers", code: 401 });
  }

  const ts  = parseInt(tsStr, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TS_SKEW_S) {
    res.set("X-Admin-Status", "expired");
    return res.status(401).json({ error: "timestamp_out_of_range", code: 401, skew_s: TS_SKEW_S });
  }

  const secret = keys.get(keyId);
  if (!secret) {
    res.set("X-Admin-Status", "unknown_key");
    return res.status(401).json({ error: "unknown_key_id", code: 401 });
  }

  const canonical = buildCanonicalString(req);
  const expected  = crypto.createHmac("sha256", secret).update(canonical).digest("hex");

  if (!timingSafeEqualHex(expected, String(sigHex).toLowerCase())) {
    res.set("X-Admin-Status", "invalid_signature");
    return res.status(401).json({ error: "invalid_signature", code: 401 });
  }

  req.adminKeyId = keyId;
  next();
}

// ─── Task 8: auditAdminWrite helper + mass-ban guard middleware ───────────────

function makeAdminGuards({ store, config }) {
  async function auditAdminWrite(req, action, target, outcome, extra = {}) {
    const bodySha = crypto
      .createHash("sha256")
      .update(req.rawBody || Buffer.alloc(0))
      .digest("hex");
    const entry = {
      ts: Math.floor(Date.now() / 1000),
      actor_key_id: req.adminKeyId || null,
      method: req.method,
      path: req.originalUrl ? req.originalUrl.split("?")[0] : req.path,
      body_sha256: bodySha,
      target,
      action_outcome: outcome,
      ...extra,
      request_id: req.id || null,
    };
    if (action) entry.action = action;
    try { await store.pushAuditAdmin(entry); }
    catch (e) { logger.error({ kind: "audit", err: e.message }, "pushAuditAdmin failed"); }
    return entry;
  }

  // Mass-ban guard: 2-tier (per key_id 10/min + global 50/h)
  async function massBanGuard(req, res, next) {
    const keyId = req.adminKeyId;
    const perKeyScope = `rl:massban:keyid:${keyId}`;
    const globalScope = `rl:massban:global`;
    const perKeyMax = config.MASS_BAN_GUARD_PER_KEY_PER_MIN || 10;
    const globalMax = config.MASS_BAN_GUARD_GLOBAL_PER_HOUR || 50;

    let perKey, global;
    try {
      perKey = await store.incrMassBanCounter(perKeyScope, 60);
      global = await store.incrMassBanCounter(globalScope, 3600);
    } catch (e) {
      // Redis down → fail-closed for ban operations (money/enforcement-critical)
      logger.error({ kind: "admin", err: e.message }, "mass-ban guard store error — failing closed");
      await auditAdminWrite(req, "ban", { key: req.body?.key, type: req.body?.type },
        "throttled_mass_ban", { reason: "store_unavailable" });
      return res.status(503).json({ error: "ban_guard_unavailable", code: 503 });
    }
    if (perKey > perKeyMax || global > globalMax) {
      const which = perKey > perKeyMax ? "per_key" : "global";
      await auditAdminWrite(req, "ban", { key: req.body?.key, type: req.body?.type },
        "throttled_mass_ban", { guard: which, perKey, global });
      res.set("Retry-After", "60");
      return res.status(429).json({
        error: "mass_ban_guard_triggered", code: 429,
        guard: which, per_key_count: perKey, global_count: global,
        per_key_max: perKeyMax, global_max: globalMax,
      });
    }
    next();
  }

  return { auditAdminWrite, massBanGuard };
}

module.exports = {
  parseAdminKeys, _resetAdminKeysForTest, adminConfigured,
  sha256Hex,
  captureRawBody, buildCanonicalString, sortQueryString,
  corsAdminLockdown, verifyAdminAuth, timingSafeEqualHex,
  makeAdminGuards,
};
