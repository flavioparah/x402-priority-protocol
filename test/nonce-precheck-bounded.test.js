process.env.X402_PREFLIGHT_TRACE = "1";
const preflight = require("../lib/preflight");
const bs58 = require("bs58").default || require("bs58");
const crypto = require("crypto");

let n = 0, failed = 0;
function check(label, cond) {
  n++;
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

function makeStore(nonces) {
  return { async getNonce(k) { return nonces[k] || null; } };
}

function encodeMessage(obj) {
  return bs58.encode(Buffer.from(JSON.stringify(obj), "utf8"));
}

(async () => {
  console.log("\n— noncePreCheck bounded invariants —\n");

  // CASE 1: messageBytes > 1024 → message_too_large
  const huge = "a".repeat(2048);
  const hugeB58 = bs58.encode(Buffer.from(huge, "utf8"));
  const r1 = await preflight.noncePreCheck(["X", "Y", hugeB58], makeStore({}));
  check("messageBytes > 1024 → message_too_large",
    r1.ok === false && r1.reason === "message_too_large");

  // CASE 2: bs58 decode failure → bad_base58
  const r2 = await preflight.noncePreCheck(["X", "Y", "0OIl"], makeStore({}));
  check("bad base58 → bad_base58", r2.ok === false && r2.reason === "bad_base58");

  // CASE 3: JSON.parse failure → bad_json
  const notJson = bs58.encode(Buffer.from("not-json-just-text", "utf8"));
  const r3 = await preflight.noncePreCheck(["X", "Y", notJson], makeStore({}));
  check("malformed JSON → bad_json", r3.ok === false && r3.reason === "bad_json");

  // CASE 4: payload.nonce missing → no_nonce
  const noNonce = encodeMessage({ pubkey: "fake", amount: 1, destination: "x" });
  const r4 = await preflight.noncePreCheck(["X", "Y", noNonce], makeStore({}));
  check("no payload.nonce → no_nonce", r4.ok === false && r4.reason === "no_nonce");

  // CASE 5: payload.nonce wrong format → bad_nonce_format
  const badFmt = encodeMessage({ nonce: "NOT-HEX-NOT-32" });
  const r5 = await preflight.noncePreCheck(["X", "Y", badFmt], makeStore({}));
  check("bad nonce format → bad_nonce_format",
    r5.ok === false && r5.reason === "bad_nonce_format");

  // CASE 6: nonce not in store → nonce_unknown
  const goodNonce = crypto.randomBytes(16).toString("hex");
  const known = encodeMessage({ nonce: goodNonce, pubkey: "P", amount: 100, destination: "D" });
  const r6 = await preflight.noncePreCheck(["X", "Y", known], makeStore({}));
  check("nonce missing in store → nonce_unknown",
    r6.ok === false && r6.reason === "nonce_unknown");

  // CASE 7: VALID nonce → ok=true AND only payload.nonce accessed
  preflight.__resetTrace();
  const r7 = await preflight.noncePreCheck(["X", "Y", known],
    makeStore({ [goodNonce]: { amount: 100, used: false, hintedPubkey: null } }));
  check("valid nonce → ok=true", r7.ok === true);
  const accessed = preflight.__getTrace();
  const forbiddenSeen = accessed.filter((k) => k === "pubkey" || k === "amount" || k === "destination");
  check(
    `payload.{pubkey,amount,destination} NOT accessed before verify (saw: ${JSON.stringify(accessed)})`,
    forbiddenSeen.length === 0
  );

  if (failed > 0) {
    console.error(`\n${failed} of ${n} assertions failed.\n`);
    process.exit(1);
  }
  console.log(`\nAll ${n} assertions passed.\n`);
})().catch((e) => { console.error(e); process.exit(1); });
