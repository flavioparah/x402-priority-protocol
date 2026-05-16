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

// pubkey → Array<{ ts, amount, tx_signature, provider_id, provider_signature }>
const attestationsByPubkey = new Map();

// pubkey → Array<{ ts, provider_id, category, evidence, provider_signature }>
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

/**
 * Mutate the `status` field of a provider in place.
 * Returns the updated provider, or null if the id is unknown.
 * Valid status values are not enforced here — admin route gates them.
 */
function setProviderStatus(id, status) {
  const p = providers.get(id);
  if (!p) return null;
  p.status = status;
  return p;
}

/**
 * Mutate the `tier` field of a provider in place.
 * Returns the updated provider, or null if the id is unknown.
 * Tier validity is enforced by the caller (admin route).
 */
function setProviderTier(id, tier) {
  const p = providers.get(id);
  if (!p) return null;
  p.tier = tier;
  return p;
}

/**
 * Count attestations recorded by this provider across all pubkeys in the
 * last 30 days. O(total attestations) scan — fine for MVP (caps keep it bounded).
 * Returns 0 for unknown providers / providers with no attestations.
 */
function getProviderAttestedCount30d(id) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const list of attestationsByPubkey.values()) {
    for (const a of list) {
      if (a.provider_id === id && a.ts >= cutoff) count++;
    }
  }
  return count;
}

/**
 * Most-recent attestation timestamp recorded by this provider across all
 * pubkeys, or null if the provider has never attested.
 */
function getProviderLastAttestAt(id) {
  let latest = null;
  for (const list of attestationsByPubkey.values()) {
    for (const a of list) {
      if (a.provider_id === id && (latest === null || a.ts > latest)) {
        latest = a.ts;
      }
    }
  }
  return latest;
}

// ─── Attestations ────────────────────────────────────────────────────────────

function hasSeenTx(tx_signature) {
  return seenTxSignatures.has(tx_signature);
}

/**
 * Append an attestation. Returns true if recorded, false if duplicate
 * tx_signature (already-seen → caller treats as idempotent hit).
 */
function recordAttestation({ pubkey, amount, tx_signature, provider_id, ts, provider_signature }) {
  if (seenTxSignatures.has(tx_signature)) return false;
  seenTxSignatures.add(tx_signature);

  const list = attestationsByPubkey.get(pubkey) || [];
  list.push({ ts, amount, tx_signature, provider_id, provider_signature: provider_signature || null });
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

function recordReport({ pubkey, provider_id, category, evidence, ts, provider_signature }) {
  const list = reportsByPubkey.get(pubkey) || [];
  list.push({ ts, provider_id, category, evidence, provider_signature: provider_signature || null });
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

// ─── Audit (cross-pubkey) ────────────────────────────────────────────────────

/**
 * Parse a "YYYY-MM-DD" UTC date string into [startMs, endMs) bounds.
 * Returns null for invalid input. endMs is exclusive (midnight UTC of next day).
 */
function _parseUtcDateBounds(dateUtc) {
  if (typeof dateUtc !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) return null;
  const startMs = Date.parse(dateUtc + "T00:00:00Z");
  if (isNaN(startMs)) return null;
  // Also reject "2026-13-45" — Date.parse may coerce; double-check round-trip.
  const d = new Date(startMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  if (`${yyyy}-${mm}-${dd}` !== dateUtc) return null;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return [startMs, endMs];
}

/**
 * Retrieve attestations/reports across all pubkeys within a UTC date range.
 * Returns events sorted by ts ascending. Caller paginates via opts.afterTs.
 *
 * Perf: O(total attestations + total reports) scan, since the in-memory layout
 * is keyed by pubkey rather than ts. With MAX_* caps per pubkey this is bounded
 * and fine for MVP. Production Postgres would replace this with an index on
 * (ts, type) and stream rows in O(page_size).
 *
 * Cursor collision caveat: if two events share the exact same `ts` and that
 * boundary is the page edge, the next page (afterTs strictly >) will skip any
 * sibling events at that ts. Acceptable for in-memory MVP — production with
 * Postgres autoincrement sequence avoids this entirely.
 *
 * @param {string} dateUtc - "YYYY-MM-DD"
 * @param {object} [opts]
 * @param {"attest"|"report"} [opts.type] - filter by type; omit for both
 * @param {number} [opts.afterTs=0] - return only events with ts > afterTs (pagination)
 * @param {number} [opts.limit=100]
 * @returns {{events: Array<object>, total: number, hasMore: boolean}} - events page,
 *   total matching for the date, and whether more events exist after the page.
 */
function getAuditEvents(dateUtc, opts = {}) {
  const bounds = _parseUtcDateBounds(dateUtc);
  if (!bounds) return { events: [], total: 0, hasMore: false };
  const [startMs, endMs] = bounds;
  const type = opts.type;
  const afterTs = typeof opts.afterTs === "number" ? opts.afterTs : 0;
  const limit = typeof opts.limit === "number" ? opts.limit : 100;

  const all = [];
  if (type !== "report") {
    for (const [pubkey, list] of attestationsByPubkey.entries()) {
      for (const a of list) {
        if (a.ts >= startMs && a.ts < endMs) {
          all.push({
            type: "attest",
            ts: a.ts,
            pubkey,
            provider_id: a.provider_id,
            amount_micro_lamports: a.amount,
            tx_signature: a.tx_signature,
            provider_signature: a.provider_signature || null,
          });
        }
      }
    }
  }
  if (type !== "attest") {
    for (const [pubkey, list] of reportsByPubkey.entries()) {
      for (const r of list) {
        if (r.ts >= startMs && r.ts < endMs) {
          all.push({
            type: "report",
            ts: r.ts,
            pubkey,
            provider_id: r.provider_id,
            category: r.category,
            evidence: r.evidence,
            provider_signature: r.provider_signature || null,
          });
        }
      }
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  const total = all.length;
  // Slice to events strictly after `afterTs`, then take `limit` + peek one
  // more to know if a next page exists (drives hasMore / next_cursor).
  const eligible = all.filter((e) => e.ts > afterTs);
  const page = eligible.slice(0, limit);
  const hasMore = eligible.length > page.length;
  return { events: page, total, hasMore };
}

/**
 * Count total events for a UTC date (used for total_events_for_date in /audit).
 * Same scan characteristics as getAuditEvents — see that fn's perf note.
 */
function countAuditEventsForDate(dateUtc, opts = {}) {
  const bounds = _parseUtcDateBounds(dateUtc);
  if (!bounds) return 0;
  const [startMs, endMs] = bounds;
  const type = opts.type;
  let n = 0;
  if (type !== "report") {
    for (const list of attestationsByPubkey.values()) {
      for (const a of list) {
        if (a.ts >= startMs && a.ts < endMs) n++;
      }
    }
  }
  if (type !== "attest") {
    for (const list of reportsByPubkey.values()) {
      for (const r of list) {
        if (r.ts >= startMs && r.ts < endMs) n++;
      }
    }
  }
  return n;
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
  setProviderStatus,
  setProviderTier,
  getProviderAttestedCount30d,
  getProviderLastAttestAt,
  hasSeenTx,
  recordAttestation,
  getAttestations,
  recordReport,
  getReports,
  reportsCount,
  getReputationAggregate,
  getAuditEvents,
  countAuditEventsForDate,
  _resetAll,
  _caps: { MAX_ATTESTATIONS_PER_PUBKEY, MAX_REPORTS_PER_PUBKEY },
};
