/**
 * broker/test/signature.test.js
 *
 * Unit tests for broker/lib/signature.js (Ed25519 wrapper).
 * Plain Node — no Jest. Run: node broker/test/signature.test.js
 */

const { verify, sign, generateKeypair } = require("../lib/signature");
const bs58 = require("bs58");
const nacl = require("tweetnacl");

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

function assertTrue(v, label) {
  if (v !== true) throw new Error((label || "assertTrue") + ": expected true, got " + JSON.stringify(v));
}

function assertFalse(v, label) {
  if (v !== false) throw new Error((label || "assertFalse") + ": expected false, got " + JSON.stringify(v));
}

console.log("\nsignature (Ed25519 / tweetnacl + bs58)\n");

// ─── helpers ─────────────────────────────────────────────────────────────────

function sampleBody() {
  return {
    timestamp: 1715000000,
    provider_id: "shield-acme",
    agent_id: "agent-xyz",
    score: 0.87,
    flags: ["ok"],
  };
}

// ─── happy path ──────────────────────────────────────────────────────────────

test("generateKeypair returns base58 pubkey + 64-byte secret", function () {
  const kp = generateKeypair();
  assertEq(typeof kp.publicKey, "string");
  if (!(kp.secretKey instanceof Uint8Array)) {
    throw new Error("secretKey must be Uint8Array");
  }
  assertEq(kp.secretKey.length, 64);
  // pubkey decodes to 32 bytes
  const pk = bs58.decode(kp.publicKey);
  assertEq(pk.length, 32);
});

test("sign returns a base58 string decoding to 64 bytes", function () {
  const kp = generateKeypair();
  const sig = sign(sampleBody(), kp.secretKey);
  assertEq(typeof sig, "string");
  const raw = bs58.decode(sig);
  assertEq(raw.length, 64);
});

test("roundtrip: generateKeypair -> sign -> verify === true", function () {
  const kp = generateKeypair();
  const body = sampleBody();
  const sig = sign(body, kp.secretKey);
  assertTrue(verify(body, sig, kp.publicKey));
});

test("empty body {} roundtrips", function () {
  const kp = generateKeypair();
  const sig = sign({}, kp.secretKey);
  assertTrue(verify({}, sig, kp.publicKey));
});

test("verify ignores key order in body (canonicalization sorts)", function () {
  const kp = generateKeypair();
  const signed = { b: 2, a: 1, c: 3 };
  const sig = sign(signed, kp.secretKey);
  // Same content, different insertion order — must still verify.
  const reordered = { c: 3, a: 1, b: 2 };
  assertTrue(verify(reordered, sig, kp.publicKey));
});

test("verify works on nested body with reordered nested keys", function () {
  const kp = generateKeypair();
  const signed = { outer: { y: 1, x: 2 }, top: "v" };
  const sig = sign(signed, kp.secretKey);
  const reordered = { top: "v", outer: { x: 2, y: 1 } };
  assertTrue(verify(reordered, sig, kp.publicKey));
});

// ─── negative cases (must return false, never throw) ────────────────────────

test("wrong pubkey -> false", function () {
  const kp1 = generateKeypair();
  const kp2 = generateKeypair();
  const body = sampleBody();
  const sig = sign(body, kp1.secretKey);
  assertFalse(verify(body, sig, kp2.publicKey));
});

test("tampered body -> false", function () {
  const kp = generateKeypair();
  const body = sampleBody();
  const sig = sign(body, kp.secretKey);
  const tampered = Object.assign({}, body, { score: 0.99 });
  assertFalse(verify(tampered, sig, kp.publicKey));
});

test("tampered signature bytes -> false", function () {
  const kp = generateKeypair();
  const body = sampleBody();
  const sig = sign(body, kp.secretKey);
  // Flip one byte in the raw signature, re-encode.
  const raw = bs58.decode(sig);
  raw[0] = raw[0] ^ 0xff;
  const badSig = bs58.encode(raw);
  assertFalse(verify(body, badSig, kp.publicKey));
});

test("wrong-length signature (32 bytes instead of 64) -> false", function () {
  const kp = generateKeypair();
  const shortSig = bs58.encode(new Uint8Array(32));  // all zeros, 32 bytes
  assertFalse(verify(sampleBody(), shortSig, kp.publicKey));
});

test("wrong-length pubkey (64 bytes instead of 32) -> false", function () {
  const kp = generateKeypair();
  const sig = sign(sampleBody(), kp.secretKey);
  const longPk = bs58.encode(new Uint8Array(64));
  assertFalse(verify(sampleBody(), sig, longPk));
});

test("invalid base58 signature -> false (not throw)", function () {
  const kp = generateKeypair();
  // '0' (zero) and 'l', 'I', 'O' are NOT in the base58 alphabet.
  assertFalse(verify(sampleBody(), "0OIl0OIl", kp.publicKey));
});

test("invalid base58 pubkey -> false (not throw)", function () {
  const kp = generateKeypair();
  const sig = sign(sampleBody(), kp.secretKey);
  assertFalse(verify(sampleBody(), sig, "0OIl0OIl"));
});

test("non-string signature -> false (not throw)", function () {
  const kp = generateKeypair();
  assertFalse(verify(sampleBody(), null, kp.publicKey));
  assertFalse(verify(sampleBody(), 12345, kp.publicKey));
  assertFalse(verify(sampleBody(), undefined, kp.publicKey));
});

test("non-string pubkey -> false (not throw)", function () {
  const kp = generateKeypair();
  const sig = sign(sampleBody(), kp.secretKey);
  assertFalse(verify(sampleBody(), sig, null));
  assertFalse(verify(sampleBody(), sig, 12345));
});

test("null body -> false (not throw)", function () {
  const kp = generateKeypair();
  const sig = sign(sampleBody(), kp.secretKey);
  assertFalse(verify(null, sig, kp.publicKey));
});

test("body containing NaN -> false (canonicalize throws, caught)", function () {
  const kp = generateKeypair();
  const sig = sign(sampleBody(), kp.secretKey);
  assertFalse(verify({ bad: NaN }, sig, kp.publicKey));
});

test("two different bodies produce different signatures", function () {
  const kp = generateKeypair();
  const sig1 = sign({ a: 1 }, kp.secretKey);
  const sig2 = sign({ a: 2 }, kp.secretKey);
  if (sig1 === sig2) throw new Error("expected different signatures");
});

test("same body + same key produces deterministic signature (Ed25519)", function () {
  const kp = generateKeypair();
  const body = sampleBody();
  const sig1 = sign(body, kp.secretKey);
  const sig2 = sign(body, kp.secretKey);
  assertEq(sig1, sig2);
});

// ─── interop sanity: tweetnacl direct vs our wrapper ────────────────────────

test("direct nacl.sign.detached matches our sign() over identical bytes", function () {
  const kp = nacl.sign.keyPair();
  const body = { a: 1, b: 2 };
  // Our wrapper canonicalizes first; mimic that here.
  const { canonicalize } = require("../lib/canonical-json");
  const msg = new TextEncoder().encode(canonicalize(body));
  const directSig = nacl.sign.detached(msg, kp.secretKey);
  const wrappedSig = sign(body, kp.secretKey);
  assertEq(bs58.encode(directSig), wrappedSig);
});

// ─── summary ─────────────────────────────────────────────────────────────────

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
