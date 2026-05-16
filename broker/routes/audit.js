/**
 * GET /audit/:date — public audit log for a UTC day.
 *
 * BROKER-GOVERNANCE.md §6: the broker operator commits to a queryable audit
 * log of every /attest and /report event, including the provider_signature
 * over the canonical payload. Anyone can replay events and re-verify the
 * signatures against the on-/info-listed provider pubkeys — the broker's
 * "neutrality" claim is only credible because of this transparency seam.
 *
 * Read-only, no auth — that's the whole point.
 *
 * Path:
 *   GET /audit/:date          where date is YYYY-MM-DD (UTC)
 *
 * Query:
 *   cursor  (opaque, optional)        — ts of last event returned (page key)
 *   limit   (1..500, default 100)     — page size
 *   type    ("attest"|"report"|omit)  — filter
 *
 * Response: { date, events[], next_cursor, total_events_for_date }
 *
 * Pagination cursor is the `ts` of the last returned event. The next page
 * starts strictly after that ts. Caveat: if two events share an identical
 * `ts` AND fall on the page boundary, the sibling at the same ts is skipped.
 * Acceptable for the in-memory MVP (low collision risk under capped per-pubkey
 * arrays); a Postgres-backed version would use an autoincrement sequence as
 * a secondary key.
 */

const express = require("express");
const router = express.Router();

const store = require("../store");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TYPES = ["attest", "report"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function isValidUtcDate(date) {
  if (!DATE_RE.test(date)) return false;
  const ms = Date.parse(date + "T00:00:00Z");
  if (isNaN(ms)) return false;
  // Reject coerced values like "2026-13-45" — round-trip must match.
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}` === date;
}

router.get("/audit/:date", (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: "invalid date format; expected YYYY-MM-DD" });
  }
  if (!isValidUtcDate(date)) {
    return res.status(400).json({ error: "invalid date" });
  }

  const limitRaw = req.query.limit;
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : parseInt(limitRaw, 10);
  if (isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
    return res.status(400).json({ error: `limit must be in [1, ${MAX_LIMIT}]` });
  }

  const type = req.query.type;
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${VALID_TYPES.join(",")}` });
  }

  let afterTs = 0;
  if (req.query.cursor !== undefined && req.query.cursor !== "") {
    afterTs = parseInt(req.query.cursor, 10);
    if (isNaN(afterTs)) {
      return res.status(400).json({ error: "invalid cursor" });
    }
  }

  const { events, total, hasMore } = store.getAuditEvents(date, { type, afterTs, limit });
  const next_cursor =
    hasMore && events.length > 0 ? String(events[events.length - 1].ts) : null;

  return res.status(200).json({
    date,
    events,
    next_cursor,
    total_events_for_date: total,
  });
});

module.exports = router;
