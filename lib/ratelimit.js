"use strict";

const counters = {
  total: 0,
  blocks: { global: 0, ip: 0, pubkey: 0, paid: 0 },
  byRoute: {},
};

let memberCtr = 0;
function nextMemberId() {
  return `${Date.now()}:${++memberCtr}:${process.pid}`;
}

function getTrustMultiplier(score) {
  const s = Number(score) || 0;
  if (s <= 20) return 1;
  if (s <= 50) return 2;
  if (s <= 80) return 5;
  return 10;
}

function bumpBlock(routeName, dimension) {
  counters.total++;
  counters.blocks[dimension] = (counters.blocks[dimension] || 0) + 1;
  const r = counters.byRoute[routeName] = counters.byRoute[routeName] || { global: 0, ip: 0, pubkey: 0, paid: 0 };
  r[dimension] = (r[dimension] || 0) + 1;
}

function getRateLimitCounters() {
  return JSON.parse(JSON.stringify(counters));
}

function resetCountersForTest() {
  counters.total = 0;
  counters.blocks = { global: 0, ip: 0, pubkey: 0, paid: 0 };
  counters.byRoute = {};
}

function createRateLimitMiddleware(spec, deps) {
  const { store, logger } = deps;
  if (!store || !logger) throw new Error("ratelimit: store and logger required");
  const route = spec.routeName || "unknown";

  return async function rateLimitMiddleware(req, res, next) {
    if (process.env.RATELIMIT_ENABLED === "false") return next();

    if (typeof store.isStoreHealthy === "function" && !(await store.isStoreHealthy())) {
      res.setHeader("X-x402-Ratelimit-Degraded", "local");
      return next();
    }

    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || "0.0.0.0";
    const pubkey = req.x402Verified?.pubkey || null;

    const plan = [];
    if (spec.global) {
      plan.push({ dim: "global", key: spec.global.key, max: spec.global.max, windowMs: spec.global.windowMs });
    }
    if (spec.ip) {
      plan.push({ dim: "ip", key: `${spec.ip.keyPrefix}:${ip}`, max: spec.ip.max, windowMs: spec.ip.windowMs });
    }
    if (spec.pubkey && pubkey) {
      plan.push({ dim: "pubkey", key: `${spec.pubkey.keyPrefix}:${pubkey}`, max: spec.pubkey.max, windowMs: spec.pubkey.windowMs });
    }
    if (spec.paid && pubkey && req.x402Verified) {
      let multiplier = 1;
      try {
        const rep = await store.getReputation(pubkey);
        const score = rep ? Math.min(100, rep.paidCount * 5) : 0;
        multiplier = getTrustMultiplier(score);
      } catch (err) {
        logger.warn({ err: err.message, pubkey, route }, "ratelimit: trust lookup failed; defaulting to 1×");
      }
      plan.push({
        dim: "paid",
        key: `${spec.paid.keyPrefix}:${pubkey}`,
        max: spec.paid.baseMax * multiplier,
        windowMs: spec.paid.windowMs,
      });
    }

    for (const b of plan) {
      const memberId = nextMemberId();
      let result;
      try {
        result = await store.slidingWindowConsume(b.key, b.max, b.windowMs, now, memberId);
      } catch (err) {
        logger.warn({ err: err.message, bucket: b.key, route }, "ratelimit: store error; degrading open");
        res.setHeader("X-x402-Ratelimit-Degraded", "local");
        return next();
      }
      // Memory backend returns {ok, count}; ensure consistent shape
      const ok = result.ok;
      const count = result.count;
      if (!ok) {
        bumpBlock(route, b.dim);
        // Wire to global request counter for Phase 4 prom export
        try {
          require("./metrics-counters").bumpReqCounter(`/${route}`, "shield_ratelimit", "throttled");
        } catch {}
        logger.warn({ ip, pubkey, route, dim: b.dim, bucket: b.key, count, max: b.max }, "ratelimit: blocked");
        // When enforcement bridge is wired (enforceOnBlock=true), expose state
        // on req and call next() so the downstream rlEnforce middleware handles
        // the response with proper tier escalation headers.
        if (spec.enforceOnBlock) {
          req.rateLimitState = {
            dimension: b.dim,
            key: b.key,
            count,
            max: b.max,
            exceeded: true,
            remaining: 0,
            windowMs: b.windowMs,
          };
          return next();
        }
        const retryAfterSec = Math.max(1, Math.ceil(b.windowMs / 1000));
        const reason = `${b.dim}-rate-limit`;
        res.set({
          "Retry-After": String(retryAfterSec),
          "X-x402-Reason": reason,
          "Content-Type": "application/json",
        });
        return res.status(429).json({
          error: "rate_limited",
          code: 429,
          reason,
          dimension: b.dim,
          route,
          retry_after_seconds: retryAfterSec,
          limit: b.max,
          window_seconds: Math.ceil(b.windowMs / 1000),
        });
      }
      // Approaching threshold — set warning state for downstream middleware
      if (spec.enforceOnBlock) {
        const remaining = Math.max(0, b.max - count);
        const usage = b.max > 0 ? count / b.max : 0;
        if (usage >= 0.8) {
          req.rateLimitState = {
            dimension: b.dim,
            key: b.key,
            count,
            max: b.max,
            exceeded: false,
            remaining,
            windowMs: b.windowMs,
          };
        }
      }
    }

    return next();
  };
}

module.exports = {
  createRateLimitMiddleware,
  getRateLimitCounters,
  getTrustMultiplier,
  resetCountersForTest,
};
