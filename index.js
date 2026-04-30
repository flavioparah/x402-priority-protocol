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

// ─── Configuração ────────────────────────────────────────────────────────────

const CONFIG = {
  PORT: process.env.PORT || 3000,
  REAL_RPC_URL: process.env.REAL_RPC_URL || "https://api.mainnet-beta.solana.com",
  PAYMENT_DESTINATION: process.env.PAYMENT_DESTINATION || "YourSolAddressHere",

  // Limites de carga — ajuste conforme o hardware do nó
  RPC_LOAD_THRESHOLD: parseFloat(process.env.RPC_LOAD_THRESHOLD || "0.75"),
  REQUESTS_PER_IP_LIMIT: parseInt(process.env.REQUESTS_PER_IP_LIMIT || "100"),
  RATE_WINDOW_MS: parseInt(process.env.RATE_WINDOW_MS || "60000"),

  // Preço dinâmico (micro-lamports) — escala com a carga
  BASE_PRICE_MICRO_LAMPORTS: parseInt(process.env.BASE_PRICE || "1000"),
  MAX_PRICE_MICRO_LAMPORTS: parseInt(process.env.MAX_PRICE || "50000"),

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
};

// ─── Estado em memória (substitua por Redis em produção) ──────────────────────

/** @type {Map<string, { count: number, resetAt: number }>} */
const ipCounters = new Map();

// ─── Persistence layer ────────────────────────────────────────────────────────
// The four critical state pieces (escrow, nonces, reputation, deposit
// signatures) live in a Store abstraction. In-memory by default; switches
// to Redis when REDIS_URL is set. See lib/store.js for both implementations.
const { createStore } = require("./lib/store");
const store = createStore();

// Sybil / fraud / churn detection over the per-pubkey attestation log.
// Signals are computed lazily at /reputation/:pubkey query time.
const { computeRisk } = require("./lib/detection");

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

  let tx;
  try {
    tx = await getSolanaConnection().getParsedTransaction(signature, {
      commitment: CONFIG.DEPOSIT_COMMITMENT,
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    return { ok: false, reason: `RPC error fetching transaction: ${err.message}` };
  }

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

/** Verifica se o IP excedeu o limite de requisições. */
function isRateLimited(ip) {
  const now = Date.now();
  let counter = ipCounters.get(ip);
  if (!counter || counter.resetAt < now) {
    counter = { count: 0, resetAt: now + CONFIG.RATE_WINDOW_MS };
    ipCounters.set(ip, counter);
  }
  counter.count++;
  return counter.count > CONFIG.REQUESTS_PER_IP_LIMIT;
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
        console.log(
          `[qos] cooperative re-probe: ${QOS_HEALTH_REPROBE_REQUIRED} consecutive OK — ending fallback early`
        );
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
          console.warn(
            `[qos] cooperative operator unreachable for >${QOS_HEALTH_UNREACHABLE_MS / 1000}s (${qosCoopHealthLastError}) — forcing fallback`
          );
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
  }).catch((e) => console.error("[stats] pushLoadSample failed:", e.message));
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
  if (!authHeader || !authHeader.startsWith("x402 ")) return { ok: false, reason: "Missing x402 header" };

  try {
    const token = authHeader.slice(5); // remove "x402 "
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "Malformed token (expected sig.pubkey.msg)" };

    const [sigB58, pubkeyB58, msgB58] = parts;
    const signature = bs58.decode(sigB58);
    const pubkeyBytes = bs58.decode(pubkeyB58);
    const messageBytes = bs58.decode(msgB58);

    // Verifica a assinatura Ed25519
    const valid = nacl.sign.detached.verify(messageBytes, signature, pubkeyBytes);
    if (!valid) return { ok: false, reason: "Invalid signature" };

    // Decodifica o payload
    const payload = JSON.parse(Buffer.from(messageBytes).toString("utf8"));
    const { nonce, pubkey, amount, destination } = payload;

    if (pubkey !== pubkeyB58) return { ok: false, reason: "Pubkey mismatch" };
    if (destination !== CONFIG.PAYMENT_DESTINATION) return { ok: false, reason: "Wrong destination" };

    // Atomic consume: validates nonce existence, used flag, amount,
    // hintedPubkey match, and escrow balance — and marks nonce used + debits
    // escrow — all in one server-side operation (Redis Lua, or single
    // synchronous JS tick for in-memory). This is what closes the
    // double-spend race where two concurrent requests with the same signed
    // nonce could both observe used:false before either marks it true.
    const consume = await store.consumeNonceAndDebit(nonce, pubkeyB58, amount);
    if (!consume.ok) {
      // Map machine reason codes to friendlier messages for response/logs.
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

    // Credit reputation so subsequent challenges for this pubkey are cheaper.
    // Done after the atomic consume — if recordPayment fails, the debit
    // already happened (acceptable: rep is best-effort metadata, debit is the
    // money-critical op).
    await recordPayment(pubkeyB58, amount);

    const score = await getTrustScore(pubkeyB58);
    return { ok: true, pubkey: pubkeyB58, amount, nonce, score };
  } catch (err) {
    return { ok: false, reason: `Verification error: ${err.message}` };
  }
}

