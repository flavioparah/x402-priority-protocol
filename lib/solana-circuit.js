"use strict";

const CircuitBreaker = require("opossum");

let breaker = null;
let lastVerifyFn = null;

function getBreaker(verifyFn) {
  if (breaker && lastVerifyFn === verifyFn) return breaker;
  lastVerifyFn = verifyFn;
  const config = {
    errorThresholdPercentage: parseInt(process.env.SOLANA_CIRCUIT_THRESHOLD_PCT || "50", 10),
    resetTimeout: parseInt(process.env.SOLANA_CIRCUIT_RESET_MS || "30000", 10),
    timeout: parseInt(process.env.SOLANA_CIRCUIT_TIMEOUT_MS || "15000", 10),
    rollingCountTimeout: 30_000,
    rollingCountBuckets: 10,
    volumeThreshold: 5,
  };
  breaker = new CircuitBreaker(verifyFn, config);
  breaker.fallback(() => { const e = new Error("CIRCUIT_OPEN"); e.code = "CIRCUIT_OPEN"; throw e; });
  return breaker;
}

async function fireSolanaCircuit(sig, { verify }) {
  const b = getBreaker(verify);
  if (b.opened) return { ok: false, reason: "circuit_open" };
  try {
    const value = await b.fire(sig);
    return { ok: true, value };
  } catch (err) {
    if (err && (err.code === "CIRCUIT_OPEN" || err.message === "CIRCUIT_OPEN" || b.opened)) {
      return { ok: false, reason: "circuit_open" };
    }
    // Verifier returned { ok: false, reason } as a regular failure — surface
    // it as ok:true with the value so the caller's existing branch works.
    if (err && err.ok === false) return { ok: true, value: err };
    throw err;
  }
}

function getCircuitState() {
  if (!breaker) return "CLOSED";
  if (breaker.opened) return "OPEN";
  if (breaker.halfOpen) return "HALF_OPEN";
  return "CLOSED";
}

function resetForTest() { breaker = null; lastVerifyFn = null; }

module.exports = { fireSolanaCircuit, getCircuitState, resetForTest };
