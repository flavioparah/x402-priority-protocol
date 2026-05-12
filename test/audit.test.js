const path = require("path");

let failed = 0;
function assert(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

const loggerMod = require(path.join(__dirname, "..", "lib", "logger.js"));
const audit = require(path.join(__dirname, "..", "lib", "audit.js"));

const captured = [];
const auditOrigInfo = loggerMod.audit.info.bind(loggerMod.audit);
const adminOrigInfo = loggerMod.admin.info.bind(loggerMod.admin);
loggerMod.audit.info = (rec) => { captured.push({ stream: "audit", rec }); };
loggerMod.admin.info = (rec) => { captured.push({ stream: "admin", rec }); };

audit.writeDepositVerified({
  sig: "abc123",
  pubkey: "PubA",
  micro_lamports: 5000,
  slot: 42,
  request_id: "r1",
});
audit.writeAdminAction({
  actor_key_id: "ops-2026-05",
  method: "POST",
  path: "/admin/ban",
  body_sha256: "deadbeef",
  target: { type: "pubkey", key: "PubX" },
  action_outcome: "ok",
  request_id: "r2",
});

loggerMod.audit.info = auditOrigInfo;
loggerMod.admin.info = adminOrigInfo;

assert("two records captured", captured.length === 2);
assert("first record on audit stream", captured[0].stream === "audit");
assert("audit record has sig=abc123", captured[0].rec.sig === "abc123");
assert("audit record has request_id=r1", captured[0].rec.request_id === "r1");
assert("audit record has ts (number)",
  typeof captured[0].rec.ts === "number" && captured[0].rec.ts > 0);

assert("second record on admin stream", captured[1].stream === "admin");
assert("admin record actor_key_id=ops-2026-05",
  captured[1].rec.actor_key_id === "ops-2026-05");
assert("admin record path=/admin/ban", captured[1].rec.path === "/admin/ban");
assert("admin record body_sha256=deadbeef",
  captured[1].rec.body_sha256 === "deadbeef");
assert("admin record target preserved",
  captured[1].rec.target && captured[1].rec.target.key === "PubX");
assert("admin record action_outcome=ok",
  captured[1].rec.action_outcome === "ok");

// Caller-supplied ts is preserved
loggerMod.audit.info = (rec) => { captured.push({ stream: "audit", rec }); };
audit.writeDepositVerified({ sig: "x", ts: 1234567890 });
loggerMod.audit.info = auditOrigInfo;
assert("caller-supplied ts preserved",
  captured[2].rec.ts === 1234567890);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.\n`);
  process.exit(1);
}
console.log("\nAll audit assertions passed.\n");
