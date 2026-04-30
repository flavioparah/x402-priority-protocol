#!/usr/bin/env node
/**
 * tools/stress-test/run-stress.js
 *
 * Multi-agent stress test execution. Loads agents.json (from spawn-agents.js)
 * and fires REQUESTS_PER_AGENT signed x402 RPC calls per agent, with bounded
 * parallelism. Emits per-request results to stress-results.json for report.js.
 *
 * Usage:
 *   node tools/stress-test/run-stress.js                                   # 500 req/agent, 10 parallel
 *   REQUESTS_PER_AGENT=200 PARALLEL_AGENTS=20 node tools/stress-test/run-stress.js
 *
 * Optional env:
 *   REQUESTS_PER_AGENT      (default 500)
 *   PARALLEL_AGENTS         number of agents firing concurrently (default 10)
 *   AGENTS_FILE             input (default tools/stress-test/agents.json)
 *   RESULTS_FILE            output (default tools/stress-test/stress-results.json)
 *   RPC_METHOD              JSON-RPC method to invoke (default getHealth — fastest, lowest cost)
 *   STAGGER_MS              delay between agent starts within a batch (default 0)
 */

const nacl = require("tweetnacl");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");

const AGENTS_FILE = process.env.AGENTS_FILE || path.join(__dirname, "agents.json");
const RESULTS_FILE = process.env.RESULTS_FILE || path.join(__dirname, "stress-results.json");
const REQUESTS_PER_AGENT = parseInt(process.env.REQUESTS_PER_AGENT || "500", 10);
const PARALLEL_AGENTS = parseInt(process.env.PARALLEL_AGENTS || "10", 10);
const RPC_METHOD = process.env.RPC_METHOD || "getHealth";
const STAGGER_MS = parseInt(process.env.STAGGER_MS || "0", 10);

const paint = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const ok = (m) => console.log(`  ${paint("32", "✓")} ${m}`);
const warn = (m) => console.log(`  ${paint("33", "!")} ${m}`);
const err = (m) => console.log(`  ${paint("31", "✗")} ${m}`);

if (!fs.existsSync(AGENTS_FILE)) {
  console.error(`Error: ${AGENTS_FILE} not found. Run spawn-agents.js first.`);
  process.exit(1);
}

const spawn = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
const SHIELD_URL = spawn.shield;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Single signed RPC call against the Shield. Returns timing + outcome. */
async function callOnce(agent, secretKeyBytes) {
  const t0 = performance.now();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: RPC_METHOD, params: [] });

  // Step 1: 402 challenge
  let r1;
  try {
    r1 = await fetch(`${SHIELD_URL}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": agent.pubkey },
      body,
    });
  } catch (e) {
    return { ok: false, phase: "challenge", error: e.message, latency: performance.now() - t0 };
  }
  if (r1.status === 200) {
    // Free pass (load below threshold) — the Shield didn't gate this one
    return { ok: true, phase: "free", status: 200, amount: 0, score: null, latency: performance.now() - t0 };
  }
  if (r1.status !== 402) {
    return { ok: false, phase: "challenge", status: r1.status, error: (await r1.text()).slice(0, 80), latency: performance.now() - t0 };
  }

  let challenge;
  try {
    challenge = await r1.json();
  } catch (e) {
    return { ok: false, phase: "challenge_parse", error: e.message, latency: performance.now() - t0 };
  }
  const amount = challenge.payment.amount_micro_lamports;
  const score = challenge.payment.trust_score;
  const nonce = challenge.payment.nonce;
  const destination = challenge.payment.destination;

  // Step 2: sign + retry
  const payload = JSON.stringify({ nonce, pubkey: agent.pubkey, amount, destination });
  const msg = Buffer.from(payload, "utf8");
  const sig = nacl.sign.detached(msg, secretKeyBytes);
  const auth = `x402 ${bs58.encode(sig)}.${agent.pubkey}.${bs58.encode(msg)}`;

  let r2;
  try {
    r2 = await fetch(`${SHIELD_URL}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": auth },
      body,
    });
  } catch (e) {
    return { ok: false, phase: "retry", error: e.message, amount, score, latency: performance.now() - t0 };
  }
  if (r2.status !== 200) {
    return { ok: false, phase: "retry", status: r2.status, error: (await r2.text()).slice(0, 80), amount, score, latency: performance.now() - t0 };
  }

  return { ok: true, phase: "paid", status: 200, amount, score, latency: performance.now() - t0 };
}

