/**
 * x402-Shield — Proxy/Middleware para nós RPC Solana
 * Emite desafios HTTP 402 sob carga, valida provas de pagamento
 * e encaminha requisições legítimas ao RPC real.
 *
 * MVP: usa assinatura Ed25519 off-chain contra saldo pré-depositado.
 */

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const http = require("http");
const https = require("https");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const crypto = require("crypto");
const { Connection, PublicKey, SystemProgram } = require("@solana/web3.js");
const { logger, sampledWarn } = require("./lib/logger");
const preflight = require("./lib/preflight");
const { createRateLimitMiddleware } = require("./lib/ratelimit");
const { rpcBodyLimit } = require("./lib/rpc-bodylimit");
const { fireSolanaCircuit } = require("./lib/solana-circuit");
const { SIG_RE } = require("./lib/preflight");
const { corsForRoute } = require("./lib/cors-scoped");
const { bumpReqCounter } = require("./lib/metrics-counters");

// ─── Phase 3 enforcement integration ─────────────────────────────────────────
const enforcement = require("./lib/enforcement-public");
const { REASONS } = enforcement;

// ─── Configuração ────────────────────────────────────────────────────────────

const CONFIG = {
  PORT: process.env.PORT || 3000,
  REAL_RPC_URL: process.env.REAL_RPC_URL || "https://api.mainnet-beta.solana.com",
  PAYMENT_DESTINATION: process.env.PAYMENT_DESTINATION || "YourSolAddressHere",

  // Limites de carga — ajuste conforme o hardware do nó
  RPC_LOAD_THRESHOLD: parseFloat(process.env.RPC_LOAD_THRESHOLD || "0.75"),
  REQUESTS_PER_IP_LIMIT: parseInt(process.env.REQUESTS_PER_IP_LIMIT || "100"),
  RATE_WINDOW_MS: parseInt(process.env.RATE_WINDOW_MS || "60000"),
  RATE_IP_LIMIT: parseInt(process.env.RATE_IP_LIMIT || "100"),
  RATE_PUBKEY_LIMIT: parseInt(process.env.RATE_PUBKEY_LIMIT || "200"),
  RATE_PAID_PUBKEY_BASE: parseInt(process.env.RATE_PAID_PUBKEY_BASE || "200"),
  RATE_GLOBAL_LIMIT: parseInt(process.env.RATE_GLOBAL_LIMIT || "5000"),

  // Preço dinâmico (micro-lamports) — escala com a carga
  // Defaults Cenário 20×: 20 lamports (BASE) → 1000 lamports (MAX saturado)
  BASE_PRICE_MICRO_LAMPORTS: parseInt(process.env.BASE_PRICE || "20000"),
  MAX_PRICE_MICRO_LAMPORTS: parseInt(process.env.MAX_PRICE || "1000000"),

  // Real load metric: requests per second we consider "full load" (load = 1.0).
  // The Shield tracks its own req/s over LOAD_WINDOW_MS and scales linearly.
  MAX_RPS: parseInt(process.env.MAX_RPS || "50"),
  LOAD_WINDOW_MS: parseInt(process.env.LOAD_WINDOW_MS || "5000"),

  // Demo override: RPC_LOAD_FORCE=0.9 forces getRpcLoad() to return 0.9
  // regardless of actual traffic. For recording the pitch video where we
  // want reliable 402s without generating synthetic load first.
  RPC_LOAD_FORCE: process.env.RPC_LOAD_FORCE ? parseFloat(process.env.RPC_LOAD_FORCE) : null,

  // Nonces expiram em 30s para evitar replay attacks
  NONCE_TTL_MS: 30_000,

  // On-chain settlement: the RPC the Shield uses to VERIFY user deposits.
  // Defaults to REAL_RPC_URL (same network the Shield proxies to). Override
  // if deposits settle on a different network than the proxied RPC.
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || process.env.REAL_RPC_URL || "https://api.mainnet-beta.solana.com",

  // Confirmation commitment for deposit verification. "confirmed" is fast
  // (~1 s on mainnet), "finalized" is safer (~13 s) but slower.
  DEPOSIT_COMMITMENT: process.env.DEPOSIT_COMMITMENT || "confirmed",

  // DEMO-ONLY backdoor: mounts /escrow/deposit-trusted which credits escrow
  // based on the caller's claim, without on-chain verification. Exists so
  // tests and benchmarks don't need to transact on Solana. Off by default.
  TRUST_DEPOSITS: process.env.ESCROW_TRUST_DEPOSITS === "1" || process.env.ESCROW_TRUST_DEPOSITS === "true",

  // Operator identity used to tag attestations for cross-operator detection
  // (sybil/fraud signals in lib/detection.js). Defaults to "self" — when a
  // 2nd operator joins the broker, each sets a unique OPERATOR_ID and
  // distinctOperators(attestations).size >= 2 unlocks cross-op signals.
  OPERATOR_ID: process.env.OPERATOR_ID || "self",

  // ─── QoS Path A: standalone priority queue + rate-limited dispatcher ────────
  // Independent of operator adoption (cooperative QoS lives in a separate
  // header-based protocol; see docs/TRUST-SCORE-RFC-DRAFT.md companion spec).
  //
  // Behavior:
  //   - Below QOS_BYPASS_THRESHOLD utilization: fast-path, no queueing.
  //   - Above threshold: requests inserted in a priority queue, ordered by
  //     `effectiveScore = (verifiedAmount + verifiedTrustScore * 100) + ageMs/50`.
  //     Aging boost prevents starvation of low-priority requests under sustained load.
  //   - Cap on concurrent in-flight upstream requests prevents saturating the node.
  //   - Backpressure: queue length > QOS_MAX_QUEUE_DEPTH → 503; per-request
  //     waiting > QOS_QUEUE_TIMEOUT_MS → 504.
  QOS_MAX_INFLIGHT: parseInt(process.env.QOS_MAX_INFLIGHT || "100"),
  QOS_MAX_QUEUE_DEPTH: parseInt(process.env.QOS_MAX_QUEUE_DEPTH || "1000"),
  QOS_QUEUE_TIMEOUT_MS: parseInt(process.env.QOS_QUEUE_TIMEOUT_MS || "10000"),
  QOS_BYPASS_THRESHOLD: parseFloat(process.env.QOS_BYPASS_THRESHOLD || "0.5"),
  QOS_MODE: process.env.QOS_MODE || "standalone",  // "standalone" | "cooperative" | "off"
  // Phase 0 — boot guards & admin wiring (spec §10.8, §12)
  NETWORK: process.env.NETWORK || "",
  REDIS_REQUIRED:
    typeof process.env.REDIS_REQUIRED === "string"
      ? /^(true|1|yes)$/i.test(process.env.REDIS_REQUIRED)
      : (() => {
          const mn =
            String(process.env.NETWORK || "").toLowerCase() === "mainnet" ||
            (process.env.REAL_RPC_URL || "").includes("mainnet-beta");
          return mn;
        })(),
  REDIS_REQUIRED_TIMEOUT_MS: parseInt(
    process.env.TEST_REDIS_REQUIRED_TIMEOUT_MS || "30000",
    10
  ),
  BODY_LIMIT_RPC_BYTES: parseInt(process.env.BODY_LIMIT_RPC_BYTES || "32768"),
  DEPOSIT_PENDING_TTL_MS: parseInt(process.env.DEPOSIT_PENDING_TTL_MS || "15000"),
  DEPOSIT_NEGATIVE_CACHE_TTL_MS: parseInt(process.env.DEPOSIT_NEGATIVE_CACHE_TTL_MS || "60000"),
  SOLANA_CIRCUIT_THRESHOLD_PCT: parseInt(process.env.SOLANA_CIRCUIT_THRESHOLD_PCT || "50"),
  SOLANA_CIRCUIT_RESET_MS: parseInt(process.env.SOLANA_CIRCUIT_RESET_MS || "30000"),
  SOLANA_CIRCUIT_TIMEOUT_MS: parseInt(process.env.SOLANA_CIRCUIT_TIMEOUT_MS || "15000"),
  ADMIN_ORIGIN_ALLOWLIST: (process.env.ADMIN_ORIGIN_ALLOWLIST || "https://api.rpcpriority.com,https://ops.rpcpriority.com").split(",").map(s => s.trim()).filter(Boolean),
  PROTECTED_ORIGIN_ALLOWLIST: (process.env.PROTECTED_ORIGIN_ALLOWLIST || "https://rpcpriority.com,https://api.rpcpriority.com").split(",").map(s => s.trim()).filter(Boolean),
};

// Graceful shutdown state — flipped by SIGTERM/SIGINT (spec §10.5).
let shuttingDown = false;

// ─── Persistence layer ────────────────────────────────────────────────────────
// The four critical state pieces (escrow, nonces, reputation, deposit
// signatures) live in a Store abstraction. In-memory by default; switches
// to Redis when REDIS_URL is set. See lib/store.js for both implementations.
const { createStore } = require("./lib/store");
const store = createStore();

// Sybil / fraud / churn detection over the per-pubkey attestation log.
// Signals are computed lazily at /reputation/:pubkey query time.
const { computeRisk } = require("./lib/detection");

// ─── Phase 4 agent modules ────────────────────────────────────────────────────
const { getCodeOfConduct } = require("./lib/code-of-conduct");
const { makeAgentStatusHandler } = require("./lib/agent-status");
const { getActiveFraudFlags } = require("./lib/detection");
const { config: runtimeConfig, getConfig, applyUpdate } = require("./lib/config");
const { makeMetricsHandler, incAdminAction } = require("./lib/metrics");

