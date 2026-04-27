/**
 * test/atomic-consume-redis.test.js
 *
 * Redis-backed integration test for the atomic nonce-consume + escrow-debit
 * path. Mirrors the in-memory test (test/atomic-consume.test.js) but
 * exercises the Lua-scripted RedisStore.consumeNonceAndDebit() — the path
 * that runs in production.
 *
 * REQUIREMENT: a reachable Redis at REDIS_URL (default: redis://localhost:6379).
 * If REDIS_URL is unset, this test SKIPS with a clear message rather than
 * silently passing. Run locally with:
 *
 *   docker run -d --name x402-test-redis -p 6379:6379 redis:7-alpine
 *   REDIS_URL=redis://localhost:6379 npm run test:atomic:redis
 *   docker rm -f x402-test-redis
 *
 * Or against a deployed Redis (e.g. on kvm4):
 *
 *   REDIS_URL=redis://kvm4:6379 npm run test:atomic:redis    # if exposed
 *
 * Pass criteria: exactly 1 of 10 concurrent same-nonce requests succeeds,
 * 9 fail with nonce_already_used, escrow debited exactly once. Same as the
 * in-memory test but proves the Redis Lua script enforces atomicity.
 */

const { spawn } = require("child_process");
const { Keypair } = require("@solana/web3.js");
const nacl = require("tweetnacl");
const bs58 = require("bs58").default || require("bs58");

const REDIS_URL = process.env.REDIS_URL || "";
const SHIELD_PORT = 13200;
const PARALLEL = 10;
const DEPOSIT_UL = 200_000;
const TEST_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!REDIS_URL) {
  console.log("\nx402-shield — atomic consume (Redis) integration test\n");
  console.log("  ⚠ REDIS_URL not set — SKIPPED.");
  console.log("  To exercise the Redis-backed atomic path, set REDIS_URL");
  console.log("  to a reachable Redis instance and re-run this test:");
  console.log();
  console.log("    docker run -d --name x402-test-redis -p 6379:6379 redis:7-alpine");
  console.log("    REDIS_URL=redis://localhost:6379 npm run test:atomic:redis");
  console.log("    docker rm -f x402-test-redis");
  console.log();
  console.log("  In-memory equivalent already covered by:  npm run test:atomic\n");
  process.exit(0);
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error(`Health check failed for ${url}`);
}

async function flushTestKeys() {
  const Redis = require("ioredis");
  const r = new Redis(REDIS_URL);
  // Don't FLUSHDB — could nuke other tenant data on a shared Redis. Just
  // delete the namespace this test will use.
  const keys = await r.keys("x402:*");
  if (keys.length) await r.del(...keys);
  await r.quit();
}

