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

  setInterval(() => {
    const now = Date.now();
    for (const [n, data] of nonces) {
      if (data.expiresAt < now) nonces.delete(n);
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

  r.on("connect", () => console.log(`[store] Redis connected (${url.replace(/:\/\/.*@/, "://[redacted]@")})`));
  r.on("error", (err) => console.error(`[store] Redis error: ${err.message}`));

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

  // Keys layout (prefixed for safety in case Redis is shared):
  const K = {
    escrow: "x402:escrow",                  // HASH pubkey → microLamports (string)
    nonce: (n) => `x402:nonce:${n}`,        // STRING JSON {amount, destination, used, hintedPubkey}, TTL set
    nonceCount: "x402:nonce-count",         // STRING approximate counter (INCR/DECR; cosmetic for /health)
    reputation: (pk) => `x402:reputation:${pk}`,  // HASH paidCount, firstPaidAt, lastPaidAt, totalPaid
    reputationIndex: "x402:reputation:index",     // ZSET pubkey → paidCount (for leaderboard)
    sigs: "x402:deposit-sigs",              // SET of used tx_signatures
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
      // Best-effort scan; for production, maintain a running counter on every recordPayment
      const all = await r.zrange(K.reputationIndex, 0, -1);
      let total = 0;
      for (const pubkey of all) {
        const v = await r.hget(K.reputation(pubkey), "totalPaid");
        if (v) total += parseInt(v, 10);
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
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

function createStore() {
  if (REDIS_URL) {
    console.log(`[store] backend: redis (${REDIS_URL.replace(/:\/\/.*@/, "://[redacted]@")})`);
    return createRedisStore(REDIS_URL);
  }
  console.log(`[store] backend: in-memory (REDIS_URL not set; state is volatile)`);
  return createInMemoryStore();
}

module.exports = { createStore };