/**
 * Lazily-initialized Solana Connection used to verify deposit transactions.
 * Reuses a single instance so getTransaction() calls share a keep-alive
 * connection to the configured SOLANA_RPC_URL.
 */
let solanaConnection = null;
function getSolanaConnection() {
  if (!solanaConnection) {
    solanaConnection = new Connection(CONFIG.SOLANA_RPC_URL, CONFIG.DEPOSIT_COMMITMENT);
  }
  return solanaConnection;
}

/**
 * µL = lamports × 1000 by our internal convention. A 1-lamport transfer
 * credits 1000 µL of escrow. This lets us price fine-grained (µ-lamports)
 * without requiring non-integer on-chain values.
 */
const MICRO_LAMPORTS_PER_LAMPORT = 1000;

// Trust-Score ledger lives in `store` (see lib/store.js). The discount a
// scored agent receives on a 402 challenge is applied BEFORE the client
// signs, so the signed amount matches the discounted price. We then require
// the signer's pubkey to equal the hinted pubkey (set via the
// X-x402-Agent-Pubkey request header) — otherwise Alice could claim Bob's
// score, get his price, then sign with her own key.

// ─── Funções auxiliares ───────────────────────────────────────────────────────

/**
 * Sliding-window load metric.
 *
 * Each incoming /rpc request pushes a timestamp. getRpcLoad() drops expired
 * entries and returns requests-per-second over LOAD_WINDOW_MS, normalized
 * against MAX_RPS.
 *
 * This is an honest *self-load* measurement — it reflects how busy the
 * Shield itself is, which is correlated with but not identical to the
 * upstream RPC node's load. For a multi-Shield / Redis-shared deployment,
 * this would need a distributed counter (or a Prometheus scrape of the
 * actual node). Good enough for a single-process MVP.
 *
 * @type {number[]} timestamps of recent requests
 */
const requestTimestamps = [];

/**
 * Dashboard stats are now persisted in the store backend (LIST + HASH in Redis,
 * arrays in MemoryStore). See lib/store.js: pushPayment, pushChallenge,
 * pushLoadSample, incrQosStat. Only wait_samples (rolling 200 ms latencies for
 * percentile calculation) stays in-memory — purely transient.
 */

// ─── QoS Path A — standalone priority queue + dispatcher ──────────────────────
// Each entry: { req, res, next, score, enqueuedAt, timeoutId }
/** @type {Array<{req:any, res:any, next:Function, score:number, enqueuedAt:number, timeoutId:any}>} */
const qosQueue = [];
let qosInFlight = 0;
// In-memory rolling window of last 200 wait times. Used only for p50/p95/p99
// computation in /stats/qos. Counters (dispatched/bypassed/rejected_*) are
// persisted via store.incrQosStat — survive restart.
const qosWaitSamples = [];

// Cooperative QoS — when the operator returns X-QoS-Overload:1, we fall back
// to standalone queueing for 30 seconds (per QOS-COOPERATIVE-SPEC.md §5).
let qosOverloadFallbackUntil = 0;

// Cooperative QoS health probe state (QOS-COOPERATIVE-SPEC.md §5.3-5.4).
// During cooperative mode we periodically OPTIONS the operator's /qos-status
// endpoint. If unreachable for >60s we force fallback. After 3 consecutive
// successes during a fallback window, we end the fallback early and resume
// cooperative mode immediately.
let qosCoopHealthConsecutiveSuccesses = 0;
let qosCoopHealthLastSuccessAt = 0;
let qosCoopHealthFailingSince = null;     // null = currently healthy
let qosCoopHealthLastError = null;
let qosCoopHealthChecks = { ok: 0, fail: 0 };
const QOS_HEALTH_INTERVAL_MS = 30_000;
const QOS_HEALTH_UNREACHABLE_MS = 60_000;
const QOS_HEALTH_REPROBE_REQUIRED = 3;

function qosBaseScore(req) {
  // Score from the verified payment if present; fallback 0 (free pass — back of queue).
  const v = req.x402Verified;
  if (!v) return 0;
  return (v.amount || 0) + (v.score || 0) * 100;
}

function qosEffectiveScore(entry) {
  // Aging boost: +1 every 50ms. Prevents starvation of older entries under sustained pressure.
  return entry.score + (Date.now() - entry.enqueuedAt) / 50;
}

function qosOnSlotFree() {
  // Pop highest-effective-score entry (linear scan; queue is small).
  while (qosInFlight < CONFIG.QOS_MAX_INFLIGHT && qosQueue.length > 0) {
    let bestIdx = 0;
    let bestScore = qosEffectiveScore(qosQueue[0]);
    for (let i = 1; i < qosQueue.length; i++) {
      const s = qosEffectiveScore(qosQueue[i]);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    const entry = qosQueue.splice(bestIdx, 1)[0];
    if (entry.timeoutId) clearTimeout(entry.timeoutId);

    const waitMs = Date.now() - entry.enqueuedAt;
    qosWaitSamples.push(waitMs);
    if (qosWaitSamples.length > 200) qosWaitSamples.shift();

    qosInFlight++;
    store.incrQosStat("dispatched_total").catch(() => {});
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      qosInFlight--;
      qosOnSlotFree();
    };
    entry.res.once("finish", release);
    entry.res.once("close", release);
    try { entry.next(); } catch (e) { release(); throw e; }
  }
}

function qosMiddleware(req, res, next) {
  if (CONFIG.QOS_MODE === "off") return next();

  // Cooperative mode: forward priority hint to operator and let their stack
  // do the queueing. Falls back to standalone behavior for 30s after the
  // operator emits X-QoS-Overload:1 (per QOS-COOPERATIVE-SPEC.md §5).
  if (CONFIG.QOS_MODE === "cooperative" && Date.now() >= qosOverloadFallbackUntil) {
    req.headers["x-priority-score"] = String(qosBaseScore(req));
    req.headers["x-qos-spec-version"] = "1";
    return next();
  }
  // If QOS_MODE === "cooperative" AND we're inside the fallback window,
  // fall through to the standalone code path below.

  // Standalone mode: bypass when low contention (preserves the 8.7ms p95).
  if (qosInFlight < CONFIG.QOS_MAX_INFLIGHT * CONFIG.QOS_BYPASS_THRESHOLD) {
    store.incrQosStat("bypassed_total").catch(() => {});
    qosInFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      qosInFlight--;
      qosOnSlotFree();
    };
    res.once("finish", release);
    res.once("close", release);
    return next();
  }

  // High contention: queue with overflow protection.
  if (qosQueue.length >= CONFIG.QOS_MAX_QUEUE_DEPTH) {
    store.incrQosStat("rejected_overflow_total").catch(() => {});
    return res.status(503).json({
      error: "QoS queue full",
      code: 503,
      queue_depth: qosQueue.length,
      retry_after_seconds: 1,
    });
  }

  const entry = {
    req, res, next,
    score: qosBaseScore(req),
    enqueuedAt: Date.now(),
    timeoutId: null,
  };
  qosQueue.push(entry);

  entry.timeoutId = setTimeout(() => {
    const idx = qosQueue.indexOf(entry);
    if (idx >= 0) {
      qosQueue.splice(idx, 1);
      store.incrQosStat("rejected_timeout_total").catch(() => {});
      if (!res.headersSent) {
        res.status(504).json({
          error: "QoS queue timeout",
          code: 504,
          waited_ms: Date.now() - entry.enqueuedAt,
        });
      }
    }
  }, CONFIG.QOS_QUEUE_TIMEOUT_MS);

  // Try to drain immediately (in case there's already capacity).
  qosOnSlotFree();
}

function qosPercentile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

function pruneRequestTimestamps(now = Date.now()) {
  const cutoff = now - CONFIG.LOAD_WINDOW_MS;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }
}

function recordRequest() {
  const now = Date.now();
  pruneRequestTimestamps(now);
  requestTimestamps.push(now);
}

function getRpcLoad() {
  if (CONFIG.RPC_LOAD_FORCE !== null) return CONFIG.RPC_LOAD_FORCE;
  pruneRequestTimestamps();
  const rps = requestTimestamps.length / (CONFIG.LOAD_WINDOW_MS / 1000);
  return Math.min(1, rps / CONFIG.MAX_RPS);
}

/** Calcula o preço dinâmico baseado na carga atual. */
function calcDynamicPrice(load) {
  const ratio = Math.min(1, Math.max(0, (load - CONFIG.RPC_LOAD_THRESHOLD) / (1 - CONFIG.RPC_LOAD_THRESHOLD)));
  return Math.round(CONFIG.BASE_PRICE_MICRO_LAMPORTS + ratio * (CONFIG.MAX_PRICE_MICRO_LAMPORTS - CONFIG.BASE_PRICE_MICRO_LAMPORTS));
}

/** Trust-Score for a pubkey: 0..100, saturating at 20 successful payments. */
async function getTrustScore(pubkeyB58) {
  const rec = await store.getReputation(pubkeyB58);
  if (!rec) return 0;
  return Math.min(100, rec.paidCount * 5);
}

/** Apply the Trust-Score discount to a base price. Score 0..100 → 0..50% off. */
function applyTrustDiscount(price, score) {
  return Math.max(CONFIG.BASE_PRICE_MICRO_LAMPORTS, Math.round(price * (1 - score / 200)));
}

/**
 * Verify a Solana transaction signature credits the Shield's PAYMENT_DESTINATION
 * with at least `minLamports` from a single sender. Returns the crediting
 * pubkey and amount on success, or { ok: false, reason } on failure.
 *
 * The caller supplies only the signature — the Shield fetches the tx from
 * the network, parses it, and verifies all invariants server-side. This is
 * how deposits become trustless: an attacker cannot mint escrow credit
 * without having actually landed a matching on-chain transfer.
 */
