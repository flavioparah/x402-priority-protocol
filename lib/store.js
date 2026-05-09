/**
 * lib/store.js
 *
 * Pluggable persistence layer for the x402-shield. The four pieces of
 * critical state — escrow balances, nonces, reputation, used deposit
 * signatures — live behind a uniform async API so they can be swapped
 * between in-memory (dev / single-instance MVP) and Redis (production,
 * multi-instance, restart-safe).
 *
 *   In-memory:  state lives in JS Maps/Sets. Lost on restart.
 *   Redis:      state lives in Redis primitives (HASH / STRING + TTL /
 *               SET / ZSET). Survives restart, shared across multiple
 *               shield instances. Activated by REDIS_URL env var.
 *
 * Note: this iteration migrates the four CRITICAL state maps. Transient
 * state (request timestamps, IP rate counters, QoS queue, stats ring
 * buffers) stays in-memory because they're either too high-write-rate
 * for Redis to be worth it (request timestamps) or genuinely local-only
 * (QoS queue per instance). Multi-instance coordination of the QoS
 * queue is a later sprint.
 *
 * PHASE 4 RETROACTIVE — `slidingWindowQuery` and
 * `incrMassBanCounter`/`getMassBanCounter` were added during Phase 4
 * because they were not surfaced in Phase 0's migration brief. Logically
 * belong with Phase 0 primitives; placement-only deviation.
 *
 * `slidingWindowQuery` contract: "non-mutating" means consulting
 * query.count does NOT consume a slot (no ZADD / no arr.push). In the
 * Redis path ZREMRANGEBYSCORE is still called to garbage-collect expired
 * members — that side-effect is harmless and expected.
 */

const REDIS_URL = process.env.REDIS_URL || "";
const NONCE_TTL_MS = 30_000;

// ─── In-memory implementation ────────────────────────────────────────────────

