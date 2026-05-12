"use strict";
/**
 * lib/metrics.js — Prometheus exporter (Phase 4 Task 18)
 *
 * Owns a dedicated prom-client Registry so we never pollute the default
 * global register (safe for tests that require the module multiple times).
 *
 * Exported surface:
 *   register              — prom-client Registry instance
 *   makeMetricsHandler    — factory for an Express /metrics route handler
 *   getMetricsText(store) — async, returns Prometheus text exposition string
 *   incRequest            — hot-path request counter increment
 *   incAbuseEvent         — abuse-event counter increment
 *   incAdminAction        — admin-action counter increment
 *   observeSolanaDuration — histogram observe for outbound RPC calls
 *   updateLiveGauges      — push-side gauge update (QoS, circuit, store health)
 */

const client = require("prom-client");
const { getRateLimitCounters } = require("./ratelimit");
const { getCircuitState } = require("./solana-circuit");
const { getRequestCounters } = require("./metrics-counters");
const { logger } = require("./logger");

// ─── Registry ────────────────────────────────────────────────────────────────

const register = new client.Registry();
register.setDefaultLabels({
  service: "x402-shield",
  network:
    process.env.NETWORK ||
    (process.env.REAL_RPC_URL && process.env.REAL_RPC_URL.includes("mainnet")
      ? "mainnet"
      : "devnet"),
});
client.collectDefaultMetrics({ register });

// ─── Metrics definitions ─────────────────────────────────────────────────────

const requestsTotal = new client.Counter({
  name: "x402_requests_total",
  help: "Requests by route, stage, and outcome",
  labelNames: ["route", "stage", "outcome"],
  registers: [register],
});

const ratelimitBlocksTotal = new client.Counter({
  name: "x402_ratelimit_blocks_total",
  help: "Rate-limit blocks per dimension and route",
  labelNames: ["dimension", "route"],
  registers: [register],
});

const abuseEventsTotal = new client.Counter({
  name: "x402_abuse_events_total",
  help: "Abuse events by reason (closed vocabulary)",
  labelNames: ["reason"],
  registers: [register],
});

const adminActionsTotal = new client.Counter({
  name: "x402_admin_actions_total",
  help: "Admin actions issued (ban, unban, config_update, etc.)",
  labelNames: ["action", "outcome"],
  registers: [register],
});

const qosInflight = new client.Gauge({
  name: "x402_qos_inflight",
  help: "Current QoS in-flight requests",
  registers: [register],
});

const qosQueueDepth = new client.Gauge({
  name: "x402_qos_queue_depth",
  help: "Current QoS queue depth",
  registers: [register],
});

const solanaCircuitState = new client.Gauge({
  name: "x402_solana_circuit_state",
  help: "Solana RPC circuit breaker state (0=closed, 1=half_open, 2=open)",
  registers: [register],
});

const storeHealthy = new client.Gauge({
  name: "x402_store_healthy",
  help: "Store backend healthy (1) or down (0)",
  registers: [register],
});