// ─── Middleware principal: x402 Rate Limiter + Challenger ─────────────────────

async function x402Shield(req, res, next) {
  recordRequest();
  const ip = req.ip || req.socket.remoteAddress;
  const load = getRpcLoad();
  const challenged = load > CONFIG.RPC_LOAD_THRESHOLD || isRateLimited(ip);

  if (!challenged) return next();

  // Verifica se o agente já enviou uma prova de pagamento válida
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const result = await verifyX402Authorization(authHeader);
    if (result.ok) {
      console.log(`[x402] ✓ Payment accepted from ${result.pubkey} (${result.amount} µL, nonce: ${result.nonce}, trust=${result.score})`);
      req.x402Verified = result;
      return next();
    }
    // Prova inválida — retorna 402 com novo desafio
    console.warn(`[x402] ✗ Invalid proof from ${ip}: ${result.reason}`);
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

  console.log(`[x402] ⚡ Challenging ${ip} — load: ${(load * 100).toFixed(1)}%, base: ${basePrice} µL, trust: ${trustScore}, final: ${amount} µL`);

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

// CORS middleware — must come BEFORE all routes so preflight OPTIONS resolves
// without falling into the /rpc proxy.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-x402-Agent-Pubkey");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-x402-Status, X-x402-Payment-Destination, X-x402-Amount, X-x402-Amount-Base, X-x402-Trust-Score, X-x402-Nonce, X-x402-Nonce-TTL"
  );
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// NB: do NOT mount express.json() globally — it consumes the request body,
// which breaks http-proxy-middleware for /rpc (upstream times out waiting for
// a body that was already parsed and discarded). Apply per-route instead.

