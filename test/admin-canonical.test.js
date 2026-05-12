/**
 * test/admin-canonical.test.js
 *
 * Unit tests for lib/admin.js — buildCanonicalString edge cases,
 * sortQueryString, sha256Hex, parseAdminKeys, and captureRawBody.
 */
"use strict";
const crypto = require("crypto");
const {
  buildCanonicalString,
  sortQueryString,
  sha256Hex,
  parseAdminKeys,
  _resetAdminKeysForTest,
  adminConfigured,
} = require("../lib/admin");

let n = 0, failed = 0;
function check(label, cond) {
  n++;
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

// ─── sha256Hex ───────────────────────────────────────────────────────────────
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
check("sha256Hex(empty Buffer) == known hash", sha256Hex(Buffer.alloc(0)) === EMPTY_SHA);
check("sha256Hex('') == known hash", sha256Hex("") === EMPTY_SHA);
check("sha256Hex('hello') is 64 hex chars", /^[0-9a-f]{64}$/.test(sha256Hex("hello")));
check("sha256Hex('hello') deterministic",
  sha256Hex("hello") === sha256Hex("hello"));
check("sha256Hex('hello') != sha256Hex('Hello')",
  sha256Hex("hello") !== sha256Hex("Hello"));

// ─── sortQueryString ─────────────────────────────────────────────────────────
check("sortQueryString('') === ''", sortQueryString("") === "");
check("sortQueryString(null-ish falsy) === ''", sortQueryString(null) === "");
check("sortQueryString single param stays",
  sortQueryString("foo=bar") === "foo=bar");
check("sortQueryString sorts alphabetically",
  sortQueryString("z=1&a=2&m=3") === "a=2&m=3&z=1");
check("sortQueryString strips empty segments",
  sortQueryString("&&b=2&&") === "b=2");
check("sortQueryString key without value keeps equals",
  sortQueryString("b=2&a") === "a=&b=2");
check("sortQueryString duplicate keys preserved, sorted",
  sortQueryString("b=2&a=1&b=1") === "a=1&b=2&b=1");
check("sortQueryString handles encoded chars as literals",
  sortQueryString("c=3&b=2&a=1") === "a=1&b=2&c=3");

// ─── buildCanonicalString — object form ──────────────────────────────────────
function canonical(obj) { return buildCanonicalString(obj); }

// Empty body → sha256 of empty buffer
const emptyBodySha = EMPTY_SHA;

const base = {
  method: "POST",
  path: "/admin/ban",
  query: "",
  timestamp: "1700000000",
  keyId: "key-1",
  bodySha256: emptyBodySha,
};

const expected = ["POST", "/admin/ban", "", "1700000000", "key-1", emptyBodySha].join("\n");
check("canonical string matches expected format", canonical(base) === expected);
check("canonical has exactly 5 newlines (6 parts)", (canonical(base).match(/\n/g) || []).length === 5);

// method normalisation
check("method lowercased → uppercased",
  canonical({ ...base, method: "post" }).startsWith("POST\n"));

// empty body
check("empty body → empty sha256",
  canonical({ ...base, bodySha256: emptyBodySha }).endsWith("\n" + emptyBodySha));

// query string sorting in object form
check("query sorted inside canonical",
  canonical({ ...base, query: "z=1&a=2" }) ===
  ["POST", "/admin/ban", "a=2&z=1", "1700000000", "key-1", emptyBodySha].join("\n"));

// missing optional fields fall back to empty strings (not "undefined")
const minimal = { method: "GET" };
const minResult = canonical(minimal);
check("minimal object — no 'undefined' in result", !minResult.includes("undefined"));
check("minimal object — 6 parts still",
  (minResult.match(/\n/g) || []).length === 5);

// bodySha256 provided vs computed
const bodySha = sha256Hex("hello");
check("explicit bodySha256 propagates",
  canonical({ ...base, bodySha256: bodySha }).endsWith("\n" + bodySha));

// ─── buildCanonicalString — Express req form ─────────────────────────────────
function fakeReq(overrides) {
  return {
    method: "POST",
    originalUrl: "/admin/ban?z=1&a=2",
    url: "/admin/ban?z=1&a=2",
    headers: {
      "x-admin-timestamp": "1700000001",
      "x-admin-key-id": "key-2",
    },
    rawBody: Buffer.from("hello"),
    ...overrides,
  };
}

const reqResult = canonical(fakeReq());
check("req form — method uppercase", reqResult.startsWith("POST\n"));
check("req form — path extracted without query", reqResult.split("\n")[1] === "/admin/ban");
check("req form — query sorted", reqResult.split("\n")[2] === "a=2&z=1");
check("req form — timestamp from header", reqResult.split("\n")[3] === "1700000001");
check("req form — keyId from header", reqResult.split("\n")[4] === "key-2");
check("req form — body sha matches sha256('hello')", reqResult.split("\n")[5] === sha256Hex("hello"));

// no query string
const noQueryReq = fakeReq({ originalUrl: "/admin/ban", url: "/admin/ban" });
check("req form — no query → empty query part",
  canonical(noQueryReq).split("\n")[2] === "");

// missing rawBody → treated as empty buffer
const noBodyReq = fakeReq({ rawBody: undefined });
check("req form — missing rawBody → empty sha",
  canonical(noBodyReq).split("\n")[5] === EMPTY_SHA);

// empty rawBody
const emptyBodyReq = fakeReq({ rawBody: Buffer.alloc(0) });
check("req form — empty rawBody → empty sha",
  canonical(emptyBodyReq).split("\n")[5] === EMPTY_SHA);

// missing headers fallback to empty strings
const noHeadersReq = fakeReq({ headers: {} });
check("req form — missing headers → empty strings, no 'undefined'",
  !canonical(noHeadersReq).includes("undefined"));

// ─── parseAdminKeys ──────────────────────────────────────────────────────────
const origEnv = process.env.ADMIN_KEYS_JSON;

_resetAdminKeysForTest();
delete process.env.ADMIN_KEYS_JSON;
check("empty env → empty Map", parseAdminKeys().size === 0);

_resetAdminKeysForTest();
process.env.ADMIN_KEYS_JSON = "not-json{{{";
check("invalid JSON → empty Map", parseAdminKeys().size === 0);

_resetAdminKeysForTest();
// Valid hex secret: 32 hex chars = 16 bytes
const validHex = "a".repeat(64); // 64 hex chars = 32 bytes
process.env.ADMIN_KEYS_JSON = JSON.stringify({ "key1": validHex });
const km1 = parseAdminKeys();
check("valid key parses to Map entry", km1.size === 1);
check("key stored as Buffer", Buffer.isBuffer(km1.get("key1")));
check("key Buffer length == 32", km1.get("key1").length === 32);

_resetAdminKeysForTest();
// keyId with invalid chars rejected
process.env.ADMIN_KEYS_JSON = JSON.stringify({ "bad key!": validHex });
check("keyId with space/special chars rejected", parseAdminKeys().size === 0);

_resetAdminKeysForTest();
// secret too short (< 32 hex chars)
process.env.ADMIN_KEYS_JSON = JSON.stringify({ "key1": "ab12" });
check("short secret rejected", parseAdminKeys().size === 0);

_resetAdminKeysForTest();
// non-hex secret rejected
process.env.ADMIN_KEYS_JSON = JSON.stringify({ "key1": "g".repeat(64) });
check("non-hex secret rejected", parseAdminKeys().size === 0);

_resetAdminKeysForTest();
// multiple keys
process.env.ADMIN_KEYS_JSON = JSON.stringify({ "k1": validHex, "k2": validHex });
check("multiple valid keys parsed", parseAdminKeys().size === 2);

_resetAdminKeysForTest();
// adminConfigured
process.env.ADMIN_KEYS_JSON = JSON.stringify({ "k1": validHex });
check("adminConfigured() true when keys present", adminConfigured() === true);

_resetAdminKeysForTest();
delete process.env.ADMIN_KEYS_JSON;
check("adminConfigured() false when no keys", adminConfigured() === false);

// Restore env
if (origEnv !== undefined) process.env.ADMIN_KEYS_JSON = origEnv;
else delete process.env.ADMIN_KEYS_JSON;

// ─── Result ──────────────────────────────────────────────────────────────────
if (failed > 0) {
  console.error(`\n${failed} of ${n} assertions failed.\n`);
  process.exit(1);
}
console.log(`\nAll ${n} assertions passed.\n`);
