/**
 * test/logger.test.js
 */
const path = require("path");

let failed = 0;
function assert(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

const {
  logger,
  sampledWarn,
  _sampleCounters,
  LOG_SAMPLE_AFTER,
  LOG_SAMPLE_RATE,
} = require(path.join(__dirname, "..", "lib", "logger.js"));

assert("logger exported with .info/.warn/.error/.fatal/.child",
  logger && typeof logger.info === "function" && typeof logger.warn === "function" &&
  typeof logger.error === "function" && typeof logger.fatal === "function" &&
  typeof logger.child === "function");

assert("LOG_SAMPLE_AFTER default is 100", LOG_SAMPLE_AFTER === 100);
assert("LOG_SAMPLE_RATE default is 50", LOG_SAMPLE_RATE === 50);

// Reset counters for deterministic test.
for (const k of Object.keys(_sampleCounters)) delete _sampleCounters[k];

// Patch logger.warn to count emissions instead of writing
let emitted = 0;
const origWarn = logger.warn.bind(logger);
logger.warn = (..._args) => { emitted++; };

// First 100 events of reason "X" all emit (1..100)
for (let i = 0; i < 100; i++) sampledWarn("reason_x", { i });
assert("first 100 events emit", emitted === 100);

// Events 101..150: only 1 in 50 emits → event 101 emits
emitted = 0;
for (let i = 101; i <= 150; i++) sampledWarn("reason_x", { i });
assert("events 101..150 emit exactly once (event 101)", emitted === 1);

emitted = 0;
for (let i = 151; i <= 200; i++) sampledWarn("reason_x", { i });
assert("events 151..200 emit exactly once (event 151)", emitted === 1);

// Distinct reason has independent counter — first 100 of "reason_y" all emit
emitted = 0;
for (let i = 0; i < 100; i++) sampledWarn("reason_y", { i });
assert("distinct reason has independent counter (100 events emit)", emitted === 100);

logger.warn = origWarn;

// child() returns a new logger with extra bindings
const child = logger.child({ reqId: "abcd1234" });
assert("child() returns logger with .info", child && typeof child.info === "function");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.\n`);
  process.exit(1);
}
console.log("\nAll logger assertions passed.\n");
