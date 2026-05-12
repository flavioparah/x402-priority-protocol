"use strict";
/**
 * lib/ratelimit-enforcement.js
 *
 * Bridge between the Phase-2 rate-limit middleware and the Phase-3 enforcement
 * ladder. Reads `req.rateLimitState`:
 *
 *   - exceeded:false, count/max < 0.8 : next() (no headers added)
 *   - exceeded:false, count/max >= 0.8 : tier-0 warning headers + next()
 *   - exceeded:true                    : recordOffense + enforcementResponse (429)
 */

const { recordOffense, enforcementResponse, TIERS } = require("./enforcement");
const { REASONS } = require("./abuse-reasons");
const { getActiveFraudFlags } = require("./detection");

const WARN_THRESHOLD = 0.8;

/**
 * Returns an async Express middleware that bridges rate-limit state to the
 * enforcement ladder.
 *
 * @param {object} opts
 * @param {object} opts.store                     — store with abuse history + ban methods
 * @param {Function} [opts.reasonForDimension]    — (dimension) => REASONS.*
 * @param {Function} [opts.keyFromReq]            — (req, state) => string key
 * @param {Function} [opts.trustScoreFromReq]     — async (req) => number 0..100
 * @param {Function} [opts.pubkeyFirstPaidAtFromReq] — async (req) => epoch ms | undefined
 */
function wrapRateLimitWithEnforcement(opts) {
  const {
    store,
    reasonForDimension = () => REASONS.IP_RATE_LIMIT,
    keyFromReq,
    trustScoreFromReq,
    pubkeyFirstPaidAtFromReq,
  } = opts;

  return async function rlEnforce(req, res, next) {
    const state = req.rateLimitState;
    if (!state) return next();
    const usage = state.max > 0 ? state.count / state.max : 0;
    const reason = reasonForDimension(state.dimension);
    const key = keyFromReq ? keyFromReq(req, state) : state.key;

    // Below warn threshold → silent pass
    if (!state.exceeded && usage < WARN_THRESHOLD) return next();

    // Warn tier — set headers but still call next()
    if (!state.exceeded && usage >= WARN_THRESHOLD) {
      enforcementResponse(res, {
        tier: TIERS.WARNING,
        reason,
        remaining: state.remaining,
        windowSeconds: state.windowMs ? Math.ceil(state.windowMs / 1000) : undefined,
        limit: state.max,
      });
      return next();
    }

    // Exceeded — escalate via recordOffense
    const trustScore = trustScoreFromReq ? await trustScoreFromReq(req) : 0;
    let fraudSignals = [];
    if (state.dimension === "pubkey") {
      try {
        const pk = key && key.startsWith("pk:") ? key.slice(3) : key;
        const [rep, attestations] = await Promise.all([
          store.getReputation ? store.getReputation(pk) : null,
          store.getAttestations ? store.getAttestations(pk, 100) : [],
        ]);
        fraudSignals = getActiveFraudFlags(pk, attestations || [], rep);
      } catch { /* best-effort */ }
    }
    const pubkeyFirstPaidAt = pubkeyFirstPaidAtFromReq
      ? await pubkeyFirstPaidAtFromReq(req)
      : undefined;

    const result = await recordOffense(store, key, reason, {
      trustScore,
      fraudSignals,
      pubkeyFirstPaidAt,
    });
    enforcementResponse(res, {
      tier: result.tier,
      reason: result.reason,
      until: result.until,
      limit: state.max,
      windowSeconds: state.windowMs ? Math.ceil(state.windowMs / 1000) : undefined,
      remaining: 0,
      yourScore: trustScore,
      historySummary: result.history_summary,
    });
  };
}

module.exports = { wrapRateLimitWithEnforcement, WARN_THRESHOLD };
