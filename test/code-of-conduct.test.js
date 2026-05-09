const { strict: assert } = require("assert");
const { CODE_OF_CONDUCT_V1, getCodeOfConduct } = require("../lib/code-of-conduct");

(function structure() {
  const c = getCodeOfConduct();
  assert.equal(c.version, "1.0");
  assert.ok(c.rate_budgets.per_ip);
  assert.equal(c.rate_budgets.per_ip.burst, 100);
  assert.equal(c.rate_budgets.per_pubkey.burst, 200);
  assert.equal(c.rate_budgets.global.burst, 5000);
  assert.deepEqual(c.enforcement.tiers, ["warning","throttle","soft_ban","hard_ban","permanent"]);
  assert.equal(c.enforcement.trust_multipliers["81-100"], 10);
  assert.equal(c.enforcement.new_pubkey_whitelist_days, 30);
  assert.equal(c.operator_obligations.audit_log_retention_days, 90);
  assert.equal(c.operator_obligations.api_key_rotation_max_days, 90);
  console.log("  ✓ structure intact");
})();

(function frozen() {
  assert.ok(Object.isFrozen(CODE_OF_CONDUCT_V1));
  assert.ok(Object.isFrozen(CODE_OF_CONDUCT_V1.rate_budgets));
  assert.ok(Object.isFrozen(CODE_OF_CONDUCT_V1.rate_budgets.per_ip));
  assert.ok(Object.isFrozen(CODE_OF_CONDUCT_V1.enforcement));
  let threw = false;
  try { CODE_OF_CONDUCT_V1.version = "evil"; } catch { threw = true; }
  assert.ok(threw || CODE_OF_CONDUCT_V1.version === "1.0", "must reject mutation in strict mode");
  console.log("  ✓ frozen recursively");
})();

(function getCodeOfConductDispatch() {
  assert.equal(getCodeOfConduct().version, "1.0");
  assert.equal(getCodeOfConduct("1.0").version, "1.0");
  // Unknown version returns null — caller (handler) maps to 404
  assert.equal(getCodeOfConduct("2.0"), null);
  console.log("  ✓ version dispatch");
})();

(function vocabularyCovered() {
  // The feedback_headers list MUST stay in sync with the closed vocabulary
  // shipped to enforcement responses.
  const c = getCodeOfConduct();
  for (const h of ["X-x402-Tier","X-x402-Reason","X-x402-Until","X-x402-Trust-Impact"]) {
    assert.ok(c.enforcement.feedback_headers.includes(h));
  }
  console.log("  ✓ feedback_headers vocabulary preserved");
})();