async function verifyDepositTx(signature) {
  if (!signature || typeof signature !== "string") {
    return { ok: false, reason: "signature (base58 string) required" };
  }
  if (await store.hasSignature(signature)) {
    return { ok: false, reason: "signature already used for a deposit" };
  }

  // RPC errors propagate so the opossum circuit (lib/solana-circuit.js) can
  // count them toward the failure threshold. Validation failures continue to
  // return { ok: false } below — those don't count toward circuit.
  const tx = await getSolanaConnection().getParsedTransaction(signature, {
    commitment: CONFIG.DEPOSIT_COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    return { ok: false, reason: `transaction not found or not yet ${CONFIG.DEPOSIT_COMMITMENT}` };
  }
  if (tx.meta && tx.meta.err) {
    return { ok: false, reason: `transaction failed on-chain: ${JSON.stringify(tx.meta.err)}` };
  }

  // Find a SystemProgram.transfer whose destination is our PAYMENT_DESTINATION.
  // We accept the first such instruction (a single deposit tx may legitimately
  // contain other non-transfer instructions, e.g. memo).
  const instructions = tx.transaction.message.instructions || [];
  let crediting = null;
  for (const ix of instructions) {
    if (ix.program !== "system") continue;
    if (!ix.parsed || ix.parsed.type !== "transfer") continue;
    const info = ix.parsed.info;
    if (info.destination !== CONFIG.PAYMENT_DESTINATION) continue;
    crediting = { source: info.source, lamports: Number(info.lamports) };
    break;
  }

  if (!crediting) {
    return { ok: false, reason: `no SystemProgram.transfer to ${CONFIG.PAYMENT_DESTINATION} in this tx` };
  }
  if (!crediting.lamports || crediting.lamports <= 0) {
    return { ok: false, reason: `transfer amount is zero or negative` };
  }

  const microLamports = crediting.lamports * MICRO_LAMPORTS_PER_LAMPORT;

  // Mark before mutating state — if we crash mid-update, at least no double credit.
  await store.addSignature(signature);
  const newBalance = await store.incrEscrow(crediting.source, microLamports);

  return {
    ok: true,
    pubkey: crediting.source,
    lamports: crediting.lamports,
    micro_lamports: microLamports,
    balance: newBalance,
    signature,
    slot: tx.slot,
  };
}

/** Record a successful payment against a pubkey's reputation. */
async function recordPayment(pubkeyB58, amount) {
  const updated = await store.recordPayment(pubkeyB58, amount);
  const score = Math.min(100, updated.paidCount * 5);
  const now = Date.now();
  // Persisted dashboard log + cumulative payments_total counter (Redis-backed).
  await store.pushPayment({ ts: now, pubkey: pubkeyB58, amount, score });
  // Per-pubkey attestation log — feeds the sybil/fraud detection engine.
  // Tagged with our operator_id so cross-op signals activate when the broker
  // sees attestations from another operator with a different OPERATOR_ID.
  await store.pushAttestation(pubkeyB58, {
    ts: now,
    amount,
    operator_id: CONFIG.OPERATOR_ID,
  });
}

/**
 * Gera um nonce único e armazena os detalhes do desafio.
 * If a hinted pubkey was used to discount the price, bind the nonce to
 * that pubkey — the signer must match, otherwise the discount would be
 * spoofable (Alice claims Bob's score, pays at Bob's price, signs with
 * her own key; see recordPayment/verify below).
 */
async function issueNonce(amount, hintedPubkey) {
  const nonce = crypto.randomBytes(16).toString("hex");
  await store.setNonce(nonce, {
    amount,
    destination: CONFIG.PAYMENT_DESTINATION,
    used: false,
    hintedPubkey: hintedPubkey || null,
  }, CONFIG.NONCE_TTL_MS);
  return nonce;
}

// Note: nonce expiration is handled by the store (Redis TTL or a sweeper
// interval inside the in-memory implementation). No app-level sweeper here.

// Cooperative QoS health probe — only runs when QOS_MODE=cooperative.
// Implements QOS-COOPERATIVE-SPEC.md §5.3 (60s unreachable → fallback)
// and §5.4 (3 consecutive successes → end fallback early).
if (CONFIG.QOS_MODE === "cooperative") {
  setInterval(async () => {
    const url = CONFIG.REAL_RPC_URL.replace(/\/+$/, "") + "/qos-status";
    let ok = false;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5_000);
      const resp = await fetch(url, { method: "OPTIONS", signal: ctrl.signal });
      clearTimeout(timeout);
      ok = resp.ok || resp.status === 200 || resp.status === 204;
      if (!ok) qosCoopHealthLastError = `HTTP ${resp.status}`;
    } catch (e) {
      qosCoopHealthLastError = e.message || String(e);
    }
    if (ok) {
      qosCoopHealthChecks.ok++;
      qosCoopHealthLastSuccessAt = Date.now();
      qosCoopHealthConsecutiveSuccesses++;
      qosCoopHealthFailingSince = null;
      qosCoopHealthLastError = null;
      // §5.4: 3 consecutive successes during a fallback window → end fallback early
      if (
        qosCoopHealthConsecutiveSuccesses >= QOS_HEALTH_REPROBE_REQUIRED &&
        qosOverloadFallbackUntil > Date.now()
      ) {
        logger.info({ reason: "qos_coop_reprobe_recovered", consecutive_successes: QOS_HEALTH_REPROBE_REQUIRED });
        qosOverloadFallbackUntil = 0;
      }
    } else {
      qosCoopHealthChecks.fail++;
      qosCoopHealthConsecutiveSuccesses = 0;
      if (!qosCoopHealthFailingSince) qosCoopHealthFailingSince = Date.now();
      // §5.3: unreachable for >60s → force fallback
      if (Date.now() - qosCoopHealthFailingSince > QOS_HEALTH_UNREACHABLE_MS) {
        const newUntil = Date.now() + QOS_HEALTH_INTERVAL_MS * 2;
        if (newUntil > qosOverloadFallbackUntil) {
          qosOverloadFallbackUntil = newUntil;
          logger.warn({ reason: "qos_coop_unreachable_force_fallback", unreachable_threshold_ms: QOS_HEALTH_UNREACHABLE_MS, last_error: qosCoopHealthLastError });
        }
      }
    }
  }, QOS_HEALTH_INTERVAL_MS).unref();
}

// Snapshot the current load every 60s so the dashboard can plot a 1h time series.
// Persisted in Redis (rolling 60 samples) so the chart survives container restart.
setInterval(() => {
  pruneRequestTimestamps();
  store.pushLoadSample({
    ts: Date.now(),
    load: parseFloat(getRpcLoad().toFixed(3)),
    rps: parseFloat((requestTimestamps.length / (CONFIG.LOAD_WINDOW_MS / 1000)).toFixed(2)),
  }).catch((e) => logger.error({ reason: "stats_load_sample_failed", error: e.message }));
}, 60_000);

// ─── Verificação de assinatura (MVP off-chain) ────────────────────────────────

/**
 * Valida o cabeçalho Authorization: x402 <payload_base58>
 *
 * payload decodificado = JSON.stringify({ nonce, pubkey, amount, destination })
 * assinado com a chave Ed25519 do agente
 *
 * Formato esperado: "x402 <base58(signature)>.<base58(pubkey)>.<base58(message)>"
 */
async function verifyX402Authorization(authHeader) {
  const pre = preflight.preflightAuth(authHeader);
  if (pre) {
    bumpReqCounter("/rpc", "shield_auth", "blocked");
    return { ok: false, reason: `preflight:${pre}` };
  }

  const token = authHeader.slice(5);
  const parts = token.split(".");

  // Bounded nonce pre-check happens BEFORE bs58.decode of sig/pubkey
  // and BEFORE nacl.sign.detached.verify. Nonce must exist in Redis.
  const np = await preflight.noncePreCheck(parts, store);
  if (!np.ok) {
    bumpReqCounter("/rpc", "shield_auth", "blocked");
    return { ok: false, reason: `preflight:${np.reason}` };
  }

  const { nonce, messageBytes, payload } = np;

  let signature, pubkeyBytes;
  try {
    signature = bs58.decode(parts[0]);
    pubkeyBytes = bs58.decode(parts[1]);
  } catch (err) {
    return { ok: false, reason: `bad_base58_credential: ${err.message}` };
  }

  // Ed25519 verify — authenticates the entire messageBytes, after which
  // payload.pubkey/amount/destination become trustworthy.
  const valid = nacl.sign.detached.verify(messageBytes, signature, pubkeyBytes);
  if (!valid) return { ok: false, reason: "Invalid signature" };

  const { pubkey, amount, destination } = payload;
  const pubkeyB58 = parts[1];
  if (pubkey !== pubkeyB58) return { ok: false, reason: "Pubkey mismatch" };
  if (destination !== CONFIG.PAYMENT_DESTINATION) return { ok: false, reason: "Wrong destination" };

  const consume = await store.consumeNonceAndDebit(nonce, pubkeyB58, amount);
  if (!consume.ok) {
    const friendly = {
      nonce_not_found: "Unknown or expired nonce",
      nonce_already_used: "Nonce already used (replay detected)",
      nonce_expired: "Nonce expired",
      insufficient_payment: `Insufficient payment for nonce`,
      pubkey_hint_mismatch: "Signer pubkey does not match the hinted pubkey for this challenge",
      insufficient_balance: `Insufficient escrow balance: ${consume.balance} < ${amount}`,
    };
    return { ok: false, reason: friendly[consume.reason] || consume.reason };
  }
  await recordPayment(pubkeyB58, amount);
  const score = await getTrustScore(pubkeyB58);
  return { ok: true, pubkey: pubkeyB58, amount, nonce, score };
}

