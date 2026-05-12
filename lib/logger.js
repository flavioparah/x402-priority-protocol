"use strict";

const pino = require("pino");

const LOG_SAMPLE_AFTER = parseInt(process.env.LOG_SAMPLE_AFTER || "100", 10);
const LOG_SAMPLE_RATE = parseInt(process.env.LOG_SAMPLE_RATE || "50", 10);

// Async file transport pointing at fd 1 (stdout). sync:false keeps log writes
// off the request hot path — under flood, synchronous console.log can become
// a bottleneck (spec §10.6).
const transport = pino.transport({
  target: "pino/file",
  options: { destination: 1, sync: false },
});

const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    base: { svc: "x402-shield" },
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  transport
);

// Per-reason emission counters. Module-level — sampling is process-wide policy.
// Tests reset by clearing keys directly on this object.
const _sampleCounters = Object.create(null);

/**
 * sampledWarn(reason, fields)
 *
 * Emits logger.warn for the first LOG_SAMPLE_AFTER (100) events of `reason`,
 * then 1-in-LOG_SAMPLE_RATE (50) deterministically thereafter.
 * Suppresses hot-path noise without losing first signal.
 */
function sampledWarn(reason, fields = {}) {
  const n = (_sampleCounters[reason] = (_sampleCounters[reason] || 0) + 1);
  let emit = false;
  if (n <= LOG_SAMPLE_AFTER) {
    emit = true;
  } else {
    const delta = n - LOG_SAMPLE_AFTER;
    if (delta % LOG_SAMPLE_RATE === 1) emit = true;
  }
  if (emit) {
    logger.warn({ ...fields, reason, sampled_count: n });
  }
}

const audit = logger.child({ kind: "audit" });
const admin = logger.child({ kind: "admin" });

module.exports = {
  logger,
  audit,
  admin,
  sampledWarn,
  _sampleCounters,
  LOG_SAMPLE_AFTER,
  LOG_SAMPLE_RATE,
};
