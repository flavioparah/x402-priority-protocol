/**
 * broker/test/canonical-json.test.js
 *
 * Unit tests for broker/lib/canonical-json.js (RFC 8785 JCS subset).
 * Plain Node — no Jest, matches the parent repo's test/detection.test.js pattern.
 *
 * Run: node broker/test/canonical-json.test.js
 */

const { canonicalize } = require("../lib/canonical-json");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  ✓ " + name);
    passed++;
  } catch (e) {
    console.error("  ✗ " + name);
    console.error("    " + e.message);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      (label || "assertEq") +
        ": expected " +
        JSON.stringify(expected) +
        ", got " +
        JSON.stringify(actual)
    );
  }
}

function assertThrows(fn, label) {
  let threw = false;
  try {
    fn();
  } catch (_e) {
    threw = true;
  }
  if (!threw) throw new Error((label || "assertThrows") + ": expected throw");
}

console.log("\ncanonical-json (RFC 8785 subset)\n");

// ─── primitives ──────────────────────────────────────────────────────────────

test("empty object", function () {
  assertEq(canonicalize({}), "{}");
});

test("empty array", function () {
  assertEq(canonicalize([]), "[]");
});

test("null", function () {
  assertEq(canonicalize(null), "null");
});

test("boolean true", function () {
  assertEq(canonicalize(true), "true");
});

test("boolean false", function () {
  assertEq(canonicalize(false), "false");
});

test("integer", function () {
  assertEq(canonicalize(42), "42");
});

test("negative integer", function () {
  assertEq(canonicalize(-7), "-7");
});

test("zero", function () {
  assertEq(canonicalize(0), "0");
});

test("negative zero normalizes to 0", function () {
  assertEq(canonicalize(-0), "0");
});

test("simple float", function () {
  // V8 prints 1.5 as "1.5" per ECMA-262.
  assertEq(canonicalize(1.5), "1.5");
});

test("plain string", function () {
  assertEq(canonicalize("hello"), '"hello"');
});

// ─── key ordering ────────────────────────────────────────────────────────────

