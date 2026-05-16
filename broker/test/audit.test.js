/**
 * broker/test/audit.test.js
 *
 * Integration tests for GET /audit/:date — the public audit log endpoint that
 * makes the broker's neutrality claim auditable (BROKER-GOVERNANCE.md §6).
 *
 * Covers: validation, empty/future dates, type filter, pagination,
 * chronological sort, and that provider_signature is surfaced for 3rd-party
 * verification.
 *
 * Run: node broker/test/audit.test.js
 */

const http = require("http");
const app = require("../index");
const store = require("../store");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Tiny HTTP client (mirrors integration.test.js) ──────────────────────────

function request(server, opts) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: "127.0.0.1",
      port: addr.port,
      path: opts.path,
      method: opts.method || "GET",
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Date helpers ────────────────────────────────────────────────────────────

function todayUtcStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function utcStartOfTodayMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const PUBKEY_A = "G8KyXwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY6pG";
const PUBKEY_B = "X9LyZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY6pH";
const PROVIDER_ID = "audit-test-op";
const PROVIDER_PUBKEY = "22222222222222222222222222222222";
const SIG_FIXTURE = "bs58-signature-fixture-AAAAAAAAAAAAAAAAAAAAAAAA";

(async () => {
  console.log("\nx402 Trust-Score Broker — /audit endpoint tests\n");

  // Fresh state.
  store._resetAll();
  store.registerProvider(PROVIDER_ID, PROVIDER_PUBKEY, "alpha");

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  try {
    const today = todayUtcStr();
    const startOfDay = utcStartOfTodayMs();

    // ── Validation ────────────────────────────────────────────────────────
    await test("empty date → 200 with events: [] and total 0", async () => {
      const r = await request(server, { path: `/audit/${today}` });
      assertEq(r.status, 200, "status");
      assertEq(r.body.date, today, "date echo");
      assert(Array.isArray(r.body.events), "events is array");
      assertEq(r.body.events.length, 0, "events length");
      assertEq(r.body.total_events_for_date, 0, "total");
      assertEq(r.body.next_cursor, null, "next_cursor");
    });

    await test("future date → 200 with empty events (no error)", async () => {
      const r = await request(server, { path: `/audit/2099-12-31` });
      assertEq(r.status, 200, "status");
      assertEq(r.body.events.length, 0, "no events");
      assertEq(r.body.total_events_for_date, 0, "total");
    });

    await test("invalid date format (not YYYY-MM-DD) → 400", async () => {
      const r = await request(server, { path: `/audit/2026-5-1` });
      assertEq(r.status, 400, "status");
      assert(r.body.error, "error message");
    });

    await test("invalid date (2026-13-45) → 400", async () => {
      const r = await request(server, { path: `/audit/2026-13-45` });
      assertEq(r.status, 400, "status");
      assert(r.body.error, "error message");
    });

    await test("invalid limit (0) → 400", async () => {
      const r = await request(server, { path: `/audit/${today}?limit=0` });
      assertEq(r.status, 400, "status");
    });
    await test("invalid limit (501) → 400", async () => {
      const r = await request(server, { path: `/audit/${today}?limit=501` });
      assertEq(r.status, 400, "status");
    });
    await test("invalid type → 400", async () => {
      const r = await request(server, { path: `/audit/${today}?type=both` });
      assertEq(r.status, 400, "status");
    });
    await test("invalid cursor → 400", async () => {
      const r = await request(server, { path: `/audit/${today}?cursor=not-a-number` });
      assertEq(r.status, 400, "status");
    });

    // ── Seed: 5 attestations + 2 reports, distinct ts, today (UTC) ─────────
    // Use store directly so we can attach a provider_signature (route stack
    // currently does not forward it — see audit.js JSDoc). HTTP path is
    // exercised separately by integration.test.js.
    for (let i = 0; i < 5; i++) {
      store.recordAttestation({
        pubkey: PUBKEY_A,
        amount: 40000 + i,
        tx_signature: `audit-tx-${i}`,
        provider_id: PROVIDER_ID,
        ts: startOfDay + 1000 + i * 60_000, // 1s, 1min apart
        provider_signature: `${SIG_FIXTURE}-a${i}`,
      });
    }
    for (let i = 0; i < 2; i++) {
      store.recordReport({
        pubkey: PUBKEY_B,
        provider_id: PROVIDER_ID,
        category: "spam_burst",
        evidence: `evidence-${i}`,
        ts: startOfDay + 10_000 + i * 60_000,
        provider_signature: `${SIG_FIXTURE}-r${i}`,
      });
    }

    // ── Filtering + ordering ──────────────────────────────────────────────
    await test("today's audit returns all 7 events sorted by ts ascending", async () => {
      const r = await request(server, { path: `/audit/${today}` });
      assertEq(r.status, 200, "status");
      assertEq(r.body.events.length, 7, "event count");
      assertEq(r.body.total_events_for_date, 7, "total");
      // Sorted ascending.
      for (let i = 1; i < r.body.events.length; i++) {
        assert(r.body.events[i].ts >= r.body.events[i - 1].ts, `sorted at i=${i}`);
      }
      assertEq(r.body.next_cursor, null, "next_cursor on last page");
    });

    await test("?type=attest returns 5 attestations only", async () => {
      const r = await request(server, { path: `/audit/${today}?type=attest` });
      assertEq(r.status, 200, "status");
      assertEq(r.body.events.length, 5, "count");
      assertEq(r.body.total_events_for_date, 5, "total");
      for (const e of r.body.events) {
        assertEq(e.type, "attest", "type");
        assert(typeof e.amount_micro_lamports === "number", "amount field");
        assert(typeof e.tx_signature === "string", "tx_signature field");
      }
    });

    await test("?type=report returns 2 reports only", async () => {
      const r = await request(server, { path: `/audit/${today}?type=report` });
      assertEq(r.status, 200, "status");
      assertEq(r.body.events.length, 2, "count");
      assertEq(r.body.total_events_for_date, 2, "total");
      for (const e of r.body.events) {
        assertEq(e.type, "report", "type");
        assert(typeof e.category === "string", "category field");
        assertEq(e.pubkey, PUBKEY_B, "pubkey");
      }
    });

    await test("events include provider_signature for 3rd-party verification", async () => {
      const r = await request(server, { path: `/audit/${today}` });
      const withSig = r.body.events.filter((e) => typeof e.provider_signature === "string" && e.provider_signature.length > 0);
      assertEq(withSig.length, 7, "all 7 events carry provider_signature");
      // Spot-check one attest and one report event.
      const attest = r.body.events.find((e) => e.type === "attest");
      const report = r.body.events.find((e) => e.type === "report");
      assert(attest.provider_signature.startsWith(SIG_FIXTURE), "attest signature shape");
      assert(report.provider_signature.startsWith(SIG_FIXTURE), "report signature shape");
    });

    // ── Pagination: seed 10 attestations on a separate day ────────────────
    const PAG_DATE = "2024-01-15";
    const pagStartMs = Date.parse(PAG_DATE + "T00:00:00Z");
    const PUBKEY_P = "P0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (let i = 0; i < 10; i++) {
      store.recordAttestation({
        pubkey: PUBKEY_P,
        amount: 1000 + i,
        tx_signature: `pag-tx-${i}`,
        provider_id: PROVIDER_ID,
        ts: pagStartMs + 1000 + i * 60_000,
        provider_signature: `${SIG_FIXTURE}-p${i}`,
      });
    }

    let firstPage;
    await test("pagination: limit=5 returns 5 events + next_cursor non-null", async () => {
      const r = await request(server, { path: `/audit/${PAG_DATE}?limit=5` });
      assertEq(r.status, 200, "status");
      assertEq(r.body.events.length, 5, "page size");
      assertEq(r.body.total_events_for_date, 10, "total");
      assert(typeof r.body.next_cursor === "string", "next_cursor present");
      assertEq(r.body.next_cursor, String(r.body.events[4].ts), "cursor = last ts");
      firstPage = r.body;
    });

    await test("pagination: next page returns remaining 5 events + next_cursor null", async () => {
      const r = await request(server, { path: `/audit/${PAG_DATE}?limit=5&cursor=${firstPage.next_cursor}` });
      assertEq(r.status, 200, "status");
      assertEq(r.body.events.length, 5, "remaining 5");
      assertEq(r.body.next_cursor, null, "no more pages");
      // No overlap with first page.
      const firstTs = new Set(firstPage.events.map((e) => e.ts));
      for (const e of r.body.events) {
        assert(!firstTs.has(e.ts), "no overlap with first page");
      }
    });

    await test("HTTP path: empty audit endpoint still returns spec-version header", async () => {
      const r = await request(server, { path: `/audit/${today}` });
      assertEq(r.headers["x-trustscore-spec-version"], "0.2", "spec version header");
    });

  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
