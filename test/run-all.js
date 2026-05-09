/**
 * test/run-all.js
 *
 * Master test runner. Executes every persistent test file in sequence,
 * propagating failure. Skips Redis-only tests when REDIS_URL is unset
 * (the individual test files already handle SKIP messaging).
 *
 * Each Phase (0-4) appends its own files here as they land. Phase 0 owns
 * the initial list below.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const FILES = [
  // Existing pre-overhaul suite
  "test/smoke.js",
  "test/atomic-consume.test.js",
  "test/atomic-consume-redis.test.js",
  "test/cooperative-qos.test.js",
  "test/detection.test.js",
  // Phase 0 additions
  "test/store-ratelimit.test.js",
  "test/store-pending-deposit.test.js",
  "test/store-abuse.test.js",
  "test/store-ban.test.js",
  "test/boot-guards.test.js",
  "test/graceful-shutdown.test.js",
  "test/store-misc.test.js",
  "test/headers-and-reqid.test.js",
  "test/no-console-residue.test.js",
  // Phase 2 additions
  "test/cheap-reject.test.js",
  "test/nonce-precheck-bounded.test.js",
  "test/ratelimit-3dim.test.js",
  "test/rpc-content-length.test.js",
  "test/paid-lane.test.js",
  // Phase 3 additions
  "test/abuse-reasons.test.js",
  "test/trust-multiplier.test.js",
  "test/detection-fraud-flags.test.js",
  "test/enforcement-checkban.test.js",
  "test/enforcement-ladder.test.js",
  "test/enforcement-whitelist.test.js",
  "test/feedback-headers.test.js",
  "test/permanent-ban-promotion.test.js",
  "test/enforcement-cross-signal.test.js",
  // Phase 4 additions
  "test/code-of-conduct.test.js",
  "test/store-slidingwindow-query.test.js",
  "test/metrics-output.test.js",
];

let failed = 0;
for (const rel of FILES) {
  const abs = path.join(__dirname, "..", rel);
  console.log(`\n=== ${rel} ===`);
  const res = spawnSync(process.execPath, [abs], {
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    console.error(`FAILED: ${rel} (exit ${res.status})`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed.\n`);
  process.exit(1);
}
console.log("\nAll test files passed.\n");
