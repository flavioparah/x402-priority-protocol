#!/usr/bin/env node
/**
 * tools/stress-test/report.js
 *
 * Aggregates and prints metrics from stress-results.json. Optionally
 * emits a CSV at stress-results.csv for further analysis.
 *
 * Usage:
 *   node tools/stress-test/report.js
 */

const fs = require("fs");
const path = require("path");

const RESULTS_FILE = process.env.RESULTS_FILE || path.join(__dirname, "stress-results.json");
const CSV_FILE = process.env.CSV_FILE || path.join(__dirname, "stress-results.csv");
const EMIT_CSV = process.env.EMIT_CSV !== "0";

const paint = (c, s) => `\x1b[${c}m${s}\x1b[0m`;

if (!fs.existsSync(RESULTS_FILE)) {
  console.error(`Error: ${RESULTS_FILE} not found. Run run-stress.js first.`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
const r = data.results;

function pct(arr, q) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

const sumTotal = r.length;
const successes = r.filter((x) => x.ok);
const failures = r.filter((x) => !x.ok);
const paid = r.filter((x) => x.phase === "paid");
const free = r.filter((x) => x.phase === "free");

const latenciesAll = r.map((x) => x.latency).filter((x) => Number.isFinite(x));
const latenciesPaid = paid.map((x) => x.latency);

const totalCharged = paid.reduce((s, x) => s + (x.amount || 0), 0);

console.log(paint("1", `\n═══ x402 stress-test report ═══\n`));
console.log(`  shield:                ${data.shield}`);
console.log(`  mode:                  ${data.mode}`);
console.log(`  run started:           ${data.runStartedAt}`);
console.log(`  duration:              ${data.runDurationSec.toFixed(1)}s`);
console.log(`  agents:                ${data.agents}`);
console.log(`  requests per agent:    ${data.requestsPerAgent}`);
console.log(`  parallel agents:       ${data.parallelAgents}`);

console.log(paint("1", `\n── Volume ──`));
console.log(`  total requests:        ${sumTotal.toLocaleString()}`);
console.log(`  sustained RPS:         ${data.sustainedRps.toFixed(2)}`);
console.log(`  paid requests:         ${paid.length.toLocaleString()} (${(paid.length / sumTotal * 100).toFixed(1)}%)`);
console.log(`  free passes:           ${free.length.toLocaleString()} (${(free.length / sumTotal * 100).toFixed(1)}%)`);
console.log(`  failures:              ${failures.length.toLocaleString()} (${(failures.length / sumTotal * 100).toFixed(1)}%)`);

console.log(paint("1", `\n── Latency (all requests, ms) ──`));
console.log(`  mean:                  ${(latenciesAll.reduce((s, x) => s + x, 0) / Math.max(1, latenciesAll.length)).toFixed(1)}`);
console.log(`  p50:                   ${pct(latenciesAll, 0.5).toFixed(1)}`);
console.log(`  p90:                   ${pct(latenciesAll, 0.9).toFixed(1)}`);
console.log(`  p95:                   ${pct(latenciesAll, 0.95).toFixed(1)}`);
console.log(`  p99:                   ${pct(latenciesAll, 0.99).toFixed(1)}`);
console.log(`  max:                   ${Math.max(...latenciesAll).toFixed(1)}`);

console.log(paint("1", `\n── Latency (paid only, ms) ──`));
if (latenciesPaid.length > 0) {
  console.log(`  mean:                  ${(latenciesPaid.reduce((s, x) => s + x, 0) / latenciesPaid.length).toFixed(1)}`);
  console.log(`  p50:                   ${pct(latenciesPaid, 0.5).toFixed(1)}`);
  console.log(`  p95:                   ${pct(latenciesPaid, 0.95).toFixed(1)}`);
  console.log(`  p99:                   ${pct(latenciesPaid, 0.99).toFixed(1)}`);
} else {
  console.log(`  (no paid requests)`);
}

console.log(paint("1", `\n── Cost ──`));
console.log(`  total µL charged:      ${totalCharged.toLocaleString()}`);
console.log(`  total lamports:        ${(totalCharged / 1000).toLocaleString()}`);
console.log(`  total SOL:             ${(totalCharged / 1_000_000_000_000).toFixed(9)}`);
const meanAmount = paid.length ? totalCharged / paid.length : 0;
console.log(`  mean cost/req (µL):    ${meanAmount.toFixed(0)}`);

console.log(paint("1", `\n── Failure breakdown ──`));
if (failures.length === 0) {
  console.log(`  none — all requests succeeded`);
} else {
  const byPhase = {};
  failures.forEach((f) => {
    const k = `${f.phase}/${f.status || "?"}`;
    byPhase[k] = (byPhase[k] || 0) + 1;
  });
  Object.entries(byPhase).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
    console.log(`  ${k.padEnd(24)} ${n.toLocaleString()}`);
  });
}

