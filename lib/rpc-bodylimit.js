"use strict";

/**
 * Content-Length-only body limit for /rpc. NEVER consumes the request body
 * stream — http-proxy-middleware downstream still pipes it intact to Solana
 * (per ENGINEERING.md D-003).
 */
function rpcBodyLimit(maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("rpcBodyLimit: maxBytes required");
  }

  return function rpcBodyLimitMiddleware(req, res, next) {
    if (req.method === "OPTIONS") return next();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return res.status(405).json({
        error: "method_not_allowed",
        code: 405,
        allowed: ["POST", "OPTIONS"],
      });
    }

    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      return res.status(415).json({
        error: "unsupported_media_type",
        code: 415,
        expected: "application/json",
      });
    }

    const len = req.headers["content-length"];
    if (len === undefined || len === null || len === "") {
      return res.status(411).json({ error: "length_required", code: 411 });
    }
    const n = parseInt(len, 10);
    if (!Number.isFinite(n) || n < 0 || String(n) !== String(len).trim()) {
      return res.status(400).json({ error: "invalid_content_length", code: 400 });
    }
    if (n > maxBytes) {
      return res.status(413).json({
        error: "body_too_large",
        code: 413,
        limit: maxBytes,
      });
    }

    return next();
  };
}

module.exports = { rpcBodyLimit };
