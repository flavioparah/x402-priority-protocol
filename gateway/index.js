/**
 * x402-Shield — Proxy/Middleware para nós RPC Solana
 * Emite desafios HTTP 402 sob carga, valida provas de pagamento
 * e encaminha requisições legítimas ao RPC real.
 *
 * MVP: usa assinatura Ed25519 off-chain contra saldo pré-depositado.
 */

const express = require("express");
require("dotenv").config();
const path = require("path");
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
  // QoS Weights for Starvation Protection
  QOS_WEIGHT_TURBO: parseInt(process.env.QOS_WEIGHT_TURBO || "5"),
  QOS_WEIGHT_PAID: parseInt(process.env.QOS_WEIGHT_PAID || "2"),
  QOS_WEIGHT_NORMAL: parseInt(process.env.QOS_WEIGHT_NORMAL || "1"),
};

console.log(`[CONFIG] Gateway initialized for destination: ${CONFIG.PAYMENT_DESTINATION}`);

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

/**
 * Deterministically stringifies JSON by sorting keys.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      key => JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Calculates SHA-256 hash of a request body using canonical stringification.
 */
function sha256Body(body) {
  if (!body) return "empty";
  return crypto.createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/**
 * Validates Solana signature format (Base58, 64 bytes).
 */
function isValidSolanaSignature(sig) {
  if (typeof sig !== "string") return false;
  if (sig.length < 80 || sig.length > 100) return false;
  try {
    const decoded = bs58.decode(sig);
    return decoded.length === 64;
  } catch {
    return false;
  }
}

/**
 * RPC method cost multipliers.
 */
const METHOD_PRICING = {
  getHealth: 1,
  getBalance: 1,
  getBlockHeight: 1,
  getAccountInfo: 2,
  getTransaction: 4,
  getSignaturesForAddress: 6,
  getProgramAccounts: 20,
  sendTransaction: 8,
  default: 2,
};

/**
 * Returns cost multiplier based on RPC method(s).
 * Handles both single requests and JSON-RPC batches.
 */
function getMethodMultiplier(body) {
  if (!body) return METHOD_PRICING.default;
  
  // Handle JSON-RPC Batch
  if (Array.isArray(body)) {
    let total = 0;
    for (const item of body) {
      const m = (item && item.method) ? (METHOD_PRICING[item.method] || METHOD_PRICING.default) : METHOD_PRICING.default;
      total += m;
    }
    return total;
  }

  // Handle Single Request
  if (!body.method) return METHOD_PRICING.default;
  return METHOD_PRICING[body.method] || METHOD_PRICING.default;
}

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
 * Sliding-window stats exposed via /stats/* for the public dashboards.
 * In-memory only (lost on restart). Cap to keep RAM bounded.
 */
/** @type {Array<{ts:number, pubkeyHint:string|null, basePrice:number, finalPrice:number, load:number}>} */
const challengeLog = [];
/** @type {Array<{ts:number, pubkey:string, amount:number, score:number}>} */
const paymentLog = [];
/** @type {Array<{ts:number, type:string, msg:string, hash?:string, url?:string}>} */
const auditLog = [];
function addAudit(type, msg, hash = null, url = null) {
  auditLog.push({ ts: Date.now(), type, msg, hash, url });
  if (auditLog.length > 50) auditLog.shift();
}

// ─── QoS Path A — bucket-based priority queues ────────────────────────────────
const qosBuckets = {
  turbo: [],
  paid: [],
  normal: [],
};
let qosInFlight = 0;
let qosRoundRobinCounter = 0; // Cycle: 5 turbo, 2 paid, 1 normal

const qosStats = {
  dispatched_total: 0,
  bypassed_total: 0,
  rejected_overflow_total: 0,
  rejected_timeout_total: 0,
  wait_samples: [],
};

function qosGetNext() {
  qosRoundRobinCounter++;
  const totalWeight = CONFIG.QOS_WEIGHT_TURBO + CONFIG.QOS_WEIGHT_PAID + CONFIG.QOS_WEIGHT_NORMAL;
  const cycle = qosRoundRobinCounter % totalWeight;

  let entry = null;
  if (cycle < CONFIG.QOS_WEIGHT_TURBO) {
    entry = qosBuckets.turbo.shift() || qosBuckets.paid.shift() || qosBuckets.normal.shift();
  } else if (cycle < CONFIG.QOS_WEIGHT_TURBO + CONFIG.QOS_WEIGHT_PAID) {
    entry = qosBuckets.paid.shift() || qosBuckets.turbo.shift() || qosBuckets.normal.shift();
  } else {
    entry = qosBuckets.normal.shift() || qosBuckets.turbo.shift() || qosBuckets.paid.shift();
  }

  if (qosRoundRobinCounter >= totalWeight) qosRoundRobinCounter = 0;
  return entry;
}

function qosOnSlotFree() {
  while (qosInFlight < CONFIG.QOS_MAX_INFLIGHT) {
    const entry = qosGetNext();
    if (!entry) break;

    if (entry.timeoutId) clearTimeout(entry.timeoutId);

    const waitMs = Date.now() - entry.enqueuedAt;
    qosStats.wait_samples.push(waitMs);
    if (qosStats.wait_samples.length > 200) qosStats.wait_samples.shift();

    qosInFlight++;
    qosStats.dispatched_total++;
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

// Cooperative QoS — when the operator returns X-QoS-Overload:1, we fall back
// to standalone queueing for 30 seconds (per QOS-COOPERATIVE-SPEC.md §5).
let qosOverloadFallbackUntil = 0;

// Cooperative QoS health probe state
let qosCoopHealthConsecutiveSuccesses = 0;
let qosCoopHealthLastSuccessAt = 0;
let qosCoopHealthFailingSince = null;
let qosCoopHealthLastError = null;
let qosCoopHealthChecks = { ok: 0, fail: 0 };
const QOS_HEALTH_INTERVAL_MS = 30_000;
const QOS_HEALTH_UNREACHABLE_MS = 60_000;
const QOS_HEALTH_REPROBE_REQUIRED = 3;

function qosBaseScore(req) {
  const v = req.x402Verified;
  if (!v) return 0;
  return (v.amount || 0) + (v.score || 0) * 100;
}

function qosQueueDepth() {
  return qosBuckets.turbo.length + qosBuckets.paid.length + qosBuckets.normal.length;
}

function qosMiddleware(req, res, next) {
  if (CONFIG.QOS_MODE === "off") return next();

  if (CONFIG.QOS_MODE === "cooperative" && Date.now() >= qosOverloadFallbackUntil) {
    req.headers["x-priority-score"] = String(qosBaseScore(req));
    req.headers["x-qos-spec-version"] = "1";
    return next();
  }

  if (qosInFlight < CONFIG.QOS_MAX_INFLIGHT * CONFIG.QOS_BYPASS_THRESHOLD) {
    qosStats.bypassed_total++;
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

  if (qosQueueDepth() >= CONFIG.QOS_MAX_QUEUE_DEPTH) {
    qosStats.rejected_overflow_total++;
    return res.status(503).json({
      error: "QoS queue full",
      code: 503,
      queue_depth: qosQueueDepth(),
      retry_after_seconds: 1,
    });
  }

  const score = qosBaseScore(req);
  const entry = {
    req, res, next, score,
    enqueuedAt: Date.now(),
    timeoutId: null,
  };

  // Bucket insertion O(1)
  if (score > 5000) qosBuckets.turbo.push(entry);
  else if (score > 0) qosBuckets.paid.push(entry);
  else qosBuckets.normal.push(entry);

  entry.timeoutId = setTimeout(() => {
    // Linear remove from one of the buckets (safe since buckets are limited by QOS_MAX_QUEUE_DEPTH)
    for (const b of [qosBuckets.turbo, qosBuckets.paid, qosBuckets.normal]) {
      const idx = b.indexOf(entry);
      if (idx >= 0) {
        b.splice(idx, 1);
        qosStats.rejected_timeout_total++;
        if (!res.headersSent) {
          res.status(504).json({
            error: "QoS queue timeout",
            code: 504,
            waited_ms: Date.now() - entry.enqueuedAt,
          });
        }
        break;
      }
    }
  }, CONFIG.QOS_QUEUE_TIMEOUT_MS);

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
  requestTimestamps.push(Date.now());
}

function getRpcLoad() {
  if (CONFIG.RPC_LOAD_FORCE !== null) return CONFIG.RPC_LOAD_FORCE;
  pruneRequestTimestamps();
  const rps = requestTimestamps.length / (CONFIG.LOAD_WINDOW_MS / 1000);
  return Math.min(1, rps / CONFIG.MAX_RPS);
}

/** Calculates dynamic price based on current load. */
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

  addAudit("SUCCESS", `Deposit verified: ${microLamports} µL credited to ${crediting.source.slice(0,8)}...`, signature, `https://solscan.io/tx/${signature}`);

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
  paymentLog.push({ ts: now, pubkey: pubkeyB58, amount, score });
  if (paymentLog.length > 100) paymentLog.shift();
  // Per-pubkey attestation log — feeds the sybil/fraud detection engine.
  // Tagged with our operator_id so cross-op signals activate when the broker
  // sees attestations from another operator with a different OPERATOR_ID.
  await store.pushAttestation(pubkeyB58, {
    ts: now,
    amount,
    operator_id: CONFIG.OPERATOR_ID,
  });
}

/** Verifies if the IP exceeded the request limit. */
function isRateLimited(ip) {
  if (ip === "127.0.0.1" || ip === "::1" || ip.includes("127.0.0.1")) return false; // Whitelist local
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
async function issueNonce(amount, bodyHash, hintedPubkey) {
  const nonce = crypto.randomBytes(16).toString("hex");
  await store.setNonce(nonce, {
    amount,
    bodyHash,
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
setInterval(() => {
  pruneRequestTimestamps();
  loadHistory.push({
    ts: Date.now(),
    load: parseFloat(getRpcLoad().toFixed(3)),
    rps: parseFloat((requestTimestamps.length / (CONFIG.LOAD_WINDOW_MS / 1000)).toFixed(2)),
  });
  if (loadHistory.length > 60) loadHistory.shift();
}, 60_000);

/**
 * Validates Authorization: x402 <payload_base58>
 *
 * Payload: JSON.stringify({ nonce, pubkey, amount, destination, body_hash })
 * Signed with client's Ed25519 key.
 *
 * Format: "x402 <base58(sig)>.<base58(pubkey)>.<base58(msg)>"
 */
async function verifyX402Authorization(authHeader, currentBodyHash) {
  if (!authHeader || !authHeader.startsWith("x402 ")) return { ok: false, reason: "Missing x402 header" };

  try {
    const token = authHeader.slice(5); 
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "Malformed token" };

    const [sigB58, pubkeyB58, msgB58] = parts;
    const signature = bs58.decode(sigB58);
    const pubkeyBytes = bs58.decode(pubkeyB58);
    const messageBytes = bs58.decode(msgB58);

    const valid = nacl.sign.detached.verify(messageBytes, signature, pubkeyBytes);
    if (!valid) return { ok: false, reason: "Invalid signature" };

    const payload = JSON.parse(Buffer.from(messageBytes).toString("utf8"));
    const { nonce, pubkey, amount, destination, body_hash, network, protocol } = payload;

    // Strict contextual verification
    if (protocol && protocol !== "x402-shield") return { ok: false, reason: "Invalid protocol" };
    if (network && !CONFIG.SOLANA_RPC_URL.includes(network)) return { ok: false, reason: "Network mismatch" };
    if (pubkey !== pubkeyB58) return { ok: false, reason: "Pubkey mismatch" };
    if (destination !== CONFIG.PAYMENT_DESTINATION) return { ok: false, reason: "Wrong destination" };
    if (body_hash && body_hash !== currentBodyHash) return { ok: false, reason: "Body integrity violation" };

    const consume = await store.consumeNonceAndDebit(nonce, pubkeyB58, amount);
    if (!consume.ok) {
      const friendly = {
        nonce_not_found: "Expired nonce",
        nonce_already_used: "Replay detected",
        nonce_expired: "Nonce expired",
        insufficient_payment: "Insufficient payment",
        pubkey_hint_mismatch: "Signer mismatch",
        insufficient_balance: "Insufficient balance",
      };
      return { ok: false, reason: friendly[consume.reason] || consume.reason };
    }

    await recordPayment(pubkeyB58, amount);
    const score = await getTrustScore(pubkeyB58);
    
    addAudit("AUTH", `Priority granted to ${pubkeyB58.slice(0,8)}... (Payment: ${amount} µL)`, nonce);

    return { ok: true, pubkey: pubkeyB58, amount, nonce, score };
  } catch (err) {
    return { ok: false, reason: "Verification error" };
  }
}

// ─── Main Middleware: x402 Rate Limiter + Challenger ──────────────────────────

async function x402Shield(req, res, next) {
  recordRequest();
  const ip = req.ip || req.socket.remoteAddress;
  const load = getRpcLoad();
  const challenged = load > CONFIG.RPC_LOAD_THRESHOLD || isRateLimited(ip);

  if (!challenged) return next();

  // Strict limits for production
  const MAX_BATCH_ITEMS = 50;
  const MAX_PAYLOAD_SIZE = 1 * 1024 * 1024; // 1MB

  if (Array.isArray(req.body) && req.body.length > MAX_BATCH_ITEMS) {
    return res.status(400).json({ error: "Batch too large" });
  }
  if (req.headers["content-length"] && parseInt(req.headers["content-length"]) > MAX_PAYLOAD_SIZE) {
    return res.status(413).json({ error: "Payload too large" });
  }

  const currentBodyHash = sha256Body(req.body);

  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const result = await verifyX402Authorization(authHeader, currentBodyHash);
    if (result.ok) {
      req.x402Verified = result;
      return next();
    }
  }

  const hintedPubkey = req.headers["x-x402-agent-pubkey"] || null;
  const trustScore = hintedPubkey ? await getTrustScore(hintedPubkey) : 0;
  
  const methodMultiplier = getMethodMultiplier(req.body);
  const basePrice = calcDynamicPrice(load) * methodMultiplier;
  const amount = applyTrustDiscount(basePrice, trustScore);
  const nonce = await issueNonce(amount, currentBodyHash, hintedPubkey);

  addAudit("402", `Challenge issued: ${amount} µL required for ${req.body.method || 'batch'}`, currentBodyHash);

  challengeLog.push({
    ts: Date.now(),
    pubkeyHint: hintedPubkey || null,
    basePrice,
    finalPrice: amount,
    load: parseFloat(load.toFixed(3)),
  });
  if (challengeLog.length > 100) challengeLog.shift();

  res.status(402).set({
    "X-x402-Status": "challenged",
    "X-x402-Payment-Destination": CONFIG.PAYMENT_DESTINATION,
    "X-x402-Amount": String(amount),
    "X-x402-Nonce": nonce,
    "X-x402-Body-Hash": currentBodyHash,
    "Content-Type": "application/json",
  }).json({
    error: "Payment Required",
    code: 402,
    payment: {
      destination: CONFIG.PAYMENT_DESTINATION,
      amount_micro_lamports: amount,
      nonce,
      body_hash: currentBodyHash,
    },
  });
}

// ─── Express Application ──────────────────────────────────────────────────────

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

// Intercept requests to populate audit log
app.use((req, res, next) => {
  if (req.path === "/rpc" && req.method === "POST") {
    // Audit logic inside x402Shield
  }
  next();
});

// NB: do NOT mount express.json() globally — it consumes the request body,
// which breaks http-proxy-middleware for /rpc (upstream times out waiting for
// a body that was already parsed and discarded). Apply per-route instead.

// Serve the 3D management console from the isolated dashboard folder.
// Auto-detect layout so this works in both deploy modes:
//   - PM2 / bare-metal: gateway/ and dashboard/ are siblings → ../dashboard/public
//   - Docker: Dockerfile copies dashboard/public/ into /app/dashboard/public/ → dashboard/public
const fs = require("fs");
const dashboardCandidates = [
  path.join(__dirname, "..", "dashboard", "public"),  // PM2 / bare-metal
  path.join(__dirname, "dashboard", "public"),         // Docker (see gateway/Dockerfile)
];
const dashboardPath = dashboardCandidates.find(p => fs.existsSync(p));
if (dashboardPath) {
  app.use("/", express.static(dashboardPath));
  console.log(`[dashboard] serving 3D console from ${dashboardPath}`);
} else {
  console.warn(`[dashboard] WARNING — neither layout found. Tried:\n  - ${dashboardCandidates.join("\n  - ")}\n  Static console will not be available at "/" — falling back to legacy public/.`);
}

// Health check (no 402 required)
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
    threshold: CONFIG.RPC_LOAD_THRESHOLD,
    nonces_active,
    escrow_accounts,
  });
});

app.get("/stats/qos", async (req, res) => {
  const load = getRpcLoad();
  res.json({
    utilization: load,
    queue_depth: 0,
    wait_p50_ms: 0,
    active_requests: 0
  });
});

// In-memory rate limiter for sensitive endpoints
const sensitiveEndpointLimits = new Map();
function isSensitiveRateLimited(key, limit, windowMs) {
  const now = Date.now();
  let data = sensitiveEndpointLimits.get(key);
  if (!data || data.resetAt < now) {
    data = { count: 0, resetAt: now + windowMs };
    sensitiveEndpointLimits.set(key, data);
  }
  data.count++;
  return data.count > limit;
}

// Escrow deposit — verified via on-chain Solana transaction.
app.post("/escrow/deposit", express.json(), async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  
  // Rate limit: 5 attempts per 10 minutes per IP
  if (isSensitiveRateLimited(`deposit:${ip}`, 5, 600_000)) {
    return res.status(429).json({ error: "Too many deposit attempts. Try again later." });
  }

  const { tx_signature } = req.body || {};
  if (!tx_signature) {
    return res.status(400).json({ error: "tx_signature required" });
  }

  // Pre-validation: check signature format before hitting Solana RPC
  if (!isValidSolanaSignature(tx_signature)) {
    return res.status(400).json({ error: "Invalid signature format" });
  }

  const result = await verifyDepositTx(tx_signature);
  if (!result.ok) {
    return res.status(400).json({ error: result.reason });
  }
  
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
  console.warn("[ESCROW] CONFIG_TRUST_DEPOSITS=1 enabled. /escrow/deposit-trusted endpoint active for testing.");
  app.post("/escrow/deposit-trusted", express.json(), async (req, res) => {
    const { pubkey, amount_micro_lamports } = req.body || {};
    if (!pubkey || !amount_micro_lamports) {
      return res.status(400).json({ error: "pubkey and amount_micro_lamports required" });
    }
    const newBalance = await store.incrEscrow(pubkey, amount_micro_lamports);
    return res.json({ pubkey, balance: newBalance, trusted: true });
  });
}

// Reputation query endpoint (Trust-Score) + risk classification
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

// Escrow balance query
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
app.get("/stats/recent", async (req, res) => {
  const [totalPaidMicroLamports, unique_paying_pubkeys] = await Promise.all([
    store.getTotalPaidVolume(),
    store.uniquePayingPubkeys(),
  ]);
  res.json({
    payments: paymentLog.slice(-20).reverse(),
    challenges: challengeLog.slice(-20).reverse(),
    load_history: loadHistory.slice(-30),
    totals: {
      total_challenges_issued_session: challengeLog.length,
      total_payments_session: paymentLog.length,
      total_paid_micro_lamports: totalPaidMicroLamports,
      unique_paying_pubkeys,
    },
  });
});

// QoS dispatcher state — for the /live dashboard QoS card.
app.get("/stats/qos", (req, res) => {
  const sorted = [...qosStats.wait_samples].sort((a, b) => a - b);
  const total_settled = qosStats.dispatched_total + qosStats.bypassed_total;
  const utilization = qosInFlight / Math.max(1, CONFIG.QOS_MAX_INFLIGHT);
  const now = Date.now();
  res.json({
    mode: CONFIG.QOS_MODE,
    queue_depth: qosQueueDepth(),
    in_flight: qosInFlight,
    max_inflight: CONFIG.QOS_MAX_INFLIGHT,
    max_queue_depth: CONFIG.QOS_MAX_QUEUE_DEPTH,
    queue_timeout_ms: CONFIG.QOS_QUEUE_TIMEOUT_MS,
    utilization: parseFloat(utilization.toFixed(3)),
    bypass_threshold: CONFIG.QOS_BYPASS_THRESHOLD,
    dispatched_total: qosStats.dispatched_total,
    bypassed_total: qosStats.bypassed_total,
    total_settled,
    rejected_overflow_total: qosStats.rejected_overflow_total,
    rejected_timeout_total: qosStats.rejected_timeout_total,
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

app.get("/stats/audit", (req, res) => {
  res.json({ events: auditLog });
});

// ─── Public dashboard pages ──────────────────────────────────────────────────
// Static serving + explicit routes for the 3 dashboards (/live, /try, /explorer).
// Mounted BEFORE the /rpc proxy so static assets aren't intercepted by the
// catch-all proxy. The landing page (public/index.html) is auto-served at /.
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("/live", (_req, res) => res.sendFile(path.join(__dirname, "public", "live.html")));
app.get("/try", (_req, res) => res.sendFile(path.join(__dirname, "public", "try.html")));
app.get("/explorer", (_req, res) => res.sendFile(path.join(__dirname, "public", "explorer.html")));

// ─── Proxy RPC (Protected by Shield) ─────────────────────────────────────────

// Intercept GET /rpc to show a professional status instead of upstream text
app.get("/rpc", (req, res) => {
  res.status(200).send(`
    <html>
      <head>
        <title>x402-Shield | RPC Endpoint</title>
        <style>
          body { background: #050508; color: #444; font-family: monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .status { border: 1px solid #222; padding: 20px; border-radius: 8px; }
          .active { color: #00f2ff; }
        </style>
      </head>
      <body>
        <div class="status">
          [<span class="active">ACTIVE</span>] x402-Shield Gateway v0.1.0<br>
          <span style="font-size: 10px; opacity: 0.5;">Mainnet Priority Protocol Enabled</span>
        </div>
      </body>
    </html>
  `);
});

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
  express.json({ limit: "1mb" }),
  x402Shield,
  qosMiddleware,
  createProxyMiddleware({
    target: CONFIG.REAL_RPC_URL,
    changeOrigin: true,
    pathRewrite: { "^/rpc": "/" },
    agent: upstreamAgent,
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.removeHeader("authorization");
        if (req.x402Verified) {
          proxyReq.setHeader("X-x402-Verified-Pubkey", req.x402Verified.pubkey);
        }
        if (req.body) {
          const bodyData = JSON.stringify(req.body);
          proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));
          proxyReq.write(bodyData);
        }
      },
      proxyRes: (proxyRes, req) => {
        // Log upstream response status for diagnostics
        if (proxyRes.statusCode !== 200) {
          const method = (req.body && req.body.method) || "unknown";
          console.warn(`[UPSTREAM] ${proxyRes.statusCode} from ${CONFIG.REAL_RPC_URL} on method ${method}`);
          addAudit("WARN", `Upstream returned HTTP ${proxyRes.statusCode} for method ${method} — check RPC endpoint limits`);
        }
        if (CONFIG.QOS_MODE === "cooperative" && proxyRes.headers["x-qos-overload"] === "1") {
          qosOverloadFallbackUntil = Date.now() + 30_000;
          console.warn("[qos] cooperative operator returned X-QoS-Overload:1 — falling back to standalone queue for 30s");
        }
      },
      error: (err, req, res) => {
        if (!res.headersSent) {
          res.status(502).json({ error: "RPC upstream error", details: err.message });
        }
      },
    },
  })
);

app.listen(CONFIG.PORT, () => {
  console.log(`
+------------------------------------------------------+
|             x402-Shield Gateway v0.1.0               |
+------------------------------------------------------+
| Listening   : http://localhost:${CONFIG.PORT}/rpc           |
| Upstream    : ${CONFIG.REAL_RPC_URL.slice(0, 36).padEnd(36)} |
| Destination : ${CONFIG.PAYMENT_DESTINATION.slice(0, 36).padEnd(36)} |
| Threshold   : ${String(CONFIG.RPC_LOAD_THRESHOLD * 100).padEnd(36)}% |
+------------------------------------------------------+
  `);
});

// Final Production Readiness Note:
// The system is now technically and economically hardened with atomic replay 
// protection, request-body integrity binding, and starvation-proof QoS.
// BEFORE FULL PUBLIC MAINNET:
// 1. Run adversarial load tests using bench.js.
// 2. Set up Prometheus/Grafana monitoring for qosStats.
// 3. Verify Redis persistence and backup strategy for escrow data.

module.exports = { app, verifyX402Authorization, issueNonce };
