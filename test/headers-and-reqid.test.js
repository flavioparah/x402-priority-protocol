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
  const port = 13900;
  const child = spawn(process.execPath, ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), RPC_LOAD_FORCE: "0", REDIS_REQUIRED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const ok = await waitHealth(port);
    assert("shield booted", ok);

    const r = await fetch(`http://127.0.0.1:${port}/health`);
    const h = r.headers;
    assert("Strict-Transport-Security present (1y)",
      /max-age=31536000/.test(h.get("strict-transport-security") || ""));
    assert("X-Content-Type-Options: nosniff",
      h.get("x-content-type-options") === "nosniff");
    assert("X-Frame-Options present", !!h.get("x-frame-options"));
    assert("X-Powered-By absent", !h.get("x-powered-by"));
    assert("ETag absent on GET /health", !h.get("etag"));

    const reqId = h.get("x-request-id") || "";
    assert(`X-Request-ID is 8 hex chars (got "${reqId}")`,
      /^[a-f0-9]{8}$/.test(reqId));

    const r2 = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "X-Request-ID": "AAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    const reqId2 = r2.headers.get("x-request-id") || "";
    assert(`server-side X-Request-ID overrides client (got "${reqId2}")`,
      /^[a-f0-9]{8}$/.test(reqId2) && reqId2 !== "AAAAAAAAAAAAAAAAAAAAAAAA");
  } finally {
    child.kill();
    await sleep(300);
  }
  if (failed > 0) { console.error(`\n${failed} failed.\n`); process.exit(1); }
  console.log("\nAll header/req-id assertions passed.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
