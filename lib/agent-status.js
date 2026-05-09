"use strict";

/**
 * lib/agent-status.js
 *
 * Phase 4 — Task 4
 *
 * Exports:
 *   buildAgentStatus(store, pubkey, opts) → Promise<StatusSnapshot>
 *     Pure read-only snapshot builder. Pulls from store + enforcement; never
 *     mutates any state. Safe to call from any context (handler, test, CLI).
 *
 *   makeAgentStatusHandler({ store, config, computeFraudFlagsForPubkey })
 *     → Express async handler with 10 s response cache and per-IP rate-limit
 *       plumbing (sliding-window queries surfaced in the JSON body).
 *
 * Cache: Redis STRING / in-memory Map-with-expiry via store.cacheGet / cacheSet.
 * If those methods are absent the handler degrades gracefully (cache miss every
 * time, no error propagated to the client).
 */

const { checkBan, inWhitelistWindow } = require("./enforcement");
const { getTrustMultiplier, getTrustBand } = require("./trust-multipliers");
const { logger } = require("./logger");

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CACHE_TTL_MS = 10_000;

const ONE_DAY_MS    = 24 * 60 * 60 * 1000;
const FIVE_MIN_MS   = 5  * 60 * 1000;
const SEVEN_DAYS_MS = 7  * ONE_DAY_MS;

/**
 * Build a status snapshot for `pubkey`.
 *
 * @param {object} store  — Phase-0 store (getReputation, getAbuseHistory,
 *                          getBan, isPermanent, slidingWindowQuery)
 * @param {string} pubkey — base-58 Solana public key (caller must validate)
 * @param {object} [opts]
 * @param {Function} [opts.computeFraudFlags]  — async (pubkey) → string[]
 * @param {object}  [opts.config]              — { RATE_IP_LIMIT, RATE_PUBKEY_LIMIT,
 *                                                 RATE_GLOBAL_LIMIT }
 * @param {string}  [opts.ip]                  — requesting IP (for rate-window query)
 * @returns {Promise<object>}
 */
async function buildAgentStatus(store, pubkey, opts) {
  if (opts === undefined) opts = {};
  const computeFraudFlags = typeof opts.computeFraudFlags === "function"
    ? opts.computeFraudFlags
    : async () => [];
  const config = opts.config || {};
  const ip = opts.ip || "unknown";
  const now = Date.now();

  // ── Parallel fetch of all read-only data ──────────────────────────────────
  const [rec, abuseHist, ban, isPerm, fraud] = await Promise.all([
    store.getReputation(pubkey).catch(() => null),
    store.getAbuseHistory(pubkey, 100).catch(() => []),
    checkBan(store, `pk:${pubkey}`).catch(() => null),
    store.isPermanent(`pk:${pubkey}`).catch(() => false),
    computeFraudFlags(pubkey).catch(() => []),
  ]);

  // ── Trust-Score / band / multiplier ──────────────────────────────────────
  const trust_score      = rec ? Math.min(100, rec.paidCount * 5) : 0;
  const trust_multiplier = getTrustMultiplier(trust_score);
  const trust_band       = getTrustBand(trust_score);

  // ── Abuse-history counters ────────────────────────────────────────────────
  const throttles_5m  = abuseHist.filter(h => h.kind === "throttle"  && now - h.ts <= FIVE_MIN_MS  ).length;
  const soft_bans_24h = abuseHist.filter(h => h.kind === "soft_ban"  && now - h.ts <= ONE_DAY_MS   ).length;
  const hard_bans_7d  = abuseHist.filter(h => h.kind === "hard_ban"  && now - h.ts <= SEVEN_DAYS_MS).length;

  // ── Sliding-window rate-limit queries (read-only) ─────────────────────────
  const RATE_IP_LIMIT     = config.RATE_IP_LIMIT     || 0;
  const RATE_PUBKEY_LIMIT = config.RATE_PUBKEY_LIMIT || 0;
  const RATE_GLOBAL_LIMIT = config.RATE_GLOBAL_LIMIT || 0;

  const useSlidingQuery = typeof store.slidingWindowQuery === "function";

  const [ipQ, pkQ, glQ] = useSlidingQuery
    ? await Promise.all([
        store.slidingWindowQuery(`rl:rpc:ip:${ip}`,     RATE_IP_LIMIT,     60_000).catch(() => ({ remaining: null })),
        store.slidingWindowQuery(`rl:rpc:pk:${pubkey}`, RATE_PUBKEY_LIMIT, 60_000).catch(() => ({ remaining: null })),
        store.slidingWindowQuery(`rl:global`,           RATE_GLOBAL_LIMIT, 60_000).catch(() => ({ remaining: null })),
      ])
    : [{ remaining: null }, { remaining: null }, { remaining: null }];

  // ── Whitelist window ──────────────────────────────────────────────────────
  const whitelist_window = await inWhitelistWindow(store, pubkey).catch(() => false);

  return {
    pubkey,
    trust_score,
    trust_band,
    trust_multiplier,
    current_tier:   ban  ? ban.tier  : 0,
    throttles_5m,
    soft_bans_24h,
    hard_bans_7d,
    fraud_flags:    Array.isArray(fraud) ? fraud : [],
    rate_limit_remaining: {
      ip:     ipQ.remaining,
      pubkey: pkQ.remaining,
      global: glQ.remaining,
    },
    rate_limit_reset_seconds: 60,   // sliding-window approximation
    permanent:        !!isPerm,
    whitelist_window,
    since:            rec ? (rec.firstPaidAt || null) : null,
    until_epoch:      (ban && ban.until) ? Math.floor(ban.until / 1000) : null,
    abuse_history_count: abuseHist.length,
  };
}

/**
 * Express handler factory with 10 s response cache.
 *
 * @param {{ store, config, computeFraudFlagsForPubkey }} deps
 * @returns {Function} Express async (req, res) handler
 */
function makeAgentStatusHandler({ store, config, computeFraudFlagsForPubkey }) {
  return async function agentStatusHandler(req, res) {
    const pubkey = String(req.query.pubkey || "").trim();
    if (!PUBKEY_RE.test(pubkey)) {
      return res.status(400).json({ error: "invalid_pubkey", code: 400 });
    }

    const cacheKey = `cache:agent-status:${pubkey}`;

    // Try cache first — store.cacheGet / cacheSet are optional thin wrappers.
    if (typeof store.cacheGet === "function") {
      try {
        const cached = await store.cacheGet(cacheKey);
        if (cached) {
          return res.set("X-x402-Cache", "hit").json(JSON.parse(cached));
        }
      } catch (e) {
        logger.debug({ kind: "agent-status", err: e.message }, "cache read failed (degraded)");
      }
    }

    const ip = req.ip || req.socket?.remoteAddress || "unknown";

    const out = await buildAgentStatus(store, pubkey, {
      computeFraudFlags: computeFraudFlagsForPubkey,
      config,
      ip,
    });

    // Cache best-effort (10 s)
    if (typeof store.cacheSet === "function") {
      try { await store.cacheSet(cacheKey, JSON.stringify(out), CACHE_TTL_MS); } catch {}
    }

    res.set("X-x402-Cache", "miss").json(out);
  };
}

module.exports = { buildAgentStatus, makeAgentStatusHandler, PUBKEY_RE, CACHE_TTL_MS };
