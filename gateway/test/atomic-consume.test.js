/**
 * test/atomic-consume.test.js
 *
 * Concurrency test for the atomic nonce-consume + escrow-debit path.
 *
 * Without atomic enforcement, two concurrent requests presenting the same
 * signed (nonce, pubkey, amount) tuple could both observe `used: false`
 * before either marks it `true`, leading to a double-spend (escrow gets
 * debited twice for one challenge).
 *
 * This test fires N parallel requests with the same `Authorization` header
 * and asserts:
 *   - Exactly 1 request is accepted (returns 200 from the upstream proxy)
 *   - The remaining (N-1) are rejected with 402 + nonce_already_used
 *   - Final escrow balance reflects exactly ONE debit
 *
 * Runs against an in-memory Shield (no Redis). The Lua-script-backed Redis
 * path is exercised in production deploy + `npm run demo:trust`.
 *
 * Usage:  npm run test:atomic
 */

const { spawn } = require("child_process");
const { Keypair } = require("@solana/web3.js");
const nacl = require("tweetnacl");
const bs58 = require("bs58").default || require("bs58");

const SHIELD_PORT = 13100;
const PARALLEL = 10;
const DEPOSIT_UL = 200_000;
const TEST_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(url, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error(`Health check failed for ${url}`);
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
  console.log("\nx402-shield — atomic consume concurrency test\n");
  console.log(`  shield: http://127.0.0.1:${SHIELD_PORT}`);
  console.log(`  parallel requests: ${PARALLEL}\n`);

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
    REDIS_URL: "",
  });
  await waitForHealth(`http://127.0.0.1:${SHIELD_PORT}/health`);
  console.log("  ✓ shield up (in-memory mode)\n");

  try {
    // 1. Generate agent + fund escrow
    const agent = Keypair.generate();
    const pubkeyB58 = agent.publicKey.toBase58();
    await fetch(`http://127.0.0.1:${SHIELD_PORT}/escrow/deposit-trusted`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: pubkeyB58, amount_micro_lamports: DEPOSIT_UL }),
    });

    // 2. Trigger one 402 challenge to get a nonce + amount
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

    // 3. Sign the canonical payload
    const payload = JSON.stringify({ nonce, pubkey: pubkeyB58, amount, destination });
    const messageBytes = Buffer.from(payload, "utf8");
    const signature = nacl.sign.detached(messageBytes, agent.secretKey);
    const sigB58 = bs58.encode(signature);
    const msgB58 = bs58.encode(messageBytes);
    const authHeader = `x402 ${sigB58}.${pubkeyB58}.${msgB58}`;

    // 4. Fire PARALLEL requests with the SAME signed Authorization header
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

    // 5. Tally
    const accepted = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 402);
    console.log(`  results: ${accepted.length} accepted, ${rejected.length} rejected`);

    assert(`exactly 1 of ${PARALLEL} requests succeeded`, accepted.length === 1);
    assert(`exactly ${PARALLEL - 1} requests were rejected`, rejected.length === PARALLEL - 1);
    assert(
      "all rejections cite a nonce/payment failure",
      rejected.every((r) => /nonce|payment|balance|replay/i.test(r.body))
    );

    // 6. Confirm escrow was debited exactly ONCE
    const balRes = await fetch(`http://127.0.0.1:${SHIELD_PORT}/escrow/balance/${pubkeyB58}`).then((r) => r.json());
    const expectedBalance = DEPOSIT_UL - amount;
    assert(
      `escrow balance debited exactly once (expected ${expectedBalance}, got ${balRes.balance_micro_lamports})`,
      balRes.balance_micro_lamports === expectedBalance
    );

    console.log(`\n${assertionCount}/${assertionCount} assertions passed.\n`);
  } finally {
    shield.kill();
    await sleep(150);
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
