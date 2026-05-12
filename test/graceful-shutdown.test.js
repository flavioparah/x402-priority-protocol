const { spawn } = require("child_process");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function assert(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

async function waitHealth(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {}
    await sleep(100);
  }
  return false;
}

async function main() {
  if (process.platform === "win32") {
    console.log("\n  ⚠ skipping on win32: Node treats cross-process signals as forced termination,");
    console.log("    so SIGINT/SIGTERM cannot trigger the child's shutdown handler.");
    console.log("    Production runs on Linux containers where the signal contract holds.\n");
    console.log("Graceful-shutdown test skipped (platform=win32).\n");
    return;
  }
  const port = 14000;
  const child = spawn(process.execPath, ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      RPC_LOAD_FORCE: "0",
      REDIS_REQUIRED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exitCode = null;
  child.on("exit", (c) => { exitCode = c; });

  const ok = await waitHealth(port);
  assert("shield booted", ok);

  const before = await fetch(`http://127.0.0.1:${port}/health`);
  assert(`/health 200 before SIGTERM (got ${before.status})`,
    before.status === 200);

  const sig = process.platform === "win32" ? "SIGINT" : "SIGTERM";
  child.kill(sig);

  let degraded = false;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.status === 503) {
        const body = await r.json().catch(() => ({}));
        if (body && /shutting/.test(String(body.status || ""))) { degraded = true; break; }
      }
    } catch { break; }
    await sleep(50);
  }
  assert("(within 2s) /health flips to 503 status=shutting_down OR connection refused",
    degraded || exitCode !== null);

  const exitDeadline = Date.now() + 30_000;
  while (Date.now() < exitDeadline && exitCode === null) await sleep(100);
  assert(`process exited with code 0 (got ${exitCode})`, exitCode === 0);

  if (failed > 0) { console.error(`\n${failed} failed.\n`); process.exit(1); }
  console.log("\nGraceful-shutdown assertions passed.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
