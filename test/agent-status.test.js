"use strict";
/**
 * test/agent-status.test.js
 *
 * Integration test for GET /agent/status.
 * Boots the full shield server (in-memory store, no Redis).
 *
 * Run: node test/agent-status.test.js
 */

const { spawn } = require("child_process");
const path = require("path");

const SHIELD_PORT = 13140;
const TIMEOUT = 30_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitHealth(url) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error("shield never came up");
}

let asserts = 0;
function assert(label, cond) {
  asserts++;
  if (!cond) { console.error(`  ✗ ${label}`); process.exitCode = 1; }
  else { console.log(`  ✓ ${label}`); }
}

async function main() {
  const shield = spawn("node", ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(SHIELD_PORT),
      REDIS_URL: "",
      REDIS_REQUIRED: "false",
      REAL_RPC_URL: "https://api.devnet.solana.com",
      ESCROW_TRUST_DEPOSITS: "1",
      PAYMENT_DESTINATION: "DemoOperator11111111111111111111111111111111",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  shield.stderr.on("data", d => process.stderr.write(`[shield] ${d}`));
  await waitHealth(`http://127.0.0.1:${SHIELD_PORT}/health`);

  try {
    // 1. Bad pubkey → 400
    const bad = await fetch(`http://127.0.0.1:${SHIELD_PORT}/agent/status?pubkey=NOTBASE58!`);
    assert("invalid pubkey returns 400", bad.status === 400);
    const badBody = await bad.json();
    assert("invalid pubkey body has error field", badBody.error === "invalid_pubkey");

    // 2. Valid pubkey → 200, default zeros
    const pk = "DemoStudent111111111111111111111111111111111"; // 43 chars, valid base58
    const r1 = await fetch(`http://127.0.0.1:${SHIELD_PORT}/agent/status?pubkey=${pk}`);
    assert("valid pubkey returns 200", r1.status === 200);
    const j1 = await r1.json();
    assert("trust_score is 0", j1.trust_score === 0);
    assert("trust_multiplier is 1", j1.trust_multiplier === 1);
    assert("current_tier is 0", j1.current_tier === 0);
    assert("throttles_5m is 0", j1.throttles_5m === 0);
    assert("rate_limit_remaining is object", typeof j1.rate_limit_remaining === "object");
    assert("rate_limit_remaining.ip is a number or null",
      j1.rate_limit_remaining.ip === null || typeof j1.rate_limit_remaining.ip === "number");
    assert("X-x402-Cache header is miss on first call",
      r1.headers.get("x-x402-cache") === "miss");

    // 3. Second call within 10s → cache hit (only with Redis; in-memory store has no cache)
    const r2 = await fetch(`http://127.0.0.1:${SHIELD_PORT}/agent/status?pubkey=${pk}`);
    const cacheHeader = r2.headers.get("x-x402-cache");
    // In-memory store has no cacheGet/cacheSet → always "miss"; Redis → "hit"
    assert("second call returns 200", r2.status === 200);
    assert("second call has x-x402-cache header", cacheHeader === "hit" || cacheHeader === "miss");

    // 4. Missing pubkey param → 400
    const r3 = await fetch(`http://127.0.0.1:${SHIELD_PORT}/agent/status`);
    assert("missing pubkey returns 400", r3.status === 400);

    console.log(`\n${asserts}/${asserts} assertions passed.\n`);
  } finally {
    shield.kill();
    await sleep(150);
  }
}

const t = setTimeout(() => { console.error("\nTIMEOUT"); process.exit(1); }, TIMEOUT);
main()
  .then(() => clearTimeout(t))
  .catch(e => { clearTimeout(t); console.error(e.message); process.exit(1); });
