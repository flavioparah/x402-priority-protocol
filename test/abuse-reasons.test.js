const { REASONS, isKnownReason, ALL_REASONS } = require("../lib/abuse-reasons");

let n = 0, failed = 0;
function check(label, cond) {
  n++;
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

check("REASONS object is frozen", Object.isFrozen(REASONS));

const expected = [
  "ip-rate-limit", "pubkey-rate-limit", "global-rate-limit",
  "invalid-signature-burst", "nonce-replay",
  "pubkey-hint-mismatch", "wash-payment", "coordinated-burst", "dormant-revival",
  "deposit-signature-invalid", "deposit-amount-mismatch",
  "body-too-large", "malformed-payload",
];
check("REASONS contains all 13 canonical entries",
  expected.every((r) => REASONS[r.replace(/-/g, "_").toUpperCase()] === r));
check("ALL_REASONS list matches expected",
  JSON.stringify([...ALL_REASONS].sort()) === JSON.stringify([...expected].sort()));

for (const r of ALL_REASONS) {
  check(`isKnownReason(${r}) === true`, isKnownReason(r) === true);
}

for (const bad of ["ip-rate", "rate-limit", "WASH-PAYMENT", "", null, undefined, 42]) {
  check(`isKnownReason(${JSON.stringify(bad)}) === false`, isKnownReason(bad) === false);
}

try { REASONS.IP_RATE_LIMIT = "lol"; } catch {}
check("frozen mutation no-op", REASONS.IP_RATE_LIMIT === "ip-rate-limit");
try { REASONS.NEW_KEY = "nope"; } catch {}
check("frozen extension no-op", !("NEW_KEY" in REASONS));

if (failed > 0) {
  console.error(`\n${failed} of ${n} assertions failed.\n`);
  process.exit(1);
}
console.log(`\nAll ${n} assertions passed.\n`);
