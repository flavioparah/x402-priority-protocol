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

/** @type {Map<string, { amount: number, destination: string, expiresAt: number, used: boolean }>} */
const nonceStore = new Map();

/** @type {Map<string, number>} escrow balance per pubkey (in µL = lamports × 1000) */
const escrowBalances = new Map();

/**
 * Anti-double-spend: every Solana tx signature that already credited escrow
 * is recorded here. Replays are rejected.
 *
 * @type {Set<string>}
 */
const usedDepositSignatures = new Set();

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

/**
 * Trust-Score ledger (Week-2 feature): tracks every successful payment
 * per pubkey. Score grows linearly with paid-count up to 100.
 *
 * The discount a scored agent receives on a 402 challenge is applied BEFORE
 * the client signs, so the signed amount matches the discounted price. We
 * then require the signer's pubkey to equal the hinted pubkey (set via the
 * X-x402-Agent-Pubkey request header) — otherwise Alice could claim Bob's
 * score, get his price, then sign with her own key.
 *
 * @type {Map<string, { paidCount: number, firstPaidAt: number, lastPaidAt: number, totalPaid: number }>}
 */
const reputation = new Map();

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
 * Sliding-window stats exposed via /stats/* for the public dashboards.
 * In-memory only (lost on restart). Cap to keep RAM bounded.
 */
/** @type {Array<{ts:number, pubkeyHint:string|null, basePrice:number, finalPrice:number, load:number}>} */
const challengeLog = [];
/** @type {Array<{ts:number, pubkey:string, amount:number, score:number}>} */
const paymentLog = [];
/** @type {Array<{ts:number, load:number, rps:number}>} */
const loadHistory = [];

// ─── QoS Path A — standalone priority queue + dispatcher ──────────────────────
// Each entry: { req, res, next, score, enqueuedAt, timeoutId }
/** @type {Array<{req:any, res:any, next:Function, score:number, enqueuedAt:number, timeoutId:any}>} */
const qosQueue = [];
let qosInFlight = 0;
const qosStats = {
  dispatched_total: 0,
  bypassed_total: 0,
  rejected_overflow_total: 0,
  rejected_timeout_total: 0,
  wait_samples: [],  // last 200 wait times in ms (only for queued requests)
};

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