function spawnShield(env) {
  const child = spawn("node", ["index.js"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[shield] ${d}`));
  return child;
}

let assertionCount = 0;
function assert(label, cond) {
  assertionCount++;
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
    throw new Error(`Assertion failed: ${label}`);
  }
  console.log(`  ✓ ${label}`);
}

async function main() {
  console.log("\nx402-shield — atomic consume (Redis Lua) integration test\n");
  console.log(`  redis:  ${REDIS_URL.replace(/:\/\/.*@/, "://[redacted]@")}`);
  console.log(`  shield: http://127.0.0.1:${SHIELD_PORT}`);
  console.log(`  parallel requests: ${PARALLEL}\n`);

  // 1. Clear any leftover keys from a prior run
  await flushTestKeys();
  console.log("  ✓ x402:* namespace flushed in Redis\n");

  const shield = spawnShield({
    PORT: String(SHIELD_PORT),
    REAL_RPC_URL: "https://api.devnet.solana.com",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    PAYMENT_DESTINATION: "DemoOperator11111111111111111111111111111111",
    ESCROW_TRUST_DEPOSITS: "1",
    RPC_LOAD_FORCE: "0.9",
    RPC_LOAD_THRESHOLD: "0.5",
    QOS_MAX_INFLIGHT: "200",
    QOS_BYPASS_THRESHOLD: "0.5",
    REDIS_URL,
  });
  await waitForHealth(`http://127.0.0.1:${SHIELD_PORT}/health`);

  try {
    // Confirm shield is actually using Redis
    const health = await fetch(`http://127.0.0.1:${SHIELD_PORT}/health`).then((r) => r.json());
    assert("shield reports store_backend=redis", health.store_backend === "redis");

    // 2. Generate agent + fund escrow
    const agent = Keypair.generate();
    const pubkeyB58 = agent.publicKey.toBase58();
    await fetch(`http://127.0.0.1:${SHIELD_PORT}/escrow/deposit-trusted`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: pubkeyB58, amount_micro_lamports: DEPOSIT_UL }),
    });

    // 3. Trigger one 402 challenge to get a nonce + amount
    const initial = await fetch(`http://127.0.0.1:${SHIELD_PORT}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-x402-Agent-Pubkey": pubkeyB58 },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
    });
    assert("first request returns 402", initial.status === 402);
    const challenge = await initial.json();
    const nonce = challenge.payment.nonce;
    const amount = challenge.payment.amount_micro_lamports;
    const destination = challenge.payment.destination;
    console.log(`  challenge: nonce=${nonce.slice(0, 8)}… amount=${amount}µL`);

    // 4. Sign the canonical payload
    const payload = JSON.stringify({ nonce, pubkey: pubkeyB58, amount, destination });
    const messageBytes = Buffer.from(payload, "utf8");
    const signature = nacl.sign.detached(messageBytes, agent.secretKey);
    const sigB58 = bs58.encode(signature);
    const msgB58 = bs58.encode(messageBytes);
    const authHeader = `x402 ${sigB58}.${pubkeyB58}.${msgB58}`;

    // 5. Fire PARALLEL requests with the SAME signed Authorization header.
    // The Redis Lua script must reject (PARALLEL - 1) of them with
    // nonce_already_used and accept exactly 1.
    const racers = [];
    for (let i = 0; i < PARALLEL; i++) {
      racers.push(
        fetch(`http://127.0.0.1:${SHIELD_PORT}/rpc`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": authHeader,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "getHealth", params: [] }),
        }).then(async (r) => ({ status: r.status, body: await r.text() }))
      );
    }
    const results = await Promise.all(racers);

    const accepted = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 402);
    console.log(`  results: ${accepted.length} accepted, ${rejected.length} rejected`);

    assert(`exactly 1 of ${PARALLEL} concurrent requests succeeded`, accepted.length === 1);
    assert(`exactly ${PARALLEL - 1} were rejected`, rejected.length === PARALLEL - 1);
    assert(
      "all rejections cite a nonce/payment failure",
      rejected.every((r) => /nonce|payment|balance|replay/i.test(r.body))
    );

    // 6. Confirm escrow was debited exactly ONCE
    const balRes = await fetch(`http://127.0.0.1:${SHIELD_PORT}/escrow/balance/${pubkeyB58}`).then((r) => r.json());
    const expectedBalance = DEPOSIT_UL - amount;
    assert(
      `Redis-backed escrow balance debited exactly once (expected ${expectedBalance}, got ${balRes.balance_micro_lamports})`,
      balRes.balance_micro_lamports === expectedBalance
    );

    // 7. Verify the nonce in Redis is marked used (not just deleted) — this
    // is the property that anti-replay depends on. A replay with the same
    // signed Authorization should still fail.
    const replayResp = await fetch(`http://127.0.0.1:${SHIELD_PORT}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "getHealth", params: [] }),
    });
    const replayBody = await replayResp.text();
    assert(
      `replay attempt rejected (status: ${replayResp.status})`,
      replayResp.status === 402 && /nonce|replay/i.test(replayBody)
    );

    console.log(`\n${assertionCount}/${assertionCount} assertions passed.\n`);
  } finally {
    shield.kill();
    await sleep(150);
    // Cleanup: don't leave x402:* keys behind
    await flushTestKeys();
  }
}

const timer = setTimeout(() => {
  console.error("\nTEST TIMED OUT");
  process.exit(1);
}, TEST_TIMEOUT_MS);

main()
  .then(() => clearTimeout(timer))
  .catch((e) => {
    clearTimeout(timer);
    console.error(`\nTEST FAILED: ${e.message}`);
    process.exit(1);
  });