function createInMemoryStore() {
  const escrow = new Map();           // pubkey → microLamports
  const nonces = new Map();           // nonce → {amount, destination, expiresAt, used, hintedPubkey}
  const reputation = new Map();       // pubkey → {paidCount, firstPaidAt, lastPaidAt, totalPaid}
  const usedSigs = new Set();         // tx_signature → present
  const attestations = new Map();     // pubkey → [{ts, amount, operator_id}, ...] (max 100)
  const ratelimitBuckets = new Map();  // bucketKey → Array<{ts, member}>
  const pendingDeposits = new Map();   // sig → { requestId, expiresAt }
  const knownBadDeposits = new Map();  // sig → expiresAt
  const abuseHistory = new Map();      // key → Array<{ ttlExpiresAt, payload }>
  const bans = new Map();             // key → { tier, reason, untilEpochMs }
  const permanentBans = new Set();    // permanently-banned keys
  const permanentReasons = new Map(); // key → reason (last add reason)
  // Dashboard rolling windows + cumulative counters (persisted in Redis backend).
  const paymentLog = [];              // [{ts, pubkey, amount, score}, ...] head-first, max 100
  const challengeLog = [];            // [{ts, pubkeyHint, basePrice, finalPrice, load}, ...] head-first, max 100
  const loadHistory = [];             // [{ts, load, rps}, ...] head-first, max 60
  let paymentsTotal = 0;
  let challengesTotal = 0;
  const qosTotals = {
    dispatched_total: 0,
    bypassed_total: 0,
    rejected_overflow_total: 0,
    rejected_timeout_total: 0,
  };
  const adminAuditLog = [];   // [{ts, ...payload}, ...] head-first, max 1000
  let paymentVolumeTotal = 0;
  const memoryHealthy = true;
  const massBanCounters = new Map(); // scope → { count, expiresAt }

  setInterval(() => {
    const now = Date.now();
    for (const [n, data] of nonces) {
      if (data.expiresAt < now) nonces.delete(n);
    }
    for (const [sig, data] of pendingDeposits) {
      if (data.expiresAt < now) pendingDeposits.delete(sig);
    }
    for (const [sig, exp] of knownBadDeposits) {
      if (exp < now) knownBadDeposits.delete(sig);
    }
    for (const [k, b] of bans) {
      if (b.untilEpochMs < now) bans.delete(k);
    }
  }, NONCE_TTL_MS).unref();

  return {
    backend: "memory",
    async ping() { return "PONG"; },
    async close() { /* no-op */ },

    // Escrow
    async getEscrow(pubkey) { return escrow.get(pubkey) || 0; },
    async setEscrow(pubkey, amount) { escrow.set(pubkey, amount); },
    async incrEscrow(pubkey, delta) {
      const curr = escrow.get(pubkey) || 0;
      const next = curr + delta;
      escrow.set(pubkey, next);
      return next;
    },
    async escrowAccountCount() { return escrow.size; },

    // Nonces
    async setNonce(nonce, data, ttlMs) {
      nonces.set(nonce, { ...data, expiresAt: Date.now() + ttlMs });
    },
    async getNonce(nonce) { return nonces.get(nonce) || null; },
    async markNonceUsed(nonce) {
      const n = nonces.get(nonce);
      if (n) n.used = true;
    },
    async deleteNonce(nonce) { nonces.delete(nonce); },
    async nonceCount() { return nonces.size; },

    // Reputation
    async getReputation(pubkey) {
      return reputation.get(pubkey) || null;
    },
    async recordPayment(pubkey, amount) {
      const now = Date.now();
      const rec = reputation.get(pubkey) || { paidCount: 0, firstPaidAt: now, lastPaidAt: now, totalPaid: 0 };
      rec.paidCount += 1;
      rec.lastPaidAt = now;
      rec.totalPaid += amount;
      reputation.set(pubkey, rec);
      return rec;
    },
    async getLeaderboard(n) {
      return [...reputation.entries()]
        .map(([pubkey, rec]) => ({ pubkey, ...rec }))
        .sort((a, b) => b.paidCount - a.paidCount)
        .slice(0, n);
    },
    async getTotalPaidVolume() {
      if (paymentVolumeTotal > 0) return paymentVolumeTotal;
      let total = 0;
      for (const r of reputation.values()) total += r.totalPaid;
      return total;
    },
    async uniquePayingPubkeys() { return reputation.size; },

    // Deposit signatures (anti-double-spend)
    async hasSignature(sig) { return usedSigs.has(sig); },
    async addSignature(sig) { usedSigs.add(sig); },

    // Atomic: validate nonce + amount + hintedPubkey + balance, then mark
    // nonce used and debit escrow. JS is single-threaded within one tick, so
    // as long as no `await` interleaves the check-and-set, the operation is
    // race-free (this whole function returns synchronously to the same tick).
    async consumeNonceAndDebit(nonce, pubkey, amountClaimed) {
      const n = nonces.get(nonce);
      if (!n) return { ok: false, reason: "nonce_not_found", balance: 0 };
      if (n.used) return { ok: false, reason: "nonce_already_used", balance: 0 };
      if (Date.now() > n.expiresAt) return { ok: false, reason: "nonce_expired", balance: 0 };
      if (amountClaimed < n.amount) return { ok: false, reason: "insufficient_payment", balance: 0 };
      if (n.hintedPubkey && n.hintedPubkey !== pubkey) {
        return { ok: false, reason: "pubkey_hint_mismatch", balance: 0 };
      }
      const balance = escrow.get(pubkey) || 0;
      if (balance < amountClaimed) return { ok: false, reason: "insufficient_balance", balance };
      // Atomic mark + debit
      n.used = true;
      const newBalance = balance - amountClaimed;
      escrow.set(pubkey, newBalance);
      return { ok: true, reason: "ok", balance: newBalance };
    },

    // Per-pubkey attestation log (for sybil/fraud detection)
    async pushAttestation(pubkey, event) {
      let log = attestations.get(pubkey);
      if (!log) { log = []; attestations.set(pubkey, log); }
      log.unshift(event);
      if (log.length > 100) log.length = 100;
    },
    async getAttestations(pubkey, n = 100) {
      return (attestations.get(pubkey) || []).slice(0, n);
    },

    // ─── Dashboard stats (rolling windows + cumulative counters) ───────
    // The Redis backend persists these so /stats/recent and /stats/qos
    // survive container restart. The in-memory backend stores them in JS
    // arrays — lost on restart, which is fine for dev.

    async pushPayment(event) {
      paymentLog.unshift(event);
      if (paymentLog.length > 100) paymentLog.length = 100;
      paymentsTotal++;
    },
    async getRecentPayments(n = 20) {
      return paymentLog.slice(0, n);
    },
    async getPaymentsTotal() {
      return paymentsTotal;
    },

    async pushChallenge(event) {
      challengeLog.unshift(event);
      if (challengeLog.length > 100) challengeLog.length = 100;
      challengesTotal++;
    },
    async getRecentChallenges(n = 20) {
      return challengeLog.slice(0, n);
    },
    async getChallengesTotal() {
      return challengesTotal;
    },

    async pushLoadSample(sample) {
      loadHistory.unshift(sample);
      if (loadHistory.length > 60) loadHistory.length = 60;
    },
    async getLoadHistory(n = 30) {
      // Return chronological order (oldest first) so charts render left→right
      return loadHistory.slice(0, n).reverse();
    },

    async incrQosStat(name, delta = 1) {
      if (!(name in qosTotals)) return 0;
      qosTotals[name] += delta;
      return qosTotals[name];
    },
    async getQosStats() {
      return { ...qosTotals };
    },

    async pushAuditAdmin(entry) {
      adminAuditLog.unshift(entry);
      if (adminAuditLog.length > 1000) adminAuditLog.length = 1000;
    },
    async getAuditAdmin(limit, sinceTs = 0) {
      const out = [];
      for (const e of adminAuditLog) {
        if (e.ts < sinceTs) break;
        out.push(e);
        if (out.length >= limit) break;
      }
      return out;
    },
    async incrPaymentVolume(microLamports) {
      paymentVolumeTotal += microLamports;
      return paymentVolumeTotal;
    },
    async isStoreHealthy() {
      return memoryHealthy;
    },

    async slidingWindowConsume(bucketKey, max, windowMs, now, memberId) {
      let arr = ratelimitBuckets.get(bucketKey);
      if (!arr) { arr = []; ratelimitBuckets.set(bucketKey, arr); }
      const cutoff = now - windowMs;
      let i = 0;
      while (i < arr.length && arr[i].ts <= cutoff) i++;
      if (i > 0) arr.splice(0, i);
      if (arr.length >= max) {
        return { ok: false, count: arr.length };
      }
      if (!arr.some((e) => e.member === memberId)) {
        arr.push({ ts: now, member: memberId });
      }
      return { ok: true, count: arr.length };
    },

    // Read-only sliding window count — does NOT insert a new member.
    // ZREMRANGEBYSCORE-equivalent pruning is skipped to stay truly non-mutating.
    async slidingWindowQuery(bucketKey, max, windowMs) {
      const now = Date.now();
      const bucket = ratelimitBuckets.get(bucketKey) || [];
      const cutoff = now - windowMs;
      let count = 0;
      for (const entry of bucket) if (entry.ts > cutoff) count++;
      return { count, remaining: Math.max(0, max - count), windowMs };
    },

    // Mass-ban guard counters — scoped sliding counters that let callers
    // pre-check whether a batch-ban operation exceeds a safe rate.
    // massBanCounters: scope → { count, expiresAt }
    async incrMassBanCounter(scope, ttlSec) {
      const now = Date.now();
      const entry = massBanCounters.get(scope);
      if (!entry || entry.expiresAt <= now) {
        massBanCounters.set(scope, { count: 1, expiresAt: now + ttlSec * 1000 });
        return 1;
      }
      entry.count++;
      return entry.count;
    },
    async getMassBanCounter(scope) {
      const now = Date.now();
      const entry = massBanCounters.get(scope);
      if (!entry || entry.expiresAt <= now) return 0;
      return entry.count;
    },

    // Pending deposit lock (anti-concurrent-flood per sig)
    async claimPendingDeposit(sig, requestId, ttlMs) {
      const now = Date.now();
      const existing = pendingDeposits.get(sig);
      if (existing && existing.expiresAt > now) {
        return { ok: false };
      }
      pendingDeposits.set(sig, { requestId, expiresAt: now + ttlMs });
      return { ok: true };
    },
    async clearPendingDeposit(sig) {
      pendingDeposits.delete(sig);
    },
    async pendingDepositPttl(sig) {
      const entry = pendingDeposits.get(sig);
      if (!entry) return 0;
      const remaining = entry.expiresAt - Date.now();
      return remaining > 0 ? remaining : 0;
    },

    // Known-bad deposit cache (avoid re-hitting Solana for known-rejected sigs)
    async markDepositKnownBad(sig, ttlMs) {
      knownBadDeposits.set(sig, Date.now() + ttlMs);
    },
    async isDepositKnownBad(sig) {
      const exp = knownBadDeposits.get(sig);
      if (!exp) return false;
      if (exp < Date.now()) {
        knownBadDeposits.delete(sig);
        return false;
      }
      return true;
    },

    // Abuse history — head-first (newest first), capped at 100, TTL per entry
    async pushAbuseHistory(key, event, ttlMs) {
      let arr = abuseHistory.get(key);
      if (!arr) { arr = []; abuseHistory.set(key, arr); }
      arr.unshift({ payload: event, ttlExpiresAt: Date.now() + ttlMs });
      if (arr.length > 100) arr.length = 100;
    },
    async getAbuseHistory(key, n) {
      const arr = abuseHistory.get(key);
      if (!arr) return [];
      const now = Date.now();
      let i = 0;
      while (i < arr.length) {
        if (arr[i].ttlExpiresAt < now) arr.splice(i, 1);
        else i++;
      }
      if (arr.length === 0) abuseHistory.delete(key);
      return arr.slice(0, n).map((e) => e.payload);
    },

    // Ban tiers — TTL-bound (Tier 2/3)
    async setBan(key, tier, reason, ttlMs) {
      bans.set(key, { tier, reason, untilEpochMs: Date.now() + ttlMs });
    },
    async getBan(key) {
      const b = bans.get(key);
      if (!b) return null;
      if (b.untilEpochMs < Date.now()) {
        bans.delete(key);
        return null;
      }
      return { tier: b.tier, reason: b.reason, untilEpochMs: b.untilEpochMs };
    },
    async clearBan(key) {
      bans.delete(key);
    },

    // Permanent bans — no TTL, SET membership for O(1) check (Tier 4)
    async addPermanent(key, reason) {
      permanentBans.add(key);
      permanentReasons.set(key, reason);
    },
    async isPermanent(key) {
      return permanentBans.has(key);
    },
    async removePermanent(key, _reason) {
      permanentBans.delete(key);
      permanentReasons.delete(key);
    },
  };
}