// ─── Middleware principal: x402 Rate Limiter + Challenger ─────────────────────

async function x402Shield(req, res, next) {
  recordRequest();
  const ip = req.ip || req.socket.remoteAddress;
  const load = getRpcLoad();
  const challenged = load > CONFIG.RPC_LOAD_THRESHOLD;

  if (!challenged) return next();

  // Verifica se o agente já enviou uma prova de pagamento válida
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const result = await verifyX402Authorization(authHeader);
    if (result.ok) {
      logger.info({ reason: "x402_payment_accepted", pubkey: result.pubkey, amount: result.amount, nonce: result.nonce, trust: result.score, req_id: req.id });
      req.x402Verified = result;
      return next();
    }
    // Prova inválida — retorna 402 com novo desafio + registra ofensa no ladder
    sampledWarn("x402_invalid_proof", { ip, error: result.reason, req_id: req.id });

    // Section 8.2: wire failure reasons to the enforcement ladder.
    // All calls are fire-and-forget — logged on failure; never block the 402 path.
    if (/pubkey.*hint.*mismatch|pubkey_hint_mismatch/i.test(result.reason)
        || result.reason === "Signer pubkey does not match the hinted pubkey for this challenge") {
      // Offense goes on the pubkey scope (claimed key from token)
      let pk = null;
      try { pk = authHeader.slice(5).split(".")[1]; } catch {}
      if (pk) {
        const score = await getTrustScore(pk).catch(() => 0);
        const rep = await store.getReputation(pk).catch(() => null);
        enforcement.recordOffense(store, `pk:${pk}`, REASONS.PUBKEY_HINT_MISMATCH, {
          trustScore: score,
          pubkeyFirstPaidAt: rep?.firstPaidAt,
        }).catch(err => logger.warn({ err: err.message }, "[enforcement] recordOffense failed"));
      }
    } else if (/Invalid signature|Malformed token|bad_base58|preflight:/i.test(result.reason)) {
      enforcement.recordOffense(store, `ip:${ip}`, REASONS.INVALID_SIGNATURE_BURST, {
        trustScore: 0,
      }).catch(err => logger.warn({ err: err.message }, "[enforcement] recordOffense failed"));
    } else if (/already used|nonce_already_used|nonce-replay/i.test(result.reason)) {
      enforcement.recordOffense(store, `ip:${ip}`, REASONS.NONCE_REPLAY, {
        trustScore: 0,
      }).catch(err => logger.warn({ err: err.message }, "[enforcement] recordOffense failed"));
    }
  }

  // Trust-Score discount: if the agent hints its pubkey (X-x402-Agent-Pubkey),
  // look up its reputation and discount the challenge accordingly. The hint
  // is cosmetic until the signer actually proves ownership in step 2 — see
  // nonceData.hintedPubkey check inside verifyX402Authorization.
  const hintedPubkey = req.headers["x-x402-agent-pubkey"] || null;
  const trustScore = hintedPubkey ? await getTrustScore(hintedPubkey) : 0;
  const basePrice = calcDynamicPrice(load);
  const amount = applyTrustDiscount(basePrice, trustScore);
  const nonce = await issueNonce(amount, hintedPubkey);

  // Persisted dashboard log + cumulative challenges_total counter (Redis-backed).
  await store.pushChallenge({
    ts: Date.now(),
    pubkeyHint: hintedPubkey || null,
    basePrice,
    finalPrice: amount,
    load: parseFloat(load.toFixed(3)),
  });

  logger.info({ reason: "x402_challenge_issued", ip, load: parseFloat(load.toFixed(3)), base_price: basePrice, trust_score: trustScore, final_price: amount, req_id: req.id });

  res.status(402).set({
    "X-x402-Status": "challenged",
    "X-x402-Payment-Destination": CONFIG.PAYMENT_DESTINATION,
    "X-x402-Amount": String(amount),
    "X-x402-Amount-Base": String(basePrice),
    "X-x402-Trust-Score": String(trustScore),
    "X-x402-Nonce": nonce,
    "X-x402-Nonce-TTL": String(CONFIG.NONCE_TTL_MS / 1000),
    "Content-Type": "application/json",
  }).json({
    error: "Payment Required",
    code: 402,
    message: "RPC node under load. Pay priority fee to proceed.",
    payment: {
      destination: CONFIG.PAYMENT_DESTINATION,
      amount_micro_lamports: amount,
      amount_base_micro_lamports: basePrice,
      trust_score: trustScore,
      nonce,
      ttl_seconds: CONFIG.NONCE_TTL_MS / 1000,
      instructions: "Sign the payload and retry with: Authorization: x402 <sig>.<pubkey>.<msg>. Send X-x402-Agent-Pubkey to claim Trust-Score discount.",
    },
  });
}

// ─── Aplicação Express ────────────────────────────────────────────────────────

// CORS — permite que as páginas servidas em rpcpriority.com (nginx separado, IP
// 72.62.136.169) chamem os endpoints /info, /health, /stats/*, /reputation/*
// e /rpc deste shield. As páginas hospedadas pelo próprio shield continuam
// funcionando via mesmo origin (caso onde CORS é no-op).
//
// Importante: expomos os headers X-x402-* na lista Allow-Expose-Headers para
// que o JS do /try consiga ler o desafio 402 a partir de uma fetch cross-origin
// (browsers escondem headers customizados em respostas cross-origin por default).

const app = express();

const helmet = require("helmet");
const cryptoMod = require("crypto");

// Per spec §10.1
app.set("trust proxy", 1);
app.disable("etag");
app.disable("x-powered-by");
app.set("query parser", "simple");

