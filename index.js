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

const app = express();

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