// Trust-Score progression — sample of agent 0's score over the run
console.log(paint("1", `\n── Trust-Score progression (agent 0) ──`));
const agent0Paid = r.filter((x) => x.agentIdx === 0 && x.phase === "paid");
if (agent0Paid.length > 0) {
  const samples = [agent0Paid[0], agent0Paid[Math.floor(agent0Paid.length / 4)], agent0Paid[Math.floor(agent0Paid.length / 2)], agent0Paid[Math.floor(agent0Paid.length * 3 / 4)], agent0Paid[agent0Paid.length - 1]];
  console.log(`  req 1               → score ${samples[0].score}, amount ${samples[0].amount} µL`);
  console.log(`  req ${Math.floor(agent0Paid.length / 4) + 1}              → score ${samples[1].score}, amount ${samples[1].amount} µL`);
  console.log(`  req ${Math.floor(agent0Paid.length / 2) + 1}              → score ${samples[2].score}, amount ${samples[2].amount} µL`);
  console.log(`  req ${Math.floor(agent0Paid.length * 3 / 4) + 1}              → score ${samples[3].score}, amount ${samples[3].amount} µL`);
  console.log(`  req ${agent0Paid.length}              → score ${samples[4].score}, amount ${samples[4].amount} µL`);
}

// Per-agent summary (top 10 by request count)
console.log(paint("1", `\n── Per-agent summary (top 10) ──`));
const byAgent = {};
r.forEach((x) => {
  const a = byAgent[x.agentIdx] = byAgent[x.agentIdx] || { count: 0, ok: 0, failed: 0, charged: 0, lat: [] };
  a.count++;
  if (x.ok) a.ok++; else a.failed++;
  if (x.amount) a.charged += x.amount;
  if (Number.isFinite(x.latency)) a.lat.push(x.latency);
});
console.log(`  agent  count  ok  failed  charged_µL    p50ms  p95ms`);
Object.entries(byAgent).slice(0, 10).forEach(([idx, a]) => {
  console.log(`  ${String(idx).padStart(5)}  ${String(a.count).padStart(5)}  ${String(a.ok).padStart(2)}  ${String(a.failed).padStart(6)}  ${String(a.charged).padStart(10)}    ${pct(a.lat, 0.5).toFixed(0).padStart(5)}  ${pct(a.lat, 0.95).toFixed(0).padStart(5)}`);
});

if (EMIT_CSV) {
  const lines = ["agentIdx,reqIdx,tsRel,phase,status,ok,amount,score,latency,error"];
  r.forEach((x) => {
    lines.push([x.agentIdx, x.reqIdx, x.tsRel, x.phase, x.status || "", x.ok ? 1 : 0, x.amount || "", x.score ?? "", x.latency.toFixed(1), (x.error || "").replace(/,/g, ";")].join(","));
  });
  fs.writeFileSync(CSV_FILE, lines.join("\n"));
  console.log(paint("1", `\n── CSV ──`));
  console.log(`  wrote ${CSV_FILE} (${(fs.statSync(CSV_FILE).size / 1024).toFixed(1)} KB)`);
}

console.log(paint("32", `\n✓ REPORT DONE\n`));
