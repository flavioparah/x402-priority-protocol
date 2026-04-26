#!/usr/bin/env node
/**
 * examples/operator-qos-reference.js
 *
 * Reference implementation of the OPERATOR side of the
 * x402-qos-cooperative spec (see docs/QOS-COOPERATIVE-SPEC.md).
 *
 * What this is: a minimal HTTP server that pretends to be a Solana RPC
 * operator's frontend. It demonstrates the four required behaviors:
 *
 *   1. Read X-Priority-Score (default 0)
 *   2. Validate X-QoS-Spec-Version (reject unknown major)
 *   3. Schedule with a priority-weighted, aging-boosted worker pool
 *   4. Emit X-QoS-Overload: 1 on overload responses
 *
 * What this is NOT: a production deployment. Real operators have nginx
 * fronting a real validator with way more concerns (TLS, IP allowlists,
 * metrics, persistent state). This file is the SCHEDULING contract,
 * extracted to ~80 lines so a partner can read it in 5 minutes.
 *
 * Usage:
 *   node examples/operator-qos-reference.js
 *
 * Then point the Shield at it:
 *   PORT=3000 \
 *     REAL_RPC_URL=http://127.0.0.1:9000 \
 *     QOS_MODE=cooperative \
 *     PAYMENT_DESTINATION=YourSolWalletHere \
 *     ESCROW_TRUST_DEPOSITS=1 \
 *     RPC_LOAD_FORCE=0.9 \
 *     npm start
 */

const http = require("http");

const PORT = parseInt(process.env.PORT || "9000", 10);
const SUPPORTED_MAJOR = "1";
const MAX_INFLIGHT = parseInt(process.env.MAX_INFLIGHT || "4", 10);
const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH || "20", 10);
const SIMULATED_LATENCY_MS = parseInt(process.env.SIMULATED_LATENCY_MS || "150", 10);
const UPSTREAM_URL = process.env.OPERATOR_UPSTREAM_URL || null; // null = simulate response

let inFlight = 0;
const queue = [];
let dispatched = 0;
let overloadResponses = 0;

function effectiveScore(entry) {
  // Aging boost: +1 per 50 ms in queue (matches Shield standalone QoS).
  return entry.score + (Date.now() - entry.enqueuedAt) / 50;
}

function dequeueHighest() {
  if (queue.length === 0) return null;
  let bestIdx = 0;
  let best = effectiveScore(queue[0]);
  for (let i = 1; i < queue.length; i++) {
    const s = effectiveScore(queue[i]);
    if (s > best) { best = s; bestIdx = i; }
  }
  return queue.splice(bestIdx, 1)[0];
}

function drain() {
  while (inFlight < MAX_INFLIGHT && queue.length > 0) {
    const entry = dequeueHighest();
    inFlight++;
    dispatched++;
    const waitMs = Date.now() - entry.enqueuedAt;
    handleDispatch(entry, waitMs).finally(() => {
      inFlight--;
      drain();
    });
  }
}

async function handleDispatch(entry, waitMs) {
  const { req, res, score } = entry;
  console.log(`[operator] dispatch score=${score} wait=${waitMs}ms inFlight=${inFlight}/${MAX_INFLIGHT} queue=${queue.length}`);
  // Simulate validator processing time (or proxy upstream — out of scope here).
  await new Promise((r) => setTimeout(r, SIMULATED_LATENCY_MS));
  res.writeHead(200, { "Content-Type": "application/json" });
  // Echo a JSON-RPC-shaped body so the Shield's downstream proxy chain
  // doesn't choke. In a real operator this would forward to the validator.
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true, score, wait_ms: waitMs },
  }));
}

const server = http.createServer((req, res) => {
  // 1. Validate spec version
  const ver = req.headers["x-qos-spec-version"];
  if (ver && !ver.startsWith(SUPPORTED_MAJOR)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: `Unsupported X-QoS-Spec-Version=${ver}; expected ${SUPPORTED_MAJOR}.x` }));
  }

  // 2. Read priority hint (default 0 — back of queue)
  const score = parseInt(req.headers["x-priority-score"] || "0", 10);

  // 3. Overload protection
  if (queue.length >= MAX_QUEUE_DEPTH) {
    overloadResponses++;
    res.writeHead(503, {
      "Content-Type": "application/json",
      "X-QoS-Overload": "1",
      "Retry-After": "1",
    });
    return res.end(JSON.stringify({ error: "operator overloaded", queue_depth: queue.length }));
  }

  // 4. Enqueue & schedule
  queue.push({ req, res, score, enqueuedAt: Date.now() });
  drain();
});

// Optional liveness/QoS-status probe (used by Shield's cooperative health-check).
server.on("request", (req, res) => {
  if (req.method === "OPTIONS" && req.url === "/qos-status") {
    res.writeHead(200, { "X-QoS-Spec-Version": SUPPORTED_MAJOR, "Content-Type": "application/json" });
    res.end(JSON.stringify({
      mode: "cooperative",
      max_inflight: MAX_INFLIGHT,
      in_flight: inFlight,
      queue_depth: queue.length,
      dispatched_total: dispatched,
      overload_responses_total: overloadResponses,
    }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`
┌────────────────────────────────────────────────────────────────┐
│  x402-qos-cooperative — Operator Reference Implementation v1.0 │
├────────────────────────────────────────────────────────────────┤
│  Listening : http://127.0.0.1:${PORT}/                            │
│  Workers   : ${String(MAX_INFLIGHT).padEnd(4)}                                              │
│  Queue cap : ${String(MAX_QUEUE_DEPTH).padEnd(4)}                                              │
│  Latency   : ${String(SIMULATED_LATENCY_MS).padEnd(4)}ms simulated                                  │
└────────────────────────────────────────────────────────────────┘
  Point a Shield at me with QOS_MODE=cooperative and watch
  X-Priority-Score arrive in the logs above.
  `);
});
