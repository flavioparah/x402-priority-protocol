"use strict";

const PUBLIC_READONLY_PREFIXES = [
  "/info", "/health",
  "/stats/", "/reputation/", "/escrow/balance/",
  "/agent/code-of-conduct",
];
const PROXIED_PREFIXES = ["/rpc"];
const PROTECTED_PREFIXES = ["/escrow/deposit", "/admin/"];

const COMMON_HEADERS = "Content-Type, Authorization, X-x402-Agent-Pubkey, X-Admin-Key-Id, X-Admin-Timestamp, X-Admin-Auth, If-None-Match";
const EXPOSE_HEADERS = "X-x402-Status, X-x402-Payment-Destination, X-x402-Amount, X-x402-Amount-Base, X-x402-Trust-Score, X-x402-Nonce, X-x402-Nonce-TTL, X-x402-Reason, X-x402-Tier, X-x402-Until, X-x402-Trust-Impact, X-x402-Ratelimit-Degraded, ETag, Retry-After";

function categoryOf(path) {
  if (PUBLIC_READONLY_PREFIXES.some((p) => path.startsWith(p))) return "public";
  if (PROXIED_PREFIXES.some((p) => path.startsWith(p))) return "proxied";
  if (PROTECTED_PREFIXES.some((p) => path.startsWith(p))) return "protected";
  return "default";
}

function corsForRoute(allowlist) {
  return function corsMiddleware(req, res, next) {
    const cat = categoryOf(req.path);
    const origin = req.headers.origin;

    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", COMMON_HEADERS);
    res.setHeader("Access-Control-Expose-Headers", EXPOSE_HEADERS);

    if (cat === "public" || cat === "proxied") {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (cat === "protected") {
      if (origin && allowlist.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
      }
    }

    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}

module.exports = { corsForRoute, categoryOf };
