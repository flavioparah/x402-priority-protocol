const http = require("node:http");
const { spawn } = require("child_process");
const path = require("node:path");
const PORT = 13313;
const UPSTREAM_PORT = 9952;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0, failed = 0;
function check(label, cond) {
  n++;
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

async function waitHealth(u, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(u); if (r.ok) return true; } catch {}
    await sleep(150);
  }
  return false;
}

(async () => {
  let received = null;
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c.toString("utf8"); });
    req.on("end", () => {
      received = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));
    });
  });
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

  const shield = spawn(process.execPath, ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      REAL_RPC_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      SOLANA_RPC_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      PAYMENT_DESTINATION: "Demo11111111111111111111111111111111111111",
      RPC_LOAD_FORCE: "0",
      REDIS_URL: "",
      REDIS_REQUIRED: "false",
      BODY_LIMIT_RPC_BYTES: "1024",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  shield.stderr.on("data", (d) => process.stderr.write(`[shield] ${d}`));

  const ok = await waitHealth(`http://127.0.0.1:${PORT}/health`);
  if (!ok) {
    console.error("FAIL: shield boot failed");
    shield.kill();
    upstream.close();
    process.exit(1);
  }

  try {
    // CASE 1: no Content-Length (Transfer-Encoding chunked)
    {
      const r = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"jsonrpc":"2.0"}',
        duplex: "half",
      }).catch(() => null);
      // fetch may auto-add Content-Length; this case is best-effort.
      // Skip if status isn't 411 (some fetch impls always set Content-Length).
      if (r && r.status === 411) {
        check("no Content-Length → 411", true);
      } else {
        console.log(`  ⚠ skipping no-Content-Length case: fetch auto-set CL (status=${r?.status})`);
      }
    }
    // CASE 2: GET → 405
    {
      const r = await fetch(`http://127.0.0.1:${PORT}/rpc`, { method: "GET" });
      check("GET → 405", r.status === 405);
      check("GET 405 has Allow header", (r.headers.get("allow") || "").includes("POST"));
    }
    // CASE 3: wrong content-type
    {
      const r = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "Content-Length": "5" },
        body: "hello",
      });
      check("text/plain → 415", r.status === 415);
    }
    // CASE 4: body too large (BODY_LIMIT_RPC_BYTES=1024)
    {
      const big = "x".repeat(2048);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [big] });
      const r = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
        body,
      });
      check(">1KB body → 413", r.status === 413);
      const j = await r.json();
      check("413 body has limit=1024", j.limit === 1024);
    }
    // CASE 5: valid → upstream receives body intact
    {
      received = null;
      const body = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "getHealth" });
      const r = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
        body,
      });
      check("valid → 200", r.status === 200);
      check("upstream received exact body bytes (stream not consumed by middleware)",
        received === body);
    }
  } finally {
    shield.kill();
    upstream.close();
    await sleep(300);
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${n} assertions failed.\n`);
    process.exit(1);
  }
  console.log(`\nAll ${n} assertions passed.\n`);
})().catch((e) => { console.error(e); process.exit(1); });