// Health check (sem 402)
app.get("/health", async (req, res) => {
  pruneRequestTimestamps();
  const rps = requestTimestamps.length / (CONFIG.LOAD_WINDOW_MS / 1000);
  const [nonces_active, escrow_accounts] = await Promise.all([
    store.nonceCount(),
    store.escrowAccountCount(),
  ]);
  res.json({
    status: "ok",
    load: getRpcLoad().toFixed(2),
    rps: rps.toFixed(2),
    max_rps: CONFIG.MAX_RPS,
    load_forced: CONFIG.RPC_LOAD_FORCE !== null,
    threshold: CONFIG.RPC_LOAD_THRESHOLD,
    nonces_active,
    escrow_accounts,
    store_backend: store.backend,
  });
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
app.post("/escrow/deposit", express.json(), async (req, res) => {
  const { tx_signature } = req.body || {};
  if (!tx_signature) {
    return res.status(400).json({ error: "tx_signature (base58) required" });
  }
  const result = await verifyDepositTx(tx_signature);
  if (!result.ok) {
    return res.status(400).json({ error: result.reason });
  }
  console.log(`[escrow] ✓ Verified deposit from ${result.pubkey}: ${result.lamports} lamports = ${result.micro_lamports} µL (sig=${result.signature.slice(0, 12)}…, slot=${result.slot})`);
  return res.json({
    pubkey: result.pubkey,
    credited_micro_lamports: result.micro_lamports,
    balance: result.balance,
    signature: result.signature,
    slot: result.slot,
  });
});

// DEMO/TEST ONLY: credit escrow without an on-chain tx. Mounts only when
// ESCROW_TRUST_DEPOSITS=1 in the environment. Useful for smoke tests,
// benchmarks, and the Trust-Score progression demo where a round trip to
// Solana for every deposit is prohibitive. NEVER enable in production.
if (CONFIG.TRUST_DEPOSITS) {
  console.warn("[escrow] ⚠️  ESCROW_TRUST_DEPOSITS=1 — /escrow/deposit-trusted mounted. Demo/test only.");
  app.post("/escrow/deposit-trusted", express.json(), async (req, res) => {
    const { pubkey, amount_micro_lamports } = req.body || {};
    if (!pubkey || !amount_micro_lamports) {
      return res.status(400).json({ error: "pubkey and amount_micro_lamports required" });
    }
    const newBalance = await store.incrEscrow(pubkey, amount_micro_lamports);
    return res.json({ pubkey, balance: newBalance, trusted: true });
  });
}

// Endpoint de consulta de reputação (Trust-Score) + risk classification
app.get("/reputation/:pubkey", async (req, res) => {
  const pubkey = req.params.pubkey;
  const [rec, attestations] = await Promise.all([
    store.getReputation(pubkey),
    store.getAttestations(pubkey, 100),
  ]);
  const score = await getTrustScore(pubkey);
  const nextDiscountPrice = applyTrustDiscount(CONFIG.MAX_PRICE_MICRO_LAMPORTS, score);
  const risk = computeRisk(attestations, rec);
  res.json({
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
  });
});

// Endpoint de consulta de saldo
app.get("/escrow/balance/:pubkey", async (req, res) => {
  const balance = await store.getEscrow(req.params.pubkey);
  res.json({ pubkey: req.params.pubkey, balance_micro_lamports: balance });
});

// ─── Stats / dashboard endpoints ──────────────────────────────────────────────

// Static metadata about this Shield deployment (consumed by /live, /try, /explorer pages).
app.get("/info", (req, res) => {
  const upstream = CONFIG.REAL_RPC_URL;
  const network = upstream.includes("mainnet") ? "mainnet" : upstream.includes("devnet") ? "devnet" : "unknown";
  res.json({
    operator_pubkey: CONFIG.PAYMENT_DESTINATION,
    network,
    upstream_rpc: upstream,
    base_price_micro_lamports: CONFIG.BASE_PRICE_MICRO_LAMPORTS,
    max_price_micro_lamports: CONFIG.MAX_PRICE_MICRO_LAMPORTS,
    threshold: CONFIG.RPC_LOAD_THRESHOLD,
    nonce_ttl_seconds: CONFIG.NONCE_TTL_MS / 1000,
    trusted_deposits_enabled: CONFIG.TRUST_DEPOSITS,
  });
});

// Recent activity for the live dashboard.
// All fields below survive container restart — persisted in Redis (LIST + HASH).
app.get("/stats/recent", async (req, res) => {
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
  res.json({
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
  });
});

// QoS dispatcher state — for the /live dashboard QoS card.
// Cumulative counters are persisted in Redis (HASH); wait_samples stay in
// memory as a rolling 200-sample window for percentile calculation.
app.get("/stats/qos", async (req, res) => {
  const sorted = [...qosWaitSamples].sort((a, b) => a - b);
  const qosTotals = await store.getQosStats();
  const total_settled = qosTotals.dispatched_total + qosTotals.bypassed_total;
  const utilization = qosInFlight / Math.max(1, CONFIG.QOS_MAX_INFLIGHT);
  const now = Date.now();
  res.json({
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
  });
});

// Top 10 by Trust-Score for the leaderboard widget.
app.get("/stats/leaderboard", async (req, res) => {
  const raw = await store.getLeaderboard(10);
  const top = raw.map((r) => ({
    pubkey: r.pubkey,
    trust_score: Math.min(100, r.paidCount * 5),
    paid_count: r.paidCount,
    total_paid_micro_lamports: r.totalPaid,
    last_paid_at: r.lastPaidAt,
  }));
  res.json({ leaderboard: top, generated_at: Date.now() });
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
  ? new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 })
  : new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });

app.use(
  "/rpc",
  x402Shield,
  qosMiddleware,
  createProxyMiddleware({
    target: CONFIG.REAL_RPC_URL,
    changeOrigin: true,
    pathRewrite: { "^/rpc": "" },
    agent: upstreamAgent,
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
        console.warn(
          `[qos] cooperative operator returned X-QoS-Overload:1 — falling back to standalone queue for 30s`
        );
      }
    },
    onError: (err, req, res) => {
      if (!res.headersSent) {
        res.status(502).json({ error: "RPC upstream error", details: err.message });
      }
    },
  })
);

app.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║              x402-Shield  v0.1.0  (MVP)              ║
╠══════════════════════════════════════════════════════╣
║  Listening  : http://localhost:${CONFIG.PORT}/rpc           ║
║  Upstream   : ${CONFIG.REAL_RPC_URL.slice(0, 36).padEnd(36)} ║
║  Destination: ${CONFIG.PAYMENT_DESTINATION.slice(0, 36).padEnd(36)} ║
║  Threshold  : ${String(CONFIG.RPC_LOAD_THRESHOLD * 100).padEnd(36)}% ║
╚══════════════════════════════════════════════════════╝
  `);
});

module.exports = { app, verifyX402Authorization, issueNonce };