test("keys sorted lexicographically (UTF-16 code-point order)", function () {
  assertEq(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("uppercase sorts before lowercase (ASCII order)", function () {
  // 'A' = 0x41, 'a' = 0x61 — uppercase precedes lowercase
  assertEq(canonicalize({ a: 1, A: 2 }), '{"A":2,"a":1}');
});

test("multi-key sort", function () {
  assertEq(
    canonicalize({ z: 1, m: 2, a: 3, b: 4 }),
    '{"a":3,"b":4,"m":2,"z":1}'
  );
});

// ─── nested objects ──────────────────────────────────────────────────────────

test("nested object — inner keys also sorted", function () {
  assertEq(
    canonicalize({ outer: { y: 1, x: 2 } }),
    '{"outer":{"x":2,"y":1}}'
  );
});

test("deeply nested", function () {
  assertEq(
    canonicalize({ a: { b: { c: 1 } } }),
    '{"a":{"b":{"c":1}}}'
  );
});

// ─── arrays ──────────────────────────────────────────────────────────────────

test("array preserves insertion order (NOT sorted)", function () {
  assertEq(canonicalize([3, 1, 2]), "[3,1,2]");
});

test("array of mixed primitives", function () {
  assertEq(canonicalize([1, "x", true, null]), '[1,"x",true,null]');
});

test("array of objects — each object has keys sorted", function () {
  assertEq(
    canonicalize([{ b: 1, a: 2 }, { d: 3, c: 4 }]),
    '[{"a":2,"b":1},{"c":4,"d":3}]'
  );
});

// ─── string escaping (RFC 8785 mandatory only) ──────────────────────────────

test('escapes embedded double-quote', function () {
  assertEq(canonicalize('hello "world"'), '"hello \\"world\\""');
});

test("escapes backslash", function () {
  assertEq(canonicalize("a\\b"), '"a\\\\b"');
});

test("escapes newline", function () {
  assertEq(canonicalize("a\nb"), '"a\\nb"');
});

test("escapes tab", function () {
  assertEq(canonicalize("a\tb"), '"a\\tb"');
});

test("escapes carriage return", function () {
  assertEq(canonicalize("a\rb"), '"a\\rb"');
});

test("escapes backspace", function () {
  assertEq(canonicalize("\b"), '"\\b"');
});

test("escapes form feed", function () {
  assertEq(canonicalize("\f"), '"\\f"');
});

test("escapes generic control char via \\uXXXX", function () {
  // 0x01 has no shorthand — must be 
  assertEq(canonicalize(""), '"\\u0001"');
});

test("does NOT escape forward slash (RFC 8785: no optional escapes)", function () {
  assertEq(canonicalize("a/b"), '"a/b"');
});

test("does NOT escape printable non-ASCII (codepoint >= 0x20 stays literal)", function () {
  // RFC 8785 only mandates escaping for ", \, and < 0x20.
  assertEq(canonicalize("café"), '"café"');
});

// ─── rejection of non-representable values ──────────────────────────────────

test("throws on NaN", function () {
  assertThrows(function () { canonicalize(NaN); });
});

test("throws on +Infinity", function () {
  assertThrows(function () { canonicalize(Infinity); });
});

test("throws on -Infinity", function () {
  assertThrows(function () { canonicalize(-Infinity); });
});

test("throws on undefined value", function () {
  assertThrows(function () { canonicalize(undefined); });
});

test("throws on undefined inside object", function () {
  assertThrows(function () { canonicalize({ a: undefined }); });
});

test("throws on function", function () {
  assertThrows(function () { canonicalize(function () {}); });
});

// ─── idempotence ─────────────────────────────────────────────────────────────

test("canonicalize is idempotent through parse/serialize roundtrip", function () {
  const obj = { z: 1, a: [3, 2, 1], m: { y: "v", x: null } };
  const c1 = canonicalize(obj);
  const c2 = canonicalize(JSON.parse(c1));
  assertEq(c2, c1);
});

// ─── realistic broker-attestation body ──────────────────────────────────────

test("typical broker attestation body — keys sorted, no whitespace", function () {
  const body = {
    timestamp: 1715000000,
    provider_id: "shield-acme",
    agent_id: "agent-xyz",
    score: 0.87,
    flags: ["ok"],
  };
  assertEq(
    canonicalize(body),
    '{"agent_id":"agent-xyz","flags":["ok"],"provider_id":"shield-acme","score":0.87,"timestamp":1715000000}'
  );
});

// ─── RFC 8785 §3.2.3 inspired vector (simplified, ASCII-only) ───────────────

test("RFC-8785-style mixed types vector", function () {
  // Hand-crafted vector exercising sort + escape + nested + array.
  const input = {
    "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
    "string": "ABC",  // "ABC" — non-escape path
    "literals": [null, true, false],
  };
  // Expected: keys sorted (literals, numbers, string), array order preserved,
  // numbers use ECMA-262 toString. We assert structural pieces rather than the
  // full exact number formatting (V8's toString is spec-compliant; we trust it).
  const out = canonicalize(input);
  // Top-level key order
  const idxLit = out.indexOf('"literals"');
  const idxNum = out.indexOf('"numbers"');
  const idxStr = out.indexOf('"string"');
  if (!(idxLit < idxNum && idxNum < idxStr)) {
    throw new Error("keys not in sorted order: " + out);
  }
  // String stays unescaped
  if (out.indexOf('"string":"ABC"') === -1) {
    throw new Error("ABC literal not preserved: " + out);
  }
  // Literals preserve array order null,true,false
  if (out.indexOf('[null,true,false]') === -1) {
    throw new Error("literals array order wrong: " + out);
  }
});

// ─── summary ─────────────────────────────────────────────────────────────────

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