const solanaRpcDuration = new client.Histogram({
  name: "x402_solana_rpc_duration_seconds",
  help: "Latency of outbound Solana RPC calls",
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

// ─── Circuit-state numeric mapping ───────────────────────────────────────────
// getCircuitState() returns a string: "CLOSED" | "HALF_OPEN" | "OPEN"

const CIRCUIT_STATE_MAP = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

function circuitStateNum() {
  const s = getCircuitState();
  return CIRCUIT_STATE_MAP[s] ?? 0;
}

// ─── Delta tracking for process-local counters ───────────────────────────────
// prom-client Counters can only be incremented. We store the last snapshot and
// only inc() the delta on each scrape so the Prometheus series stays monotonic.

const _deltaState = new Map();

function syncDeltaCounter(counter, labels, current) {
  const key = JSON.stringify(labels);
  const prev = _deltaState.get(key) || 0;
  const delta = current - prev;
  if (delta > 0) counter.inc(labels, delta);
  _deltaState.set(key, current);
}

// ─── Live gauge push ─────────────────────────────────────────────────────────

/**
 * updateLiveGauges({ qosInflightCount, qosQueueLen, circuitStateNum, storeHealthFlag })
 * Call this from the scrape path or from the QoS middleware on each request.
 */
function updateLiveGauges({ qosInflightCount, qosQueueLen, circuitStateOverride, storeHealthFlag } = {}) {
  if (typeof qosInflightCount === "number") qosInflight.set(qosInflightCount);
  if (typeof qosQueueLen === "number") qosQueueDepth.set(qosQueueLen);
  if (typeof circuitStateOverride === "number") {
    solanaCircuitState.set(circuitStateOverride);
  } else {
    solanaCircuitState.set(circuitStateNum());
  }
  if (typeof storeHealthFlag === "number") storeHealthy.set(storeHealthFlag);
}

// ─── Core scrape logic ────────────────────────────────────────────────────────

/**
 * Sync all pull-side counters/gauges from the live in-process state.
 * Called once per scrape (either from makeMetricsHandler or getMetricsText).
 */
async function _syncBeforeScrape(store) {
  // 1. x402_requests_total — from metrics-counters.js
  const reqSnap = getRequestCounters();
  for (const { route, stage, outcome, count } of reqSnap) {
    syncDeltaCounter(requestsTotal, { route, stage, outcome }, count);
  }

  // 2. x402_ratelimit_blocks_total — from ratelimit.js
  //    Shape: { total, blocks: { global, ip, pubkey, paid }, byRoute: { [route]: { ... } } }
  const rlSnap = getRateLimitCounters();
  for (const [dim, val] of Object.entries(rlSnap.blocks || {})) {
    syncDeltaCounter(ratelimitBlocksTotal, { dimension: dim, route: "_all" }, val);
  }
  for (const [route, byDim] of Object.entries(rlSnap.byRoute || {})) {
    for (const [dim, val] of Object.entries(byDim)) {
      syncDeltaCounter(ratelimitBlocksTotal, { dimension: dim, route }, val);
    }
  }

  // 3. x402_solana_circuit_state gauge
  solanaCircuitState.set(circuitStateNum());

  // 4. x402_store_healthy gauge
  if (store && typeof store.isStoreHealthy === "function") {
    try {
      const healthy = await store.isStoreHealthy();
      storeHealthy.set(healthy ? 1 : 0);
    } catch {
      storeHealthy.set(0);
    }
  }
}

// ─── getMetricsText(store) ────────────────────────────────────────────────────

/**
 * Returns the full Prometheus text exposition string.
 * `store` is optional; when provided, x402_store_healthy is updated.
 */
async function getMetricsText(store) {
  await _syncBeforeScrape(store);
  return register.metrics();
}

// ─── Express handler factory ──────────────────────────────────────────────────

/**
 * makeMetricsHandler(getRuntimeSnapshot)
 *
 * `getRuntimeSnapshot` is a zero-arg function returning:
 *   { qosInflightCount, qosQueueLen, store }
 */
function makeMetricsHandler(getRuntimeSnapshot) {
  return async function metricsHandler(_req, res) {
    try {
      const snap = typeof getRuntimeSnapshot === "function" ? getRuntimeSnapshot() : {};
      const { store } = snap;

      if (typeof snap.qosInflightCount === "number") qosInflight.set(snap.qosInflightCount);
      if (typeof snap.qosQueueLen === "number") qosQueueDepth.set(snap.qosQueueLen);

      await _syncBeforeScrape(store);

      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (e) {
      logger.error({ kind: "metrics", err: e.message }, "metrics scrape failed");
      res.status(500).end("# scrape error\n");
    }
  };
}

// ─── Hot-path increments ──────────────────────────────────────────────────────

function incRequest(route, stage, outcome) {
  requestsTotal.inc({ route, stage, outcome });
}

function incAbuseEvent(reason) {
  abuseEventsTotal.inc({ reason });
}

/**
 * incAdminAction(action, outcome)
 * outcome defaults to "ok" when omitted.
 */
function incAdminAction(action, outcome) {
  adminActionsTotal.inc({ action, outcome: outcome || "ok" });
}

function observeSolanaDuration(seconds) {
  solanaRpcDuration.observe(seconds);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  register,
  makeMetricsHandler,
  getMetricsText,
  incRequest,
  incAbuseEvent,
  incAdminAction,
  observeSolanaDuration,
  updateLiveGauges,
};
