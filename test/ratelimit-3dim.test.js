const { spawn } = require("child_process");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 13311;

let n = 0, failed = 0;
function check(label, cond) {
  n++;
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

async function waitHealth(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(150);
  }
  return false;
}

async function fireUntilBlocked(url, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await fetch(url);
    if (r.status === 429) {
      return {
        i: i + 1,
        status: r.status,
        reason: r.headers.get("x-x402-reason"),
        retry: r.headers.get("retry-after"),
      };
    }
  }
  return null;
}

function spawnShield(env) {
  const child = spawn(process.execPath, ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      ...env,
      REDIS_URL: "",
      PORT: String(PORT),
      REAL_RPC_URL: "https://api.devnet.solana.com",
      PAYMENT_DESTINATION: "DemoOperator11111111111111111111111111111111",
      RPC_LOAD_FORCE: "0",
      REDIS_REQUIRED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function caseBucket({ envCrushed, dim, route, expectedReason }) {
  console.log(`\n— case: ${dim} bucket (${route}) crushed —`);
  const shield = spawnShield({ ...envCrushed, RATELIMIT_ENABLED: "true" });
  try {
    const ok = await waitHealth(`http://127.0.0.1:${PORT}/health`);
    if (!ok) {
      check(`${dim}: shield boot`, false);
      return;
    }
    const result = await fireUntilBlocked(`http://127.0.0.1:${PORT}${route}`, 8);
    check(`${dim}: bucket triggered 429`, result !== null);
    if (result) {
      check(`${dim}: X-x402-Reason = ${expectedReason}`, result.reason === expectedReason);
      check(`${dim}: Retry-After is positive integer`,
        /^\d+$/.test(result.retry || "") && parseInt(result.retry, 10) > 0);
    }
  } finally {
    shield.kill();
    await sleep(300);
  }
}

(async () => {
  // /info uses rl.meta. Setting META_IP_LIMIT=2 crushes the IP bucket.
  await caseBucket({
    envCrushed: { META_IP_LIMIT: "2" },
    dim: "ip",
    route: "/info",
    expectedReason: "ip-rate-limit",
  });

  // X402_TEST_GLOBAL_ON_META=1 + RATE_GLOBAL_LIMIT=2 crushes the global bucket.
  // META_IP_LIMIT must be high so global trips first.
  await caseBucket({
    envCrushed: {
      X402_TEST_GLOBAL_ON_META: "1",
      RATE_GLOBAL_LIMIT: "2",
      META_IP_LIMIT: "10000",
    },
    dim: "global",
    route: "/info",
    expectedReason: "global-rate-limit",
  });

  // /x-test/pubkey-bucket gated by X402_ENABLE_TEST_ROUTES.
  await caseBucket({
    envCrushed: {
      RATE_PUBKEY_LIMIT: "2",
      X402_ENABLE_TEST_ROUTES: "1",
    },
    dim: "pubkey",
    route: "/x-test/pubkey-bucket",
    expectedReason: "pubkey-rate-limit",
  });

  if (failed > 0) {
    console.error(`\n${failed} of ${n} assertions failed.\n`);
    process.exit(1);
  }
  console.log(`\nAll ${n} assertions passed.\n`);
})().catch((e) => { console.error(e); process.exit(1); });