/** One agent burns its budget sequentially. Returns the array of per-request outcomes. */
async function runAgent(agent, allResults, startedAt) {
  const secretKeyBytes = bs58.decode(agent.secretKey);
  const results = [];
  for (let i = 0; i < REQUESTS_PER_AGENT; i++) {
    const r = await callOnce(agent, secretKeyBytes);
    r.agentIdx = agent.idx;
    r.reqIdx = i;
    r.tsRel = Date.now() - startedAt;
    results.push(r);
    allResults.push(r);
  }
  return results;
}

async function main() {
  console.log(paint("1", `\nx402 stress-test — run`));
  console.log(`  shield:                ${SHIELD_URL}`);
  console.log(`  mode:                  ${spawn.mode}`);
  console.log(`  agents loaded:         ${spawn.agents.length}`);
  console.log(`  requests per agent:    ${REQUESTS_PER_AGENT}`);
  console.log(`  parallel agents:       ${PARALLEL_AGENTS}`);
  console.log(`  rpc method:            ${RPC_METHOD}`);
  console.log(`  total requests:        ${(spawn.agents.length * REQUESTS_PER_AGENT).toLocaleString()}`);
  console.log(`  output:                ${RESULTS_FILE}`);

  const eligible = spawn.agents.filter((a) => !a.error && a.escrowBalance > 0);
  if (eligible.length < spawn.agents.length) {
    warn(`${spawn.agents.length - eligible.length} agents had spawn errors and will be skipped`);
  }
  if (eligible.length === 0) {
    err(`no eligible agents — bailing`);
    process.exit(2);
  }

  console.log(`\n${paint("1;36", "── Starting fire ─")} ${eligible.length} agents × ${REQUESTS_PER_AGENT} req`);
  const allResults = [];
  const startedAt = Date.now();

  // Live progress every 1s
  const progressInterval = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const total = eligible.length * REQUESTS_PER_AGENT;
    const done = allResults.length;
    const rps = done / Math.max(0.1, elapsed);
    process.stdout.write(`\r  done=${done.toLocaleString()}/${total.toLocaleString()}  rps=${rps.toFixed(1)}  elapsed=${elapsed.toFixed(0)}s  `);
  }, 1000);

  // Run agents in batches of PARALLEL_AGENTS
  for (let i = 0; i < eligible.length; i += PARALLEL_AGENTS) {
    const batch = eligible.slice(i, i + PARALLEL_AGENTS);
    await Promise.all(batch.map(async (agent, idx) => {
      if (STAGGER_MS) await sleep(idx * STAGGER_MS);
      await runAgent(agent, allResults, startedAt);
    }));
  }

  clearInterval(progressInterval);
  process.stdout.write("\n");

  const totalDur = ((Date.now() - startedAt) / 1000);
  const totalRps = allResults.length / totalDur;
  ok(`fired ${allResults.length.toLocaleString()} requests in ${totalDur.toFixed(1)}s — sustained ${totalRps.toFixed(1)} RPS`);

  // Persist raw results
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({
    runStartedAt: new Date(startedAt).toISOString(),
    runDurationSec: totalDur,
    shield: SHIELD_URL,
    mode: spawn.mode,
    agents: eligible.length,
    requestsPerAgent: REQUESTS_PER_AGENT,
    parallelAgents: PARALLEL_AGENTS,
    rpcMethod: RPC_METHOD,
    totalRequests: allResults.length,
    sustainedRps: totalRps,
    results: allResults,
  }, null, 2));
  ok(`wrote ${RESULTS_FILE}`);

  console.log(paint("32", `\n✓ STRESS RUN COMPLETE`));
  console.log(`  next: node tools/stress-test/report.js`);
}

main().catch((e) => {
  console.error(paint("31", `\nFailed: ${e.message}`));
  if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
});
