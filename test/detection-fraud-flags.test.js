const { getActiveFraudFlags } = require("../lib/detection");
const { REASONS } = require("../lib/abuse-reasons");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * ONE_DAY_MS;

let passed = 0, failed = 0;
function test(n, fn) {
  try { fn(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n    ${e.message}`); failed++; }
}
function assertEq(a, b, l) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${l}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function bulk(n, base, amt, op = "self", spread = 60_000) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ ts: Date.now() - base - i * spread, amount: amt, operator_id: op });
  return out;
}

console.log("\nx402-shield detection.getActiveFraudFlags — unit tests\n");

test("empty inputs → empty array", () => {
  assertEq(getActiveFraudFlags("Pk", [], null), []);
});

test("benign log → empty array", () => {
  const log = bulk(10, HOUR_MS, 40200);
  const rep = { firstPaidAt: Date.now() - 30*ONE_DAY_MS, paidCount: 10, lastPaidAt: Date.now(), totalPaid: 0 };
  assertEq(getActiveFraudFlags("Pk", log, rep), []);
});

test("wash payment → returns wash-payment reason from closed vocab", () => {
  const log = bulk(60, HOUR_MS, 40200);
  const rep = { firstPaidAt: Date.now() - 5*HOUR_MS, paidCount: 60, lastPaidAt: Date.now(), totalPaid: 0 };
  const flags = getActiveFraudFlags("Pk", log, rep);
  if (!flags.includes(REASONS.WASH_PAYMENT))
    throw new Error(`expected ${REASONS.WASH_PAYMENT} in ${JSON.stringify(flags)}`);
});

test("coordinated burst (multi-op) → returns coordinated-burst", () => {
  const log = [
    ...bulk(5, HOUR_MS, 40200, "helius"),
    ...bulk(5, HOUR_MS, 40200, "triton"),
  ];
  const rep = { firstPaidAt: Date.now() - 12*HOUR_MS, paidCount: 10, lastPaidAt: Date.now(), totalPaid: 0 };
  const flags = getActiveFraudFlags("Pk", log, rep);
  if (!flags.includes(REASONS.COORDINATED_BURST))
    throw new Error(`expected coordinated-burst in ${JSON.stringify(flags)}`);
});

test("returned reasons are always from closed vocabulary", () => {
  const { ALL_REASONS } = require("../lib/abuse-reasons");
  const log = bulk(60, HOUR_MS, 40200);
  const rep = { firstPaidAt: Date.now() - 5*HOUR_MS, paidCount: 60, lastPaidAt: Date.now(), totalPaid: 0 };
  const flags = getActiveFraudFlags("Pk", log, rep);
  for (const f of flags) {
    if (!ALL_REASONS.includes(f)) throw new Error(`unknown reason returned: ${f}`);
  }
});

test("no duplicate reasons in output", () => {
  const log = bulk(60, HOUR_MS, 40200);
  const rep = { firstPaidAt: Date.now() - 5*HOUR_MS, paidCount: 60, lastPaidAt: Date.now(), totalPaid: 0 };
  const flags = getActiveFraudFlags("Pk", log, rep);
  if (new Set(flags).size !== flags.length) throw new Error("duplicates");
});

console.log(`\n${passed}/${passed+failed} tests passed.`);
if (failed) process.exit(1);
