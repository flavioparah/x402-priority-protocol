"use strict";
/**
 * test/admin-hmac.test.js
 *
 * Pure HMAC validation against an isolated Express mini-server.
 * Every assertion is fast and side-effect-free (no real Redis, no index.js).
 *
 * Run: node test/admin-hmac.test.js
 */

const { strict: assert } = require("assert");
const crypto = require("crypto");
const express = require("express");

const SECRET_HEX = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
process.env.ADMIN_KEYS_JSON = JSON.stringify({ "ops-test-001": SECRET_HEX });

const {
  parseAdminKeys, _resetAdminKeysForTest, captureRawBody, verifyAdminAuth,
  buildCanonicalString, sortQueryString,
} = require("../lib/admin");

_resetAdminKeysForTest();
const keys = parseAdminKeys();
assert.equal(keys.size, 1);
assert.ok(Buffer.isBuffer(keys.get("ops-test-001")));

// ── Build a sign function used by every test below ───────────────────────────
function sign({ method, path, query = "", body = "", ts, keyId = "ops-test-001" }) {
  const sortedQuery = sortQueryString(query);
  const bodySha = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [method, path, sortedQuery, String(ts), keyId, bodySha].join("\n");
  const sig = crypto
    .createHmac("sha256", Buffer.from(SECRET_HEX, "hex"))
    .update(canonical)
    .digest("hex");
  return { sig, canonical };
}

// ── Spawn isolated mini-app ──────────────────────────────────────────────────
const app = express();
app.use("/admin", captureRawBody, verifyAdminAuth, (req, res) =>
  res.json({ ok: true, path: req.path, body: req.rawBody?.toString() })
);
const server = app.listen(0);
const PORT = server.address().port;
const url = p => `http://127.0.0.1:${PORT}${p}`;

(async () => {
  let asserts = 0;
  function ok(label, c) {
    asserts++;
    if (!c) { console.error(`  ✗ ${label}`); process.exitCode = 1; }
    else { console.log(`  ✓ ${label}`); }
  }

  // 1. Valid GET, no body, no query
  {
    const ts = Math.floor(Date.now() / 1000);
    const { sig } = sign({ method: "GET", path: "/admin/abuse-log", ts });
    const r = await fetch(url("/admin/abuse-log"), {
      headers: {
        "X-Admin-Key-Id": "ops-test-001",
        "X-Admin-Timestamp": String(ts),
        "X-Admin-Auth": sig,
      },
    });
    ok("valid GET no body returns 200", r.status === 200);
    ok("adminKeyId set (ok: true)", (await r.json()).ok === true);
  }

  // 2. Replay >60s → 401 expired
  {
    const ts = Math.floor(Date.now() / 1000) - 120;
    const { sig } = sign({ method: "GET", path: "/admin/abuse-log", ts });
    const r = await fetch(url("/admin/abuse-log"), {
      headers: {
        "X-Admin-Key-Id": "ops-test-001",
        "X-Admin-Timestamp": String(ts),
        "X-Admin-Auth": sig,
      },
    });
    ok("replay >60s returns 401", r.status === 401);
    ok("X-Admin-Status: expired", r.headers.get("x-admin-status") === "expired");
  }

  // 3. Unknown key_id → 401 unknown_key
  {
    const ts = Math.floor(Date.now() / 1000);
    const r = await fetch(url("/admin/abuse-log"), {
      headers: {
        "X-Admin-Key-Id": "ghost",
        "X-Admin-Timestamp": String(ts),
        "X-Admin-Auth": "deadbeef".repeat(8),
      },
    });
    ok("unknown key_id returns 401", r.status === 401);
    ok("X-Admin-Status: unknown_key", r.headers.get("x-admin-status") === "unknown_key");
  }

  // 4. Tampered body → 401 invalid_signature
  {
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ key: "abc", type: "ip", tier: 3, reason: "ok" });
    const { sig } = sign({ method: "POST", path: "/admin/ban", body, ts });
    const r = await fetch(url("/admin/ban"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key-Id": "ops-test-001",
        "X-Admin-Timestamp": String(ts),
        "X-Admin-Auth": sig,
      },
      body: body + " /* mutated */",
    });
    ok("tampered body returns 401", r.status === 401);
    ok("X-Admin-Status: invalid_signature on tamper",
      r.headers.get("x-admin-status") === "invalid_signature");
  }

  // 5. Query order does NOT matter (sorted canonicalization)
  {
    const ts = Math.floor(Date.now() / 1000);
    const sortedQuery = "limit=10&since=100&type=ip";
    const bodySha = crypto.createHash("sha256").update("").digest("hex");
    const canonical = ["GET", "/admin/abuse-log", sortedQuery, String(ts), "ops-test-001", bodySha].join("\n");
    const sig = crypto
      .createHmac("sha256", Buffer.from(SECRET_HEX, "hex"))
      .update(canonical)
      .digest("hex");
    // Client sends query in scrambled order — server must sort before HMAC
    const r = await fetch(url("/admin/abuse-log?type=ip&limit=10&since=100"), {
      headers: {
        "X-Admin-Key-Id": "ops-test-001",
        "X-Admin-Timestamp": String(ts),
        "X-Admin-Auth": sig,
      },
    });
    ok("scrambled query order accepted (sort canonical)", r.status === 200);
  }

  // 6. Missing headers → 401 missing_admin_headers
  {
    const r = await fetch(url("/admin/abuse-log"));
    ok("missing all headers returns 401", r.status === 401);
    ok("X-Admin-Status: missing_headers",
      r.headers.get("x-admin-status") === "missing_headers");
  }

  // 7. Canonical string format invariants
  {
    const cs = buildCanonicalString({
      method: "POST",
      originalUrl: "/admin/ban?b=2&a=1",
      headers: { "x-admin-timestamp": "100", "x-admin-key-id": "ops" },
      rawBody: Buffer.from("hello"),
    });
    const lines = cs.split("\n");
    ok("canonical string has 6 lines", lines.length === 6);
    ok("method uppercased", lines[0] === "POST");
    ok("path stripped of query", lines[1] === "/admin/ban");
    ok("query sorted", lines[2] === "a=1&b=2");
    ok("body sha256 of 'hello' is correct",
      lines[5] === crypto.createHash("sha256").update("hello").digest("hex"));
  }

  console.log(`\n${asserts} assertions ran.`);
  server.close();
})();