app.use(helmet({
  hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      // Tailwind Play CDN (cdn.tailwindcss.com) é usado pelas páginas /, /live,
      // /explorer, /docs.html. Requer 'unsafe-eval' porque o Tailwind Play
      // CDN compila utilities em runtime via Function(). Em produção real
      // substituir por build local (gera CSS estático e elimina unsafe-eval).
      "script-src":  ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com"],
      "style-src":   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src":    ["'self'", "https://fonts.gstatic.com"],
      "img-src":     ["'self'", "data:", "https:"],
      "connect-src": ["'self'"],
      "frame-ancestors": ["'none'"],
    },
  },
  frameguard: { action: "deny" },
  noSniff: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// Correlation ID — server always generates its own; client-supplied id ignored.
app.use((req, res, next) => {
  req.id = cryptoMod.randomBytes(4).toString("hex");
  res.setHeader("X-Request-ID", req.id);
  next();
});

// CORS middleware — must come BEFORE all routes so preflight OPTIONS resolves
// without falling into the /rpc proxy.
app.use(corsForRoute([
  ...CONFIG.PROTECTED_ORIGIN_ALLOWLIST,
  ...CONFIG.ADMIN_ORIGIN_ALLOWLIST,
]));

// Test-only endpoint for the integration suite. Mounted ONLY when
// ENFORCEMENT_TEST_HOOKS=1 — production deploys never set this.
if (process.env.ENFORCEMENT_TEST_HOOKS === "1") {
  console.warn("[enforcement] ENFORCEMENT_TEST_HOOKS=1 — /__test/ban mounted (DO NOT enable in prod)");
  app.post("/__test/ban", express.json(), async (req, res) => {
    const { key, tier } = req.body || {};
    if (tier === 4) await store.addPermanent(key, { reason: "test", by: "test-hook" });
    else await store.setBan(key, tier, "ip-rate-limit", 300_000);
    res.json({ ok: true });
  });
}

// Pre-flight ban check — runs before any other defense. If the IP or
// (optionally) the pubkey-hint is in a ban tier, respond immediately with
// the appropriate enforcementResponse.
//
// SKIP_BAN_CHECK=1 short-circuits the middleware (test-only knob — atomic
// race tests do replay attacks that legitimately accumulate offenses but
// would then 403 the test's own follow-up requests).
app.use(async (req, res, next) => {
  if (process.env.SKIP_BAN_CHECK === "1") return next();
  const ip = req.ip || req.socket.remoteAddress;
  const ipKey = `ip:${ip}`;

  const ipBan = await enforcement.checkBan(store, ipKey);
  if (ipBan) {
    enforcement.enforcementResponse(res, {
      tier: ipBan.tier,
      reason: enforcement.isKnownReason(ipBan.reason) ? ipBan.reason : "ip-rate-limit",
      until: ipBan.until,
    });
    return;
  }

  const hintedPubkey = req.headers["x-x402-agent-pubkey"];
  if (hintedPubkey) {
    const pkBan = await enforcement.checkBan(store, `pk:${hintedPubkey}`);
    if (pkBan) {
      enforcement.enforcementResponse(res, {
        tier: pkBan.tier,
        reason: enforcement.isKnownReason(pkBan.reason) ? pkBan.reason : "pubkey-rate-limit",
        until: pkBan.until,
      });
      return;
    }
  }
  next();
});

// NB: do NOT mount express.json() globally — it consumes the request body,
// which breaks http-proxy-middleware for /rpc (upstream times out waiting for
// a body that was already parsed and discarded). Apply per-route instead.

// Content negotiation: programmatic clients (SDK, curl with no Accept,
// `Accept: application/json`) get raw JSON. Browsers (Accept includes
// text/html) get a styled HTML page wrapping the same JSON, with a
// "view raw" link. Force JSON from a browser via `?raw=1`.
function respondHtmlOrJson(req, res, data, title) {
  const forceRaw = req.query.raw === "1";
  const accept = String(req.headers.accept || "");
  const wantsHtml = !forceRaw && accept.includes("text/html");
  if (!wantsHtml) return res.json(data);

  const escapeHtml = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const json = escapeHtml(JSON.stringify(data, null, 2));
  // Naive syntax highlight for keys + strings + numbers + booleans/null
  const highlighted = json
    .replace(/("(?:\\.|[^"\\])*")(\s*:)/g, '<span class="k">$1</span>$2')
    .replace(/:\s*("(?:\\.|[^"\\])*")/g, ': <span class="s">$1</span>')
    .replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <span class="n">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="b">$1</span>');

  res.type("html").send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — x402 Priority Gateway</title>
  <link rel="icon" type="image/x-icon" href="https://rpcpriority.com/favicon.ico">
  <meta name="theme-color" content="#14F195">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    body{font-family:'Inter',system-ui;background:#0a0a0a;color:#ededed;margin:0}
    .wrap{max-width:1000px;margin:50px auto;padding:0 22px}
    .crumbs{font-family:'JetBrains Mono',monospace;font-size:13px;opacity:0.55;margin-bottom:8px}
    h1{color:#14F195;font-weight:800;letter-spacing:-0.5px;margin:0 0 4px;font-size:24px}
    .subtitle{font-family:'JetBrains Mono',monospace;font-size:13px;opacity:0.6;margin-bottom:22px}
    a{color:#9945FF;text-decoration:none;border-bottom:1px dotted #9945FF44}
    a:hover{border-bottom-color:#9945FF}
    pre{background:#1a1a1a;padding:18px 22px;border-radius:8px;overflow-x:auto;
        font-family:'JetBrains Mono',monospace;font-size:13.5px;line-height:1.6;
        border:1px solid rgba(255,255,255,0.08);margin:0;white-space:pre-wrap;word-break:break-all}
    .k{color:#9945FF}
    .s{color:#14F195}
    .n{color:#f9a826}
    .b{color:#ff6ec7}
    .meta{margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);
          font-family:'JetBrains Mono',monospace;font-size:12px;opacity:0.55;
          display:flex;gap:18px;flex-wrap:wrap}
  </style>
</head>
<body>
<div class="wrap">
  <div class="crumbs"><a href="/">← gateway home</a></div>
  <h1>${title}</h1>
  <div class="subtitle">${escapeHtml(req.path)}</div>
  <pre>${highlighted}</pre>
  <div class="meta">
    <span>Returned at ${new Date().toISOString()}</span>
    <span><a href="${escapeHtml(req.path)}?raw=1">view raw JSON</a></span>
    <span><a href="/">back to home</a></span>
  </div>
</div>
</body>
</html>`);
}

// ─── Rate-limit middleware (Phase 2, spec §6.3) ───────────────────────────────
const { wrapRateLimitWithEnforcement } = require("./lib/ratelimit-enforcement");

const rl = {
  rpcEdge: createRateLimitMiddleware({
    routeName: "rpc",
    ip:           { keyPrefix: "rl:rpc:ip",   max: CONFIG.RATE_IP_LIMIT,     windowMs: CONFIG.RATE_WINDOW_MS },
    global:       { key:       "rl:global",   max: CONFIG.RATE_GLOBAL_LIMIT, windowMs: CONFIG.RATE_WINDOW_MS },
    enforceOnBlock: true,
  }, { store, logger }),
  rpcAfterAuth: createRateLimitMiddleware({
    routeName: "rpc",
    pubkey:       { keyPrefix: "rl:rpc:pk",   max: CONFIG.RATE_PUBKEY_LIMIT, windowMs: CONFIG.RATE_WINDOW_MS },
    paid:         { keyPrefix: "rl:rpc:paid", baseMax: CONFIG.RATE_PAID_PUBKEY_BASE, windowMs: CONFIG.RATE_WINDOW_MS },
    enforceOnBlock: true,
  }, { store, logger }),
  deposit: createRateLimitMiddleware({
    routeName: "deposit",
    ip: { keyPrefix: "rl:deposit:ip", max: 5, windowMs: CONFIG.RATE_WINDOW_MS },
  }, { store, logger }),
  balance: createRateLimitMiddleware({
    routeName: "balance",
    ip: { keyPrefix: "rl:balance:ip", max: 60, windowMs: CONFIG.RATE_WINDOW_MS },
  }, { store, logger }),
  reputation: createRateLimitMiddleware({
    routeName: "reputation",
    ip: { keyPrefix: "rl:reputation:ip", max: 30, windowMs: CONFIG.RATE_WINDOW_MS },
  }, { store, logger }),
  stats: createRateLimitMiddleware({
    routeName: "stats",
    ip: { keyPrefix: "rl:stats:ip", max: 60, windowMs: CONFIG.RATE_WINDOW_MS },
  }, { store, logger }),
  meta: createRateLimitMiddleware({
    routeName: "meta",
    ip: { keyPrefix: "rl:meta:ip", max: parseInt(process.env.META_IP_LIMIT || "120", 10), windowMs: CONFIG.RATE_WINDOW_MS },
  }, { store, logger }),
};

// Enforcement bridge: reads req.rateLimitState set by rpcEdge / rpcAfterAuth
// (enforceOnBlock:true) and escalates via recordOffense → enforcementResponse.
const rlEnforce = wrapRateLimitWithEnforcement({
  store,
  reasonForDimension: (dim) =>
    dim === "ip"     ? REASONS.IP_RATE_LIMIT :
    dim === "pubkey" ? REASONS.PUBKEY_RATE_LIMIT :
    dim === "global" ? REASONS.GLOBAL_RATE_LIMIT :
                       REASONS.IP_RATE_LIMIT,
  trustScoreFromReq: async (req) => {
    const pk = req.headers["x-x402-agent-pubkey"];
    return pk ? await getTrustScore(pk) : 0;
  },
  pubkeyFirstPaidAtFromReq: async (req) => {
    const pk = req.headers["x-x402-agent-pubkey"];
    if (!pk) return undefined;
    const rep = await store.getReputation(pk);
    return rep?.firstPaidAt;
  },
});

// Test-only hooks (gated behind env flags)
if (process.env.X402_TEST_GLOBAL_ON_META === "1") {
  rl.meta = createRateLimitMiddleware({
    routeName: "meta",
    ip:     { keyPrefix: "rl:meta:ip", max: parseInt(process.env.META_IP_LIMIT || "120", 10), windowMs: CONFIG.RATE_WINDOW_MS },
    global: { key:       "rl:global",  max: CONFIG.RATE_GLOBAL_LIMIT, windowMs: CONFIG.RATE_WINDOW_MS },
  }, { store, logger });
}
if (process.env.X402_ENABLE_TEST_ROUTES === "1") {
  const rlPubkeyOnly = createRateLimitMiddleware({
    routeName: "test-pubkey",
    pubkey: { keyPrefix: "rl:test:pk", max: CONFIG.RATE_PUBKEY_LIMIT, windowMs: CONFIG.RATE_WINDOW_MS },
  }, { store, logger });
  app.get("/x-test/pubkey-bucket",
    (req, _res, next) => { req.x402Verified = { pubkey: "TestPubkey1111111111111111111111111111111111" }; next(); },
    rlPubkeyOnly,
    (_req, res) => res.json({ ok: true })
  );
}

// Health check (sem 402)
app.get("/health", rl.meta, async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ status: "shutting_down", code: 503 });
  }
  pruneRequestTimestamps();
  const rps = requestTimestamps.length / (CONFIG.LOAD_WINDOW_MS / 1000);
  const [nonces_active, escrow_accounts] = await Promise.all([
    store.nonceCount(),
    store.escrowAccountCount(),
  ]);
  respondHtmlOrJson(req, res, {
    status: "ok",
    load: getRpcLoad().toFixed(2),
    rps: rps.toFixed(2),
    max_rps: CONFIG.MAX_RPS,
    load_forced: CONFIG.RPC_LOAD_FORCE !== null,
    threshold: CONFIG.RPC_LOAD_THRESHOLD,
    nonces_active,
    escrow_accounts,
    store_backend: store.backend,
  }, "Health");
});

// Escrow deposit — verified via on-chain Solana transaction.
//
// Flow:
//   1. Client transfers L lamports from its wallet to CONFIG.PAYMENT_DESTINATION
//      via SystemProgram.transfer on Solana and waits for confirmation.
//   2. Client POSTs the tx signature to this endpoint.
//   3. Shield fetches the tx from SOLANA_RPC_URL, verifies sender +
//      destination + amount + single-use, and credits the sender's escrow
//      with L × 1000 µL.
//
// Trustless: the Shield never takes the client's word for the amount — only
// for the signature, which the chain adjudicates.
app.post("/escrow/deposit", rl.deposit, express.json({ limit: '1kb' }), async (req, res) => {
  const { tx_signature: sig } = req.body || {};

  // 1. Format gate (free)
  if (!sig || typeof sig !== "string" || !SIG_RE.test(sig)) {
    return res.status(400).json({ error: "invalid_signature_format", code: 400 });
  }

  // 2. Negative cache — same bad sig was rejected within the last TTL window
  if (await store.isDepositKnownBad(sig)) {
    bumpReqCounter("/escrow/deposit", "shield_deposit_validation", "blocked");
    return res.status(400).json({
      error: "deposit_signature_known_invalid",
      code: 400,
      reason: "cached_negative",
    });
  }

  // 3. In-flight idempotency lock — N concurrent requests with same sig hit Solana once
  const requestId = req.id || crypto.randomBytes(4).toString("hex");
  const claim = await store.claimPendingDeposit(sig, requestId, CONFIG.DEPOSIT_PENDING_TTL_MS);
  if (!claim.ok) {
    const remainingMs = await store.pendingDepositPttl(sig);
    const retryAfter = Math.max(1, Math.ceil((remainingMs > 0 ? remainingMs : 1000) / 1000));
    res.set("Retry-After", String(retryAfter));
    return res.status(409).json({
      error: "deposit_in_progress",
      code: 409,
      sig,
      retry_after_seconds: retryAfter,
    });
  }

  try {
    // 4. Fire through circuit breaker
    const circuitResult = await fireSolanaCircuit(sig, { verify: verifyDepositTx });
    if (circuitResult.ok === false && circuitResult.reason === "circuit_open") {
      res.set("Retry-After", "30");
      return res.status(503).json({
        error: "solana_rpc_unavailable",
        code: 503,
        reason: "circuit_open",
      });
    }

    const result = circuitResult.value;
    if (!result.ok) {
      // Cache negative for 60s — same sig won't bother Solana again until TTL.
      await store.markDepositKnownBad(sig, CONFIG.DEPOSIT_NEGATIVE_CACHE_TTL_MS);
      bumpReqCounter("/escrow/deposit", "shield_deposit_validation", "blocked");
      // Section 8.2: Tx sig invalid in /escrow/deposit → record IP offense
      const depositIp = req.ip || req.socket.remoteAddress;
      enforcement.recordOffense(store, `ip:${depositIp}`, REASONS.DEPOSIT_SIGNATURE_INVALID, {
        trustScore: 0,
      }).catch(err => logger.warn({ err: err.message }, "[enforcement] deposit recordOffense failed"));
      return res.status(400).json({ error: result.reason, code: 400 });
    }
    logger.info({
      reason: "escrow_deposit_verified",
      pubkey: result.pubkey,
      lamports: result.lamports,
      micro_lamports: result.micro_lamports,
      sig_prefix: result.signature.slice(0, 12),
      slot: result.slot,
      req_id: req.id,
    });
    bumpReqCounter("/escrow/deposit", "forwarded", "deposit_called_solana");
    return res.json({
      pubkey: result.pubkey,
      credited_micro_lamports: result.micro_lamports,
      balance: result.balance,
      signature: result.signature,
      slot: result.slot,
    });
  } finally {
    await store.clearPendingDeposit(sig).catch(() => {});
  }
});

// DEMO/TEST ONLY: credit escrow without an on-chain tx. Mounts only when
// ESCROW_TRUST_DEPOSITS=1 in the environment. Useful for smoke tests,
// benchmarks, and the Trust-Score progression demo where a round trip to
// Solana for every deposit is prohibitive. NEVER enable in production.
if (CONFIG.TRUST_DEPOSITS) {
  logger.warn({ reason: "escrow_trusted_deposits_mounted", msg: "/escrow/deposit-trusted is exposed (demo/test only)" });
  app.post("/escrow/deposit-trusted", rl.deposit, express.json({ limit: '1kb' }), async (req, res) => {
    const { pubkey, amount_micro_lamports } = req.body || {};
    if (!pubkey || !amount_micro_lamports) {
      return res.status(400).json({ error: "pubkey and amount_micro_lamports required" });
    }
    const newBalance = await store.incrEscrow(pubkey, amount_micro_lamports);
    return res.json({ pubkey, balance: newBalance, trusted: true });
  });
}

// Endpoint de consulta de reputação (Trust-Score) + risk classification
app.get("/reputation/:pubkey", rl.reputation, async (req, res) => {
  const pubkey = req.params.pubkey;
  const [rec, attestations] = await Promise.all([
    store.getReputation(pubkey),
    store.getAttestations(pubkey, 100),
  ]);
  const score = await getTrustScore(pubkey);
  const nextDiscountPrice = applyTrustDiscount(CONFIG.MAX_PRICE_MICRO_LAMPORTS, score);
  const risk = computeRisk(attestations, rec);
  respondHtmlOrJson(req, res, {
    pubkey,
    trust_score: score,
    paid_count: rec ? rec.paidCount : 0,
    total_paid_micro_lamports: rec ? rec.totalPaid : 0,
    first_paid_at: rec ? rec.firstPaidAt : null,
    last_paid_at: rec ? rec.lastPaidAt : null,
    current_discount_percent: score / 2,
    example_price_at_max_load: nextDiscountPrice,
    sybil_risk: risk.sybil_risk,
    fraud_flags: risk.fraud_flags,
    churn_pattern: risk.churn_pattern,
    attestations_observed: attestations.length,
  }, "Reputation");
});

// Endpoint de consulta de saldo
app.get("/escrow/balance/:pubkey", rl.balance, async (req, res) => {
  const balance = await store.getEscrow(req.params.pubkey);
  respondHtmlOrJson(req, res, { pubkey: req.params.pubkey, balance_micro_lamports: balance }, "Escrow balance");
});

// ─── Stats / dashboard endpoints ──────────────────────────────────────────────

// Static metadata about this Shield deployment (consumed by /live, /try, /explorer pages).
app.get("/info", rl.meta, (req, res) => {
  const upstream = CONFIG.REAL_RPC_URL;
  const network = upstream.includes("mainnet") ? "mainnet" : upstream.includes("devnet") ? "devnet" : "unknown";
  respondHtmlOrJson(req, res, {
    operator_pubkey: CONFIG.PAYMENT_DESTINATION,
    network,
    upstream_rpc: upstream,
    base_price_micro_lamports: CONFIG.BASE_PRICE_MICRO_LAMPORTS,
    max_price_micro_lamports: CONFIG.MAX_PRICE_MICRO_LAMPORTS,
    threshold: CONFIG.RPC_LOAD_THRESHOLD,
    nonce_ttl_seconds: CONFIG.NONCE_TTL_MS / 1000,
    trusted_deposits_enabled: CONFIG.TRUST_DEPOSITS,
  }, "Gateway info");
});

// ─── Agent endpoints (Phase 4) ───────────────────────────────────────────────

// GET /agent/code-of-conduct — serves the versioned Code of Conduct document.
// Accepts ?version=1.0 (default). Returns JSON or HTML (content-negotiation).
app.get("/agent/code-of-conduct", rl.meta, (req, res) => {
  const v = req.query.version || "1.0";
  const doc = getCodeOfConduct(v);
  if (!doc) return res.status(404).json({ error: "unknown_version", code: 404, version: v });
  respondHtmlOrJson(req, res, doc, "Code of Conduct");
});

// GET /agent/status?pubkey=<base58> — read-only trust/enforcement snapshot
// with 10 s response cache and per-IP rate-limit (10 req/min).
app.get("/agent/status", rl.meta, makeAgentStatusHandler({
  store,
  config: runtimeConfig,
  computeFraudFlagsForPubkey: async (pk) => {
    const attestations = await store.getAttestations(pk, 100).catch(() => []);
    const rep = await store.getReputation(pk).catch(() => null);
    return getActiveFraudFlags(pk, attestations, rep);
  },
}));

// ─── Task 19: GET /metrics — Prometheus scrape endpoint ──────────────────────
// Public (Prometheus scrapers don't send auth). Per-IP rate-limit: 10/min.
const rlMetrics = createRateLimitMiddleware({
  routeName: "metrics",
  ip: { keyPrefix: "rl:metrics:ip", max: 10, windowMs: 60_000 },
}, { store, logger });

app.get("/metrics",
  rlMetrics,
  makeMetricsHandler(() => ({
    qosInflightCount: qosInFlight,
    qosQueueLen:      qosQueue.length,
    store,
  }))
);

// Recent activity for the live dashboard.
// All fields below survive container restart — persisted in Redis (LIST + HASH).
app.get("/stats/recent", rl.stats, async (req, res) => {
  const [
    payments,
    challenges,
    load_history,
    totalPaidMicroLamports,
    unique_paying_pubkeys,
    challengesTotal,
    paymentsTotal,
  ] = await Promise.all([
    store.getRecentPayments(20),
    store.getRecentChallenges(20),
    store.getLoadHistory(30),
    store.getTotalPaidVolume(),
    store.uniquePayingPubkeys(),
    store.getChallengesTotal(),
    store.getPaymentsTotal(),
  ]);
  respondHtmlOrJson(req, res, {
    payments,
    challenges,
    load_history,
    totals: {
      total_challenges_issued: challengesTotal,
      total_payments: paymentsTotal,
      total_paid_micro_lamports: totalPaidMicroLamports,
      unique_paying_pubkeys,
      // Legacy field names kept for backward compat with existing dashboards
      total_challenges_issued_session: challengesTotal,
      total_payments_session: paymentsTotal,
    },
  }, "Recent activity");
});

// QoS dispatcher state — for the /live dashboard QoS card.
// Cumulative counters are persisted in Redis (HASH); wait_samples stay in
// memory as a rolling 200-sample window for percentile calculation.
app.get("/stats/qos", rl.stats, async (req, res) => {
  const sorted = [...qosWaitSamples].sort((a, b) => a - b);
  const qosTotals = await store.getQosStats();
  const total_settled = qosTotals.dispatched_total + qosTotals.bypassed_total;
  const utilization = qosInFlight / Math.max(1, CONFIG.QOS_MAX_INFLIGHT);
  const now = Date.now();
  respondHtmlOrJson(req, res, {
    mode: CONFIG.QOS_MODE,
    queue_depth: qosQueue.length,
    in_flight: qosInFlight,
    max_inflight: CONFIG.QOS_MAX_INFLIGHT,
    max_queue_depth: CONFIG.QOS_MAX_QUEUE_DEPTH,
    queue_timeout_ms: CONFIG.QOS_QUEUE_TIMEOUT_MS,
    utilization: parseFloat(utilization.toFixed(3)),
    bypass_threshold: CONFIG.QOS_BYPASS_THRESHOLD,
    dispatched_total: qosTotals.dispatched_total,
    bypassed_total: qosTotals.bypassed_total,
    total_settled,
    rejected_overflow_total: qosTotals.rejected_overflow_total,
    rejected_timeout_total: qosTotals.rejected_timeout_total,
    wait_p50_ms: qosPercentile(sorted, 0.5),
    wait_p95_ms: qosPercentile(sorted, 0.95),
    wait_p99_ms: qosPercentile(sorted, 0.99),
    wait_samples_count: sorted.length,
    cooperative_fallback_active: now < qosOverloadFallbackUntil,
    cooperative_fallback_until: qosOverloadFallbackUntil > now ? qosOverloadFallbackUntil : null,
    cooperative_health: {
      enabled: CONFIG.QOS_MODE === "cooperative",
      consecutive_successes: qosCoopHealthConsecutiveSuccesses,
      reprobe_required: QOS_HEALTH_REPROBE_REQUIRED,
      last_success_at: qosCoopHealthLastSuccessAt || null,
      failing_since: qosCoopHealthFailingSince,
      last_error: qosCoopHealthLastError,
      probes_ok: qosCoopHealthChecks.ok,
      probes_fail: qosCoopHealthChecks.fail,
      check_interval_ms: QOS_HEALTH_INTERVAL_MS,
      unreachable_threshold_ms: QOS_HEALTH_UNREACHABLE_MS,
    },
  }, "QoS dispatcher");
});

// Top 10 by Trust-Score for the leaderboard widget.
app.get("/stats/leaderboard", rl.stats, async (req, res) => {
  const raw = await store.getLeaderboard(10);
  const top = raw.map((r) => ({
    pubkey: r.pubkey,
    trust_score: Math.min(100, r.paidCount * 5),
    paid_count: r.paidCount,
    total_paid_micro_lamports: r.totalPaid,
    last_paid_at: r.lastPaidAt,
  }));
  respondHtmlOrJson(req, res, { leaderboard: top, generated_at: Date.now() }, "Leaderboard");
});

// ─── Public dashboard pages ──────────────────────────────────────────────────
// Static serving + explicit routes for the 3 dashboards (/live, /try, /explorer).
// Mounted BEFORE the /rpc proxy so static assets aren't intercepted by the
// catch-all proxy. The landing page (public/index.html) is auto-served at /.
const path = require("path");
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("/live", (_req, res) => res.sendFile(path.join(__dirname, "public", "live.html")));
app.get("/try", (_req, res) => res.sendFile(path.join(__dirname, "public", "try.html")));
app.get("/explorer", (_req, res) => res.sendFile(path.join(__dirname, "public", "explorer.html")));

// ─── Proxy RPC (protegido pelo Shield) ───────────────────────────────────────

// Keep TCP + TLS connections to the upstream RPC warm across requests.
// Without an explicit agent with keepAlive, http-proxy-middleware defaults
// to a fresh connection per request, which adds a TCP + TLS handshake
// (typically hundreds of ms over the internet) to every proxied call.
// With keep-alive the marginal cost collapses to a single round trip.
const upstreamIsHttps = CONFIG.REAL_RPC_URL.startsWith("https:");
const upstreamAgent = upstreamIsHttps
  ? new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000, timeout: 15_000 })
  : new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000, timeout: 15_000 });

// Wrap rpcBodyLimit so 413 also fires a recordOffense (Section 8.2).
function rpcBodyLimitWithEnforcement(maxBytes) {
  const inner = rpcBodyLimit(maxBytes);
  return function (req, res, next) {
    // Intercept 413 responses to record the offense before they go out
    const origStatus = res.status.bind(res);
    let intercepted = false;
    res.status = function (code) {
      if (code === 413 && !intercepted) {
        intercepted = true;
        const ip = req.ip || req.socket.remoteAddress;
        enforcement.recordOffense(store, `ip:${ip}`, REASONS.BODY_TOO_LARGE, {
          trustScore: 0,
        }).catch(err => logger.warn({ err: err.message }, "[enforcement] body-limit recordOffense failed"));
      }
      return origStatus(code);
    };
    return inner(req, res, next);
  };
}

app.use(
  "/rpc",
  rpcBodyLimitWithEnforcement(CONFIG.BODY_LIMIT_RPC_BYTES),
  rl.rpcEdge,
  rlEnforce,        // bridges rpcEdge rate-limit state → enforcement ladder
  x402Shield,
  rl.rpcAfterAuth,
  rlEnforce,        // bridges rpcAfterAuth (pubkey) state → enforcement ladder
  qosMiddleware,
  createProxyMiddleware({
    target: CONFIG.REAL_RPC_URL,
    changeOrigin: true,
    pathRewrite: { "^/rpc": "" },
    agent: upstreamAgent,
    proxyTimeout: 15_000,
    // http-proxy-middleware v2.x uses top-level onProxyReq / onProxyRes /
    // onError callbacks. The v3 nested `on: { proxyReq, error }` shape is
    // silently ignored on v2 (which is what's installed via package.json
    // ^2.0.6). This file was previously using the v3 shape — the
    // Authorization header was leaking to the upstream Solana RPC and the
    // custom error path was inert.
    onProxyReq: (proxyReq, req) => {
      proxyReq.removeHeader("authorization");
      if (req.x402Verified) {
        proxyReq.setHeader("X-x402-Verified-Pubkey", req.x402Verified.pubkey);
      }
    },
    onProxyRes: (proxyRes, req) => {
      // Cooperative QoS — listen for X-QoS-Overload from the operator's
      // upstream stack and trigger 30s fallback to standalone queueing.
      if (CONFIG.QOS_MODE === "cooperative" && proxyRes.headers["x-qos-overload"] === "1") {
        qosOverloadFallbackUntil = Date.now() + 30_000;
        logger.warn({ reason: "qos_coop_overload_fallback", duration_ms: 30_000 });
      }
    },
    onError: (err, req, res) => {
      if (!res.headersSent) {
        res.status(502).json({ error: "RPC upstream error", details: err.message });
      }
    },
  })
);

// ─── Boot ─────────────────────────────────────────────────────────────────────

const bootGuards = require("./lib/boot-guards");

// Catch PayloadTooLargeError + parse errors from express.json across all routes.
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "body_too_large",
      code: 413,
      limit: err.limit,
      received: err.length,
    });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid_json", code: 400 });
  }
  return next(err);
});

// Guard A: trusted-deposits + mainnet — hard exit before anything else.
bootGuards.checkTrustedDepositsGuard(process.env);

// Admin keys parsed once at boot. Empty Map → /admin/* mounted as 503 stubs.
const ADMIN_KEYS = bootGuards.parseAdminKeys(process.env);

// Mount /admin/* fall-through stub BEFORE proxy mount so it can intercept
// every /admin/* path when ADMIN_KEYS is empty. Concrete handlers (Phase 4)
// will register their own routes if ADMIN_KEYS.size > 0.
if (ADMIN_KEYS.size === 0) {
  app.use("/admin", (req, res) => {
    res.set("X-Admin-Status", "not_configured");
    res.status(503).json({
      error: "admin_not_configured",
      code: 503,
      message:
        "ADMIN_KEYS_JSON is not set on this deployment; /admin/* is unavailable",
    });
  });
  logger.warn({
    reason: "admin_not_configured",
    msg: "ADMIN_KEYS_JSON missing — /admin/* mounted as 503 stub",
  });
}

// ─── Task 11: /admin/* router (only when ADMIN_KEYS configured) ───────────────
const adminLib = require("./lib/admin");
const { config: adminConfig } = require("./lib/config");
const { auditAdminWrite, massBanGuard } = adminLib.makeAdminGuards({ store, config: adminConfig });

if (ADMIN_KEYS.size > 0) {
  const adminRouter = express.Router();

  // Per-key-id rate-limit for admin endpoints (10 req/min per key-id).
  // Uses the same massBanCounter store to avoid adding a new dependency.
  // Note: this is a lightweight inline guard, not the sliding-window RL.
  const adminKeyRateLimit = async (req, res, next) => {
    const keyId = req.adminKeyId;
    if (!keyId) return next();
    const scope = `rl:admin:keyid:${keyId}`;
    let count;
    try { count = await store.incrMassBanCounter(scope, 60); }
    catch (e) { return next(); }
    if (count > 60) {
      res.set("Retry-After", "60");
      return res.status(429).json({ error: "admin_rate_limit", code: 429 });
    }
    next();
  };

  // Parse req.rawBody (captured by captureRawBody) into req.body for POST routes.
  // express.json() cannot re-read the already-consumed stream, so we do it here.
  const parseAdminJson = (req, res, next) => {
    if (!req.rawBody || !req.rawBody.length) return next();
    const ct = (req.headers["content-type"] || "").split(";")[0].trim();
    if (ct !== "application/json") return next();
    try {
      req.body = JSON.parse(req.rawBody.toString("utf8"));
    } catch (e) {
      return res.status(400).json({ error: "invalid_json", code: 400 });
    }
    next();
  };

  app.use("/admin",
    adminLib.corsAdminLockdown,
    adminLib.captureRawBody,
    adminLib.verifyAdminAuth,
    adminKeyRateLimit,
    parseAdminJson,
    adminRouter
  );

  // ─── Task 12: GET /admin/abuse-log + GET /admin/agent/:pubkey ──────────────

  // GET /admin/abuse-log?limit=N&since=ts&type=ip|pubkey
  adminRouter.get("/abuse-log", async (req, res) => {
    const rawLimit = req.query.limit;
    const parsed = parseInt(rawLimit || "100", 10) || 100;
    const limit = Math.min(500, Math.max(1, parsed));
    if (rawLimit && (parsed < 1 || parsed > 500)) {
      return res.status(400).json({ error: "limit_out_of_range", code: 400, max: 500 });
    }
    const since = req.query.since ? parseInt(req.query.since, 10) : null;
    const type = req.query.type ? String(req.query.type) : null;
    if (type && !["ip", "pubkey"].includes(type)) {
      return res.status(400).json({ error: "invalid_type", code: 400 });
    }
    let entries = await store.getAuditAdmin(limit, since || 0);
    res.json({ entries, count: entries.length, limit, since, type });
  });

  // GET /admin/agent/:pubkey — fuller detail than /agent/status
  adminRouter.get("/agent/:pubkey", async (req, res) => {
    const pubkey = req.params.pubkey;
    const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!PUBKEY_RE.test(pubkey)) return res.status(400).json({ error: "invalid_pubkey", code: 400 });

    const [rec, attestations, abuseHistory, ban, isPerm] = await Promise.all([
      store.getReputation(pubkey),
      store.getAttestations(pubkey, 100),
      store.getAbuseHistory(pubkey, 200).catch(() => []),
      enforcement.checkBan(store, `pk:${pubkey}`).catch(() => null),
      store.isPermanent(`pk:${pubkey}`).catch(() => false),
    ]);
    const fraud = computeRisk(attestations, rec);

    res.json({
      pubkey,
      reputation: rec,
      trust_score: rec ? Math.min(100, rec.paidCount * 5) : 0,
      attestations,
      fraud_signals: { sybil_risk: fraud.sybil_risk, fraud_flags: fraud.fraud_flags, churn_pattern: fraud.churn_pattern },
      ban_history: abuseHistory,
      current_ban: ban,
      permanent: isPerm,
    });
  });

  // ─── Task 13: POST /admin/ban + POST /admin/unban ──────────────────────────

  const VALID_TIERS = new Set([2, 3, 4]);

  adminRouter.post("/ban", massBanGuard, async (req, res) => {
    const { key, type, tier, reason, ttl_s } = req.body || {};
    if (typeof key !== "string" || !key.length) {
      await auditAdminWrite(req, "ban", { key, type }, "rejected", { reason: "missing_key" });
      return res.status(400).json({ error: "missing_key", code: 400 });
    }
    if (!["ip", "pubkey"].includes(type)) {
      await auditAdminWrite(req, "ban", { key, type }, "rejected", { reason: "invalid_type" });
      return res.status(400).json({ error: "invalid_type", code: 400 });
    }
    if (!VALID_TIERS.has(tier)) {
      await auditAdminWrite(req, "ban", { key, type }, "rejected", { reason: "invalid_tier", tier });
      return res.status(400).json({ error: "invalid_tier", code: 400, allowed: [...VALID_TIERS] });
    }
    if (typeof reason !== "string" || reason.trim().length < 3) {
      await auditAdminWrite(req, "ban", { key, type }, "rejected", { reason: "reason_required" });
      return res.status(400).json({ error: "reason_required", code: 400 });
    }

    if (tier === 4) {
      // Tier 4: permanent ban — store as `pk:<key>` or `ip:<key>` prefix
      const storeKey = type === "pubkey" ? `pk:${key}` : `ip:${key}`;
      await store.addPermanent(storeKey, reason);
      await auditAdminWrite(req, "ban", { type, key }, "ok", { tier, reason, permanent: true });
      return res.json({ ok: true, tier: 4, permanent: true, key, type });
    }
    const ttlMs = tier === 3 ? (adminConfig.HARD_BAN_DURATION_MS) : (adminConfig.SOFT_BAN_DURATION_MS);
    const effectiveTtl = ttl_s ? Math.max(60_000, Math.min(7 * 86400 * 1000, parseInt(ttl_s, 10) * 1000)) : ttlMs;
    const storeKey = type === "pubkey" ? `pk:${key}` : `ip:${key}`;
    await store.setBan(storeKey, tier, reason, effectiveTtl);
    await auditAdminWrite(req, "ban", { type, key }, "ok", { tier, reason, ttl_ms: effectiveTtl });
    res.json({ ok: true, tier, key, type, ttl_ms: effectiveTtl });
  });

  adminRouter.post("/unban", async (req, res) => {
    const { key, type, reason } = req.body || {};
    if (typeof key !== "string" || !key.length || !["ip", "pubkey"].includes(type)) {
      await auditAdminWrite(req, "unban", { key, type }, "rejected", { reason: "invalid_input" });
      return res.status(400).json({ error: "invalid_input", code: 400 });
    }
    if (typeof reason !== "string" || reason.trim().length < 3) {
      return res.status(400).json({ error: "reason_required", code: 400 });
    }
    const storeKey = type === "pubkey" ? `pk:${key}` : `ip:${key}`;
    await store.clearBan(storeKey);
    await store.removePermanent(storeKey);
    await auditAdminWrite(req, "unban", { type, key }, "ok", { reason });
    res.json({ ok: true, key, type });
  });

  // ─── Task 16: GET /admin/config + POST /admin/config (hot-reload) ─────────

  adminRouter.get("/config", async (req, res) => {
    await auditAdminWrite(req, "config_read", null, "ok");
    res.json({ config: getConfig() });
  });

  adminRouter.post("/config", async (req, res) => {
    const updates = req.body?.updates;
    const reason  = req.body?.reason;
    const meta    = req.body?.meta || {};
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return res.status(400).json({ error: "updates_object_required", code: 400 });
    }
    if (typeof reason !== "string" || reason.trim().length < 3) {
      return res.status(400).json({ error: "reason_required", code: 400 });
    }

    // Validate + apply — first failure short-circuits before any further keys.
    const applied = [];
    for (const [k, v] of Object.entries(updates)) {
      const r = applyUpdate(k, v, meta);
      if (!r.ok) {
        await auditAdminWrite(req, "config_update", null, "rejected",
          { failed_key: k, reason: r.reason });
        return res.status(400).json({
          error: "update_rejected", failed_key: k, reason: r.reason, range: r.range,
        });
      }
      applied.push(r);
    }

    await auditAdminWrite(req, "config_update", null, "ok", {
      updates: applied.map(d => ({ key: d.key, oldValue: d.oldValue, newValue: d.newValue })),
      reason, meta,
    });
    res.json({ ok: true, applied, config: getConfig() });
  });
}

if (
  bootGuards.isMainnet(process.env) &&
  process.env.RPC_LOAD_FORCE &&
  process.env.RPC_LOAD_FORCE !== "0" &&
  process.env.RPC_LOAD_FORCE !== ""
) {
  logger.warn({
    reason: "rpc_load_force_mainnet",
    value: process.env.RPC_LOAD_FORCE,
    msg: "RPC_LOAD_FORCE is active in mainnet — every request will see synthetic load",
  });
}

async function boot() {
  if (CONFIG.REDIS_REQUIRED) {
    try {
      await bootGuards.waitForRedisOrFail(store, {
        timeoutMs: CONFIG.REDIS_REQUIRED_TIMEOUT_MS,
      });
    } catch (e) {
      logger.fatal({
        reason: "boot_guard_redis_required",
        timeout_ms: CONFIG.REDIS_REQUIRED_TIMEOUT_MS,
        msg: "REDIS_REQUIRED=true and Redis unreachable — exiting",
      });
      setTimeout(() => process.exit(1), 50);
      return;
    }
  } else if (process.env.REDIS_URL) {
    const healthy = await store.isStoreHealthy();
    if (!healthy) {
      logger.warn({
        reason: "redis_unhealthy_memory_fallback",
        msg: "REDIS_URL set but Redis is unhealthy and REDIS_REQUIRED=false — running in memory-fallback mode",
      });
    }
  }

  const server = app.listen(CONFIG.PORT, () => {
    logger.info({
      reason: "boot_listening",
      port: CONFIG.PORT,
      upstream: CONFIG.REAL_RPC_URL,
      store_backend: store.backend,
      msg: "x402-shield listening",
    });
  });
  server.headersTimeout   = 10_000;
  server.requestTimeout   = 30_000;
  server.keepAliveTimeout = 5_000;
  server.timeout          = 60_000;
  return server;
}

let _server = null;
boot().then((s) => {
  _server = s;
  if (!_server) return;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason: "shutdown_begin", signal });
    _server.close((err) => {
      if (err) logger.error({ reason: "shutdown_server_close_error", error: err.message });
    });

    const drainStart = Date.now();
    const drainDeadlineMs = 25_000;

    const tick = setInterval(async () => {
      const drainedQos = qosInFlight === 0 && qosQueue.length === 0;
      const elapsed = Date.now() - drainStart;

      if (drainedQos || elapsed > drainDeadlineMs) {
        clearInterval(tick);
        try { await store.close(); } catch (e) {
          logger.error({ reason: "shutdown_store_close_error", error: e.message });
        }
        logger.info({
          reason: "shutdown_complete",
          elapsed_ms: elapsed,
          qos_in_flight: qosInFlight,
          qos_queue_depth: qosQueue.length,
        });
        setTimeout(() => process.exit(0), 100);
      }
    }, 200);
    tick.unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}).catch((e) => {
  logger.fatal({ reason: "boot_failure", error: e.message });
  setTimeout(() => process.exit(1), 50);
});

module.exports = { app, verifyX402Authorization, issueNonce };
