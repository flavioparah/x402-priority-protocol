"use strict";

const preflight = require("../lib/preflight");

let failed = 0;
function assert(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

// Garbage shapes
assert("undefined → missing", preflight.preflightAuth(undefined) === "missing");
assert("empty → missing", preflight.preflightAuth("") === "missing");
assert("no x402 prefix → missing", preflight.preflightAuth("Bearer xyz") === "missing");
assert("only prefix → malformed", preflight.preflightAuth("x402 ") === "malformed");
assert("two parts → malformed", preflight.preflightAuth("x402 a.b") === "malformed");
assert("four parts → malformed", preflight.preflightAuth("x402 a.b.c.d") === "malformed");
assert("sig too short → sig_length",
  preflight.preflightAuth(`x402 ${"a".repeat(50)}.${"b".repeat(40)}.${"c".repeat(100)}`) === "sig_length");
assert("sig too long → sig_length",
  preflight.preflightAuth(`x402 ${"a".repeat(200)}.${"b".repeat(40)}.${"c".repeat(100)}`) === "sig_length");
assert("pubkey too short → pubkey_length",
  preflight.preflightAuth(`x402 ${"a".repeat(88)}.${"b".repeat(20)}.${"c".repeat(100)}`) === "pubkey_length");
assert("msg too long → msg_length",
  preflight.preflightAuth(`x402 ${"a".repeat(88)}.${"b".repeat(40)}.${"c".repeat(600)}`) === "msg_length");

// Spy: confirm garbage path never calls nacl.verify or bs58.decode
const nacl = require("tweetnacl");
const bs58 = require("bs58").default || require("bs58");
let naclCalls = 0, bs58Calls = 0;
const origVerify = nacl.sign.detached.verify;
const origDecode = bs58.decode;
nacl.sign.detached.verify = (...a) => { naclCalls++; return origVerify(...a); };
bs58.decode = (...a) => { bs58Calls++; return origDecode(...a); };

try {
  for (let i = 0; i < 1000; i++) {
    preflight.preflightAuth("x402 garbage.payload.no");
  }
  assert("1000 garbage headers → 0 nacl.verify calls", naclCalls === 0);
  assert("1000 garbage headers → 0 bs58.decode calls", bs58Calls === 0);
} finally {
  nacl.sign.detached.verify = origVerify;
  bs58.decode = origDecode;
}

// Shape-OK header passes preflightAuth (returns null)
const headerCorrect = `x402 ${"1".repeat(88)}.${"2".repeat(43)}.${"3".repeat(200)}`;
assert("shape-OK header → null (passes)", preflight.preflightAuth(headerCorrect) === null);

if (failed > 0) { console.error(`\n${failed} failed.\n`); process.exit(1); }
console.log("\nAll cheap-reject assertions passed.\n");
