/**
 * broker/store.js
 *
 * In-memory store for the Trust-Score Broker MVP. Restart = empty.
 *
 * Persistence layer (Postgres + Redis + audit log) lands in WS-C parte 2;
 * the helpers here are the seam those backends will replace. Keep callers
 * away from the raw Maps so the swap is mechanical.
 *
 * Bounds (to keep MVP RAM predictable):
 *   - per-pubkey attestation log capped at MAX_ATTESTATIONS_PER_PUBKEY
 *   - per-pubkey report log capped at MAX_REPORTS_PER_PUBKEY
 * Oldest entries get dropped when caps are exceeded.
 */

const MAX_ATTESTATIONS_PER_PUBKEY = 1000;
const MAX_REPORTS_PER_PUBKEY = 200;

// id → { id, pubkey, tier, registeredAt, status }
const providers = new Map();

// pubkey → Array<{ ts, amount, tx_signature, provider_id }>
const attestationsByPubkey = new Map();

// pubkey → Array<{ ts, provider_id, category, evidence }>
const reportsByPubkey = new Map();

// global de-dup for /attest idempotency
const seenTxSignatures = new Set();

// ─── Providers ───────────────────────────────────────────────────────────────

function registerProvider(id, pubkey, tier = "alpha") {
  if (!id || !pubkey) throw new Error("registerProvider: id and pubkey required");
  if (!["alpha", "beta", "production"].includes(tier)) {
    throw new Error(`registerProvider: invalid tier "${tier}"`);
  }
  const entry = {
    id,
    pubkey,
    tier,
    registeredAt: Date.now(),
    status: "active",
  };
  providers.set(id, entry);
  return entry;
}

function getProvider(id) {
  return providers.get(id) || null;
}

function listProviders() {
  return Array.from(providers.values());
}

function providersCount() {
  return providers.size;
}

// ─── Attestations ────────────────────────────────────────────────────────────

function hasSeenTx(tx_signature) {
  return seenTxSignatures.has(tx_signature);
}

/**
 * Append an attestation. Returns true if recorded, false if duplicate
 * tx_signature (already-seen → caller treats as idempotent hit).
 */
function recordAttestation({ pubkey, amount, tx_signature, provider_id, ts }) {
  if (seenTxSignatures.has(tx_signature)) return false;
  seenTxSignatures.add(tx_signature);

  const list = attestationsByPubkey.get(pubkey) || [];
  list.push({ ts, amount, tx_signature, provider_id });
  // Keep most-recent N. Drop oldest if over cap.
  if (list.length > MAX_ATTESTATIONS_PER_PUBKEY) {
    list.splice(0, list.length - MAX_ATTESTATIONS_PER_PUBKEY);
  }
  attestationsByPubkey.set(pubkey, list);
  return true;
}

/**
 * Returns most-recent-first array of attestations, in the shape
 * `lib/trust-score.js` consumes (uses `operator_id` not `provider_id`).
 */
function getAttestations(pubkey) {
  const list = attestationsByPubkey.get(pubkey) || [];
  // Most-recent-first + key-rename to match trust-score.js contract.
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    out.push({ ts: a.ts, amount: a.amount, operator_id: a.provider_id });
  }
  return out;
}

// ─── Reports ─────────────────────────────────────────────────────────────────

function recordReport({ pubkey, provider_id, category, evidence, ts }) {
  const list = reportsByPubkey.get(pubkey) || [];
  list.push({ ts, provider_id, category, evidence });
  if (list.length > MAX_REPORTS_PER_PUBKEY) {
    list.splice(0, list.length - MAX_REPORTS_PER_PUBKEY);
  }
  reportsByPubkey.set(pubkey, list);
  return true;
}

function getReports(pubkey) {
  return (reportsByPubkey.get(pubkey) || []).slice();
}

function reportsCount(pubkey) {
  return (reportsByPubkey.get(pubkey) || []).length;
}

// ─── Reputation aggregate ────────────────────────────────────────────────────

/**
 * Build the legacy-shape reputation object that `lib/trust-score.js` expects:
 *   { paidCount, firstPaidAt, lastPaidAt, totalPaid } | null
 *
 * Returns null when the pubkey has never been attested.
 */
function getReputationAggregate(pubkey) {
  const list = attestationsByPubkey.get(pubkey);
  if (!list || list.length === 0) return null;

  let paidCount = 0;
  let totalPaid = 0;
  let firstPaidAt = Infinity;
  let lastPaidAt = 0;
  for (const a of list) {
    paidCount += 1;
    totalPaid += a.amount || 0;
    if (a.ts < firstPaidAt) firstPaidAt = a.ts;
    if (a.ts > lastPaidAt) lastPaidAt = a.ts;
  }
  return { paidCount, firstPaidAt, lastPaidAt, totalPaid };
}

// ─── Test/dev reset (used by integration tests later) ────────────────────────

function _resetAll() {
  providers.clear();
  attestationsByPubkey.clear();
  reportsByPubkey.clear();
  seenTxSignatures.clear();
}

module.exports = {
  registerProvider,
  getProvider,
  listProviders,
  providersCount,
  hasSeenTx,
  recordAttestation,
  getAttestations,
  recordReport,
  getReports,
  reportsCount,
  getReputationAggregate,
  _resetAll,
  _caps: { MAX_ATTESTATIONS_PER_PUBKEY, MAX_REPORTS_PER_PUBKEY },
};
