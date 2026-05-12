const { spawn } = require("child_process");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function assert(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

function spawnShield(env, port) {
  const child = spawn(process.execPath, ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  return { child, getOutput: () => ({ stdout, stderr }) };
}

async function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => { clearTimeout(t); resolve(code); });
  });
}
async function waitHealth(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {}
    await sleep(100);
  }
  return false;
}

async function testGuardA() {
  console.log("\n  Subtest A: ESCROW_TRUST_DEPOSITS=1 + mainnet → exit 1");
  const port = 13800;
  const { child, getOutput } = spawnShield({
    ESCROW_TRUST_DEPOSITS: "1",
    NETWORK: "mainnet",
    REAL_RPC_URL: "https://api.mainnet-beta.solana.com",
    REDIS_REQUIRED: "false",
  }, port);
  const code = await waitExit(child, 5000);
  const { stderr, stdout } = getOutput();
  assert(`(A) process exited (code=${code})`, code === 1);
  const combined = stdout + stderr;
  assert("(A) message mentions trust + mainnet",
    /trust.*mainnet|mainnet.*trust/i.test(combined));
}

async function testGuardB() {
  console.log("\n  Subtest B: REDIS_REQUIRED=true + Redis down → exit 1");
  const port = 13801;
  const { child, getOutput } = spawnShield({
    REDIS_URL: "redis://127.0.0.1:1",
    REDIS_REQUIRED: "true",
    TEST_REDIS_REQUIRED_TIMEOUT_MS: "1500",
    PAYMENT_DESTINATION: "11111111111111111111111111111111",
  }, port);
  const code = await waitExit(child, 8000);
  const { stderr, stdout } = getOutput();
  assert(`(B) process exited (code=${code})`, code === 1);
  assert("(B) message mentions redis required",
    /redis.*required|redis_required/i.test(stdout + stderr));
}

async function testGuardC() {
  console.log("\n  Subtest C: ADMIN_KEYS_JSON unset → /admin/* returns 503");
  const port = 13802;
  const { child } = spawnShield({
    RPC_LOAD_FORCE: "0",
    RPC_LOAD_THRESHOLD: "0.99",
    REDIS_REQUIRED: "false",
    PAYMENT_DESTINATION: "11111111111111111111111111111111",
  }, port);
  try {
    const ok = await waitHealth(port, 8000);
    assert("(C) shield booted normally without ADMIN_KEYS_JSON", ok);
    const r = await fetch(`http://127.0.0.1:${port}/admin/ban`, { method: "POST" });
    assert(`(C) /admin/ban returns 503 (got ${r.status})`, r.status === 503);
    assert("(C) X-Admin-Status: not_configured present",
      r.headers.get("x-admin-status") === "not_configured");
    const r2 = await fetch(`http://127.0.0.1:${port}/admin/abuse-log`);
    assert(`(C) /admin/abuse-log also 503 (got ${r2.status})`, r2.status === 503);
  } finally {
    child.kill();
    await waitExit(child, 3000);
  }
}

async function main() {
  console.log("\nx402-shield — boot guards (spec §10.8)\n");
  await testGuardA();
  await testGuardB();
  await testGuardC();

  if (failed > 0) { console.error(`\n${failed} assertion(s) failed.\n`); process.exit(1); }
  console.log("\nAll boot-guard assertions passed.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