// ─── Redis implementation ────────────────────────────────────────────────────

function createRedisStore(url) {
  const Redis = require("ioredis");
  const r = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    enableReadyCheck: true,
    lazyConnect: false,
  });

  const _storeLogger = require("./logger").logger.child({ kind: "store" });
  let redisHealthy = false;
  r.on("connect", () => {
    redisHealthy = true;
    _storeLogger.info({
      reason: "redis_connected",
      url: url.replace(/:\/\/.*@/, "://[redacted]@"),
    });
  });
  r.on("ready", () => { redisHealthy = true; });
  r.on("error", (err) => {
    redisHealthy = false;
    _storeLogger.error({ reason: "redis_error", error: err.message });
  });
  r.on("close", () => { redisHealthy = false; });
  r.on("end", () => { redisHealthy = false; });

  // Atomic check-and-set: validate nonce + amount + hintedPubkey + balance,
  // mark nonce used (preserving TTL), and debit escrow — all in one
  // server-side Lua execution. Two concurrent callers with the same
  // signed-nonce pair: exactly one returns ok=1, the other gets
  // nonce_already_used.
  //
  // KEYS[1] = nonce key, KEYS[2] = escrow hash key
  // ARGV[1] = pubkey, ARGV[2] = amount claimed
  // Returns: {ok, reason, balance}
  r.defineCommand("consumeNonceAndDebit", {
    numberOfKeys: 2,
    lua: `
      local nonceRaw = redis.call('GET', KEYS[1])
      if not nonceRaw then return {0, 'nonce_not_found', 0} end
      local nonceData = cjson.decode(nonceRaw)
      if nonceData.used then return {0, 'nonce_already_used', 0} end
      local amount = tonumber(ARGV[2])
      if amount < tonumber(nonceData.amount) then return {0, 'insufficient_payment', 0} end
      if nonceData.hintedPubkey and nonceData.hintedPubkey ~= ARGV[1] then
        return {0, 'pubkey_hint_mismatch', 0}
      end
      local rawBalance = redis.call('HGET', KEYS[2], ARGV[1])
      local balance = tonumber(rawBalance) or 0
      if balance < amount then return {0, 'insufficient_balance', balance} end
      nonceData.used = true
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl < 1 then ttl = 1 end
      redis.call('SET', KEYS[1], cjson.encode(nonceData), 'PX', ttl)
      local newBalance = redis.call('HINCRBY', KEYS[2], ARGV[1], -amount)
      return {1, 'ok', newBalance}
    `,
  });

  r.defineCommand("slidingWindowConsume", {
    numberOfKeys: 1,
    lua: `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[3]) - tonumber(ARGV[2]))
      local count = redis.call('ZCARD', KEYS[1])
      if count >= tonumber(ARGV[1]) then return {0, count} end
      redis.call('ZADD', KEYS[1], tonumber(ARGV[3]), ARGV[4])
      redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
      return {1, count + 1}
    `,
  });

  // Read-only sliding window count.
  // KEYS[1]=bucket; ARGV[1]=max; ARGV[2]=windowMs; ARGV[3]=now
  // ZREMRANGEBYSCORE prunes expired members (harmless — does not insert).
  r.defineCommand("slidingWindowQuery", {
    numberOfKeys: 1,
    lua: `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[3]) - tonumber(ARGV[2]))
      local count = redis.call('ZCARD', KEYS[1])
      return {count}
    `,
  });

  // Keys layout (prefixed for safety in case Redis is shared):
  const K = {
    escrow: "x402:escrow",                  // HASH pubkey → microLamports (string)
    nonce: (n) => `x402:nonce:${n}`,        // STRING JSON {amount, destination, used, hintedPubkey}, TTL set
    nonceCount: "x402:nonce-count",         // STRING approximate counter (INCR/DECR; cosmetic for /health)
    reputation: (pk) => `x402:reputation:${pk}`,  // HASH paidCount, firstPaidAt, lastPaidAt, totalPaid
    reputationIndex: "x402:reputation:index",     // ZSET pubkey → paidCount (for leaderboard)
    sigs: "x402:deposit-sigs",              // SET of used tx_signatures
    // Dashboard rolling windows (LPUSH + LTRIM keeps newest N at head)
    payments: "x402:stats:payments",        // LIST max 100 (most recent 20 read by /stats/recent)
    challenges: "x402:stats:challenges",    // LIST max 100
    loadHistory: "x402:stats:load-history", // LIST max 60
    counters: "x402:stats:counters",        // HASH {payments_total, challenges_total} — INCR-only
    qosTotals: "x402:stats:qos-totals",     // HASH {dispatched_total, bypassed_total, rejected_*}
    depositPending: (sig) => `x402:deposit:pending:${sig}`,
    depositKnownBad: (sig) => `x402:deposit:knownbad:${sig}`,
    abuse: (key) => `x402:abuse:history:${key}`,
    ban: (key) => `x402:ban:${key}`,
    permanent: "x402:ban:permanent",
    permanentReason: (key) => `x402:ban:permanent:reason:${key}`,
    auditAdmin: "x402:audit:admin:log",
    massBan: (scope) => `x402:massban:counter:${scope}`,
  };

  return {
    backend: "redis",
    async ping() { return r.ping(); },
    async close() { return r.quit(); },

    // Escrow — HSET / HGET / HINCRBY are atomic
    async getEscrow(pubkey) {
      const v = await r.hget(K.escrow, pubkey);
      return v ? parseInt(v, 10) : 0;
    },
    async setEscrow(pubkey, amount) {
      await r.hset(K.escrow, pubkey, String(amount));
    },
    async incrEscrow(pubkey, delta) {
      const next = await r.hincrby(K.escrow, pubkey, delta);
      return next;
    },
    async escrowAccountCount() {
      return r.hlen(K.escrow);
    },

    // Nonces — STRING with TTL handles expiry server-side
    async setNonce(nonce, data, ttlMs) {
      const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
      const payload = JSON.stringify({
        amount: data.amount,
        destination: data.destination,
        used: data.used,
        hintedPubkey: data.hintedPubkey,
      });
      await r.set(K.nonce(nonce), payload, "EX", ttlSec);
      // Approximate count (Redis SCAN would be expensive on hot path)
      await r.incr(K.nonceCount).catch(() => {});
    },
    async getNonce(nonce) {
      const raw = await r.get(K.nonce(nonce));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Reconstruct the in-memory shape (expiresAt re-derived from TTL)
      const ttl = await r.pttl(K.nonce(nonce));
      return { ...parsed, expiresAt: Date.now() + (ttl > 0 ? ttl : 0) };
    },
    async markNonceUsed(nonce) {
      const raw = await r.get(K.nonce(nonce));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      parsed.used = true;
      const ttl = await r.pttl(K.nonce(nonce));
      if (ttl > 0) await r.set(K.nonce(nonce), JSON.stringify(parsed), "PX", ttl);
    },
    async deleteNonce(nonce) {
      await r.del(K.nonce(nonce));
      await r.decr(K.nonceCount).catch(() => {});
    },
    async nonceCount() {
      const v = await r.get(K.nonceCount);
      return Math.max(0, v ? parseInt(v, 10) : 0);
    },

    // Reputation — HASH per pubkey + ZSET index for leaderboard
    async getReputation(pubkey) {
      const h = await r.hgetall(K.reputation(pubkey));
      if (!h || Object.keys(h).length === 0) return null;
      return {
        paidCount: parseInt(h.paidCount || "0", 10),
        firstPaidAt: parseInt(h.firstPaidAt || "0", 10),
        lastPaidAt: parseInt(h.lastPaidAt || "0", 10),
        totalPaid: parseInt(h.totalPaid || "0", 10),
      };
    },
    async recordPayment(pubkey, amount) {
      const now = Date.now();
      const key = K.reputation(pubkey);
      // Pipeline for atomicity-ish (not a transaction, but no other writer
      // races on these specific fields under our single-process semantics).
      const pipeline = r.pipeline();
      pipeline.hincrby(key, "paidCount", 1);
      pipeline.hincrby(key, "totalPaid", amount);
      pipeline.hset(key, "lastPaidAt", String(now));
      pipeline.hsetnx(key, "firstPaidAt", String(now));
      const results = await pipeline.exec();
      const newPaidCount = parseInt(results[0][1], 10);
      // Update leaderboard index
      await r.zadd(K.reputationIndex, newPaidCount, pubkey);
      return {
        paidCount: newPaidCount,
        firstPaidAt: now,  // approximate (HSETNX may have kept older value, but close enough for return)
        lastPaidAt: now,
        totalPaid: parseInt(results[1][1], 10),
      };
    },
    async getLeaderboard(n) {
      // ZREVRANGE returns [member, score, member, score, ...] when WITHSCORES
      const items = await r.zrevrange(K.reputationIndex, 0, n - 1, "WITHSCORES");
      const out = [];
      for (let i = 0; i < items.length; i += 2) {
        const pubkey = items[i];
        const rec = await r.hgetall(K.reputation(pubkey));
        if (!rec || Object.keys(rec).length === 0) continue;
        out.push({
          pubkey,
          paidCount: parseInt(rec.paidCount || "0", 10),
          firstPaidAt: parseInt(rec.firstPaidAt || "0", 10),
          lastPaidAt: parseInt(rec.lastPaidAt || "0", 10),
          totalPaid: parseInt(rec.totalPaid || "0", 10),
        });
      }
      return out;
    },
    async getTotalPaidVolume() {
      const v = await r.hget(K.counters, "payments_micro_lamports_total");
      if (v) return parseInt(v, 10);
      const all = await r.zrange(K.reputationIndex, 0, -1);
      let total = 0;
      for (const pubkey of all) {
        const tp = await r.hget(K.reputation(pubkey), "totalPaid");
        if (tp) total += parseInt(tp, 10);
      }
      if (total > 0) {
        await r.hset(K.counters, "payments_micro_lamports_total", String(total));
      }
      return total;
    },
    async uniquePayingPubkeys() {
      return r.zcard(K.reputationIndex);
    },

    // Deposit signatures
    async hasSignature(sig) {
      return (await r.sismember(K.sigs, sig)) === 1;
    },
    async addSignature(sig) {
      await r.sadd(K.sigs, sig);
    },

    // Atomic consume — see Lua script registered in createRedisStore() above.
    async consumeNonceAndDebit(nonce, pubkey, amountClaimed) {
      const result = await r.consumeNonceAndDebit(
        K.nonce(nonce),
        K.escrow,
        pubkey,
        String(amountClaimed)
      );
      // ioredis returns numbers as strings sometimes; normalize
      const ok = parseInt(result[0], 10) === 1;
      const reason = String(result[1]);
      const balance = parseInt(result[2], 10) || 0;
      return { ok, reason, balance };
    },

    async slidingWindowConsume(bucketKey, max, windowMs, now, memberId) {
      const result = await r.slidingWindowConsume(
        bucketKey,
        String(max),
        String(windowMs),
        String(now),
        String(memberId)
      );
      const ok = parseInt(result[0], 10) === 1;
      const count = parseInt(result[1], 10);
      return { ok, count };
    },

    // Read-only sliding window count — does NOT consume a slot.
    async slidingWindowQuery(bucketKey, max, windowMs) {
      const now = Date.now();
      const result = await r.slidingWindowQuery(
        bucketKey,
        String(max),
        String(windowMs),
        String(now)
      );
      const count = parseInt(result[0], 10);
      return { count, remaining: Math.max(0, max - count), windowMs };
    },

    // Mass-ban guard counters — scoped rate counters for admin batch-ban ops.
    async incrMassBanCounter(scope, ttlSec) {
      const next = await r.incr(K.massBan(scope));
      if (next === 1) await r.expire(K.massBan(scope), ttlSec);
      return next;
    },
    async getMassBanCounter(scope) {
      const v = await r.get(K.massBan(scope));
      return v ? parseInt(v, 10) : 0;
    },

    // Per-pubkey attestation log (for sybil/fraud detection).
    // LPUSH + LTRIM keeps only the last 100 events per pubkey.
    async pushAttestation(pubkey, event) {
      const key = `x402:attestations:${pubkey}`;
      await r.lpush(key, JSON.stringify(event));
      await r.ltrim(key, 0, 99);
    },
    async getAttestations(pubkey, n = 100) {
      const key = `x402:attestations:${pubkey}`;
      const items = await r.lrange(key, 0, n - 1);
      return items.map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean);
    },

    // ─── Dashboard stats (rolling windows + cumulative counters) ───────
    // LPUSH puts newest at head, LTRIM(0, N-1) keeps only the first N
    // (i.e., most recent N). Counters use HINCRBY for atomicity.

    async pushPayment(event) {
      const pipeline = r.pipeline();
      pipeline.lpush(K.payments, JSON.stringify(event));
      pipeline.ltrim(K.payments, 0, 99);
      pipeline.hincrby(K.counters, "payments_total", 1);
      await pipeline.exec();
    },
    async getRecentPayments(n = 20) {
      const items = await r.lrange(K.payments, 0, n - 1);
      return items.map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean);
    },
    async getPaymentsTotal() {
      const v = await r.hget(K.counters, "payments_total");
      return v ? parseInt(v, 10) : 0;
    },

    async pushChallenge(event) {
      const pipeline = r.pipeline();
      pipeline.lpush(K.challenges, JSON.stringify(event));
      pipeline.ltrim(K.challenges, 0, 99);
      pipeline.hincrby(K.counters, "challenges_total", 1);
      await pipeline.exec();
    },
    async getRecentChallenges(n = 20) {
      const items = await r.lrange(K.challenges, 0, n - 1);
      return items.map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean);
    },
    async getChallengesTotal() {
      const v = await r.hget(K.counters, "challenges_total");
      return v ? parseInt(v, 10) : 0;
    },

    async pushLoadSample(sample) {
      await r.lpush(K.loadHistory, JSON.stringify(sample));
      await r.ltrim(K.loadHistory, 0, 59);
    },
    async getLoadHistory(n = 30) {
      // LRANGE 0 to N-1 returns newest first; reverse so charts render left→right
      const items = await r.lrange(K.loadHistory, 0, n - 1);
      return items.map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean).reverse();
    },

    async incrQosStat(name, delta = 1) {
      // Whitelist to avoid accidental key pollution
      const valid = ["dispatched_total", "bypassed_total", "rejected_overflow_total", "rejected_timeout_total"];
      if (!valid.includes(name)) return 0;
      return r.hincrby(K.qosTotals, name, delta);
    },
    async getQosStats() {
      const h = await r.hgetall(K.qosTotals);
      return {
        dispatched_total: parseInt(h.dispatched_total || "0", 10),
        bypassed_total: parseInt(h.bypassed_total || "0", 10),
        rejected_overflow_total: parseInt(h.rejected_overflow_total || "0", 10),
        rejected_timeout_total: parseInt(h.rejected_timeout_total || "0", 10),
      };
    },

    async pushAuditAdmin(entry) {
      const pipeline = r.pipeline();
      pipeline.lpush(K.auditAdmin, JSON.stringify(entry));
      pipeline.ltrim(K.auditAdmin, 0, 4999);
      await pipeline.exec();
    },
    async getAuditAdmin(limit, sinceTs = 0) {
      const items = await r.lrange(K.auditAdmin, 0, limit - 1);
      const out = [];
      for (const s of items) {
        let e;
        try { e = JSON.parse(s); } catch { continue; }
        if (e.ts < sinceTs) break;
        out.push(e);
      }
      return out;
    },
    async incrPaymentVolume(microLamports) {
      return r.hincrby(K.counters, "payments_micro_lamports_total", microLamports);
    },
    async isStoreHealthy() {
      return redisHealthy;
    },

    // Pending deposit lock — SET NX PX for atomic claim (§7.3)
    async claimPendingDeposit(sig, requestId, ttlMs) {
      const result = await r.set(K.depositPending(sig), requestId, "PX", ttlMs, "NX");
      return { ok: result === "OK" };
    },
    async clearPendingDeposit(sig) {
      await r.del(K.depositPending(sig));
    },
    async pendingDepositPttl(sig) {
      const ttl = await r.pttl(K.depositPending(sig));
      return ttl > 0 ? ttl : 0;
    },

    // Known-bad deposit cache
    async markDepositKnownBad(sig, ttlMs) {
      await r.set(K.depositKnownBad(sig), "1", "PX", ttlMs);
    },
    async isDepositKnownBad(sig) {
      return (await r.exists(K.depositKnownBad(sig))) === 1;
    },

    // Abuse history — LPUSH + LTRIM 0..99 + PEXPIRE (TTL trails most-recent push)
    async pushAbuseHistory(key, event, ttlMs) {
      const k = K.abuse(key);
      const pipeline = r.pipeline();
      pipeline.lpush(k, JSON.stringify(event));
      pipeline.ltrim(k, 0, 99);
      pipeline.pexpire(k, ttlMs);
      await pipeline.exec();
    },
    async getAbuseHistory(key, n) {
      const items = await r.lrange(K.abuse(key), 0, n - 1);
      return items.map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean);
    },

    // Ban tiers — TTL-bound (Tier 2/3)
    async setBan(key, tier, reason, ttlMs) {
      await r.set(K.ban(key), JSON.stringify({ tier, reason }), "PX", ttlMs);
    },
    async getBan(key) {
      const [raw, ttl] = await Promise.all([r.get(K.ban(key)), r.pttl(K.ban(key))]);
      if (!raw || ttl <= 0) return null;
      try {
        const parsed = JSON.parse(raw);
        return { tier: parsed.tier, reason: parsed.reason, untilEpochMs: Date.now() + ttl };
      } catch {
        return null;
      }
    },
    async clearBan(key) {
      await r.del(K.ban(key));
    },

    // Permanent bans — no TTL, SET membership for O(1) check (Tier 4)
    async addPermanent(key, reason) {
      const pipeline = r.pipeline();
      pipeline.sadd(K.permanent, key);
      pipeline.set(K.permanentReason(key), String(reason || ""));
      await pipeline.exec();
    },
    async isPermanent(key) {
      return (await r.sismember(K.permanent, key)) === 1;
    },
    async removePermanent(key, _reason) {
      const pipeline = r.pipeline();
      pipeline.srem(K.permanent, key);
      pipeline.del(K.permanentReason(key));
      await pipeline.exec();
    },
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

function createStore(opts = {}) {
  if (opts.forceMemory) return createInMemoryStore();
  const url = opts.url || REDIS_URL;
  const _storeLogger = require("./logger").logger.child({ kind: "store" });
  if (url) {
    _storeLogger.info({
      reason: "store_backend_redis",
      url: url.replace(/:\/\/.*@/, "://[redacted]@"),
    });
    return createRedisStore(url);
  }
  _storeLogger.info({ reason: "store_backend_memory" });
  return createInMemoryStore();
}

module.exports = { createStore };