function qosMiddleware(req, res, next) {
  if (CONFIG.QOS_MODE === "off") return next();

  // Cooperative mode: don't queue locally; forward priority hint to operator.
  // (Reference implementation; activates when operator partner integrates.)
  if (CONFIG.QOS_MODE === "cooperative") {
    req.headers["x-priority-score"] = String(qosBaseScore(req));
    req.headers["x-qos-spec-version"] = "1";
    return next();
  }

  // Standalone mode: bypass when low contention (preserves the 8.7ms p95).
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

  // High contention: queue with overflow protection.
  if (qosQueue.length >= CONFIG.QOS_MAX_QUEUE_DEPTH) {
    qosStats.rejected_overflow_total++;
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
      qosStats.rejected_timeout_total++;
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
function getTrustScore(pubkeyB58) {
  const rec = reputation.get(pubkeyB58);
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
  if (usedDepositSignatures.has(signature)) {
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
  usedDepositSignatures.add(signature);

  const prior = escrowBalances.get(crediting.source) || 0;
  escrowBalances.set(crediting.source, prior + microLamports);

  return {
    ok: true,
    pubkey: crediting.source,
    lamports: crediting.lamports,
    micro_lamports: microLamports,
    balance: prior + microLamports,
    signature,
    slot: tx.slot,
  };
}

/** Record a successful payment against a pubkey's reputation. */
function recordPayment(pubkeyB58, amount) {
  const now = Date.now();
  const rec = reputation.get(pubkeyB58) || { paidCount: 0, firstPaidAt: now, lastPaidAt: now, totalPaid: 0 };
  rec.paidCount += 1;
  rec.lastPaidAt = now;
  rec.totalPaid += amount;
  reputation.set(pubkeyB58, rec);

  paymentLog.push({ ts: now, pubkey: pubkeyB58, amount, score: getTrustScore(pubkeyB58) });
  if (paymentLog.length > 100) paymentLog.shift();
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
function issueNonce(amount, hintedPubkey) {
  const nonce = crypto.randomBytes(16).toString("hex");
  nonceStore.set(nonce, {
    amount,
    destination: CONFIG.PAYMENT_DESTINATION,
    expiresAt: Date.now() + CONFIG.NONCE_TTL_MS,
    used: false,
    hintedPubkey: hintedPubkey || null,
  });
  return nonce;
}

/** Limpa nonces expirados periodicamente. */
function pruneExpiredNonces() {
  const now = Date.now();
  for (const [nonce, data] of nonceStore) {
    if (data.expiresAt < now) nonceStore.delete(nonce);
  }
}
setInterval(pruneExpiredNonces, CONFIG.NONCE_TTL_MS);

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

// ─── Verificação de assinatura (MVP off-chain) ────────────────────────────────

/**
 * Valida o cabeçalho Authorization: x402 <payload_base58>
 *
 * payload decodificado = JSON.stringify({ nonce, pubkey, amount, destination })
 * assinado com a chave Ed25519 do agente
 *
 * Formato esperado: "x402 <base58(signature)>.<base58(pubkey)>.<base58(message)>"
 */
function verifyX402Authorization(authHeader) {
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

    // Valida o nonce
    const nonceData = nonceStore.get(nonce);
    if (!nonceData) return { ok: false, reason: "Unknown or expired nonce" };
    if (nonceData.used) return { ok: false, reason: "Nonce already used (replay detected)" };
    if (Date.now() > nonceData.expiresAt) return { ok: false, reason: "Nonce expired" };
    if (amount < nonceData.amount) return { ok: false, reason: `Insufficient payment: need ${nonceData.amount}, got ${amount}` };

    // If this challenge was discounted via a Trust-Score hint, the signer
    // must be the same pubkey that was hinted. Otherwise the discount is
    // spoofable (see issueNonce docstring).
    if (nonceData.hintedPubkey && nonceData.hintedPubkey !== pubkeyB58) {
      return { ok: false, reason: "Signer pubkey does not match the hinted pubkey for this challenge" };
    }

    // Verifica saldo no escrow (MVP)
    const balance = escrowBalances.get(pubkeyB58) || 0;
    if (balance < amount) return { ok: false, reason: `Insufficient escrow balance: ${balance} < ${amount}` };

    // Marca nonce como usado e debita saldo
    nonceData.used = true;
    escrowBalances.set(pubkeyB58, balance - amount);

    // Credit reputation so subsequent challenges for this pubkey are cheaper
    recordPayment(pubkeyB58, amount);

    return { ok: true, pubkey: pubkeyB58, amount, nonce, score: getTrustScore(pubkeyB58) };
  } catch (err) {
    return { ok: false, reason: `Verification error: ${err.message}` };
  }
}

// ─── Middleware principal: x402 Rate Limiter + Challenger ─────────────────────

function x402Shield(req, res, next) {
  recordRequest();
  const ip = req.ip || req.socket.remoteAddress;
  const load = getRpcLoad();
  const challenged = load > CONFIG.RPC_LOAD_THRESHOLD || isRateLimited(ip);

  if (!challenged) return next();

  // Verifica se o agente já enviou uma prova de pagamento válida
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const result = verifyX402Authorization(authHeader);
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
  const trustScore = hintedPubkey ? getTrustScore(hintedPubkey) : 0;
  const basePrice = calcDynamicPrice(load);
  const amount = applyTrustDiscount(basePrice, trustScore);
  const nonce = issueNonce(amount, hintedPubkey);

  challengeLog.push({
    ts: Date.now(),
    pubkeyHint: hintedPubkey || null,
    basePrice,
    finalPrice: amount,
    load: parseFloat(load.toFixed(3)),
  });
  if (challengeLog.length > 100) challengeLog.shift();

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
app.get("/health", (req, res) => {
  pruneRequestTimestamps();
  const rps = requestTimestamps.length / (CONFIG.LOAD_WINDOW_MS / 1000);
  res.json({
    status: "ok",
    load: getRpcLoad().toFixed(2),
    rps: rps.toFixed(2),
    max_rps: CONFIG.MAX_RPS,
    load_forced: CONFIG.RPC_LOAD_FORCE !== null,
    threshold: CONFIG.RPC_LOAD_THRESHOLD,
    nonces_active: nonceStore.size,
    escrow_accounts: escrowBalances.size,
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
  app.post("/escrow/deposit-trusted", express.json(), (req, res) => {
    const { pubkey, amount_micro_lamports } = req.body || {};
    if (!pubkey || !amount_micro_lamports) {
      return res.status(400).json({ error: "pubkey and amount_micro_lamports required" });
    }
    const current = escrowBalances.get(pubkey) || 0;
    escrowBalances.set(pubkey, current + amount_micro_lamports);
    return res.json({ pubkey, balance: escrowBalances.get(pubkey), trusted: true });
  });
}

// Endpoint de consulta de reputação (Trust-Score)
app.get("/reputation/:pubkey", (req, res) => {
  const pubkey = req.params.pubkey;
  const rec = reputation.get(pubkey);
  const score = getTrustScore(pubkey);
  const nextDiscountPrice = applyTrustDiscount(CONFIG.MAX_PRICE_MICRO_LAMPORTS, score);
  res.json({
    pubkey,
    trust_score: score,
    paid_count: rec ? rec.paidCount : 0,
    total_paid_micro_lamports: rec ? rec.totalPaid : 0,
    first_paid_at: rec ? rec.firstPaidAt : null,
    last_paid_at: rec ? rec.lastPaidAt : null,
    current_discount_percent: score / 2,
    example_price_at_max_load: nextDiscountPrice,
  });
});

// Endpoint de consulta de saldo
app.get("/escrow/balance/:pubkey", (req, res) => {
  const balance = escrowBalances.get(req.params.pubkey) || 0;
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
app.get("/stats/recent", (req, res) => {
  const totalPaidMicroLamports = [...reputation.values()].reduce((s, r) => s + r.totalPaid, 0);
  res.json({
    payments: paymentLog.slice(-20).reverse(),
    challenges: challengeLog.slice(-20).reverse(),
    load_history: loadHistory.slice(-30),
    totals: {
      total_challenges_issued_session: challengeLog.length,
      total_payments_session: paymentLog.length,
      total_paid_micro_lamports: totalPaidMicroLamports,
      unique_paying_pubkeys: reputation.size,
    },
  });
});

// QoS dispatcher state — for the /live dashboard QoS card.
app.get("/stats/qos", (req, res) => {
  const sorted = [...qosStats.wait_samples].sort((a, b) => a - b);
  const total_settled = qosStats.dispatched_total + qosStats.bypassed_total;
  const utilization = qosInFlight / Math.max(1, CONFIG.QOS_MAX_INFLIGHT);
  res.json({
    mode: CONFIG.QOS_MODE,
    queue_depth: qosQueue.length,
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
  });
});

// Top 10 by Trust-Score for the leaderboard widget.
app.get("/stats/leaderboard", (req, res) => {
  const top = [...reputation.entries()]
    .map(([pubkey, rec]) => ({
      pubkey,
      trust_score: getTrustScore(pubkey),
      paid_count: rec.paidCount,
      total_paid_micro_lamports: rec.totalPaid,
      last_paid_at: rec.lastPaidAt,
    }))
    .sort((a, b) => b.trust_score - a.trust_score || b.paid_count - a.paid_count)
    .slice(0, 10);
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
    on: {
      proxyReq: (proxyReq, req) => {
        // Remove o cabeçalho x402 antes de encaminhar ao RPC real
        proxyReq.removeHeader("authorization");
        if (req.x402Verified) {
          proxyReq.setHeader("X-x402-Verified-Pubkey", req.x402Verified.pubkey);
        }
      },
      error: (err, req, res) => {
        res.status(502).json({ error: "RPC upstream error", details: err.message });
      },
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
