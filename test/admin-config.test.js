"use strict";
/**
 * test/admin-config.test.js — Phase 4 Task 17
 *
 * Integration tests for GET /admin/config + POST /admin/config (hot-reload).
 * Spawns the full index.js server with HMAC admin keys configured.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");

const SHIELD_PORT = 13190;
const SECRET_HEX = "44".repeat(32);
const KEY_ID = "ops-cfg-001";

function sign(method, urlPath, body = "") {
  const u = new URL("http://x" + urlPath);
  const sq = [...u.searchParams.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const ts = Math.floor(Date.now() / 1000);
  const bs = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [method, u.pathname, sq, String(ts), KEY_ID, bs].join("\n");
  const sig = crypto
    .createHmac("sha256", Buffer.from(SECRET_HEX, "hex"))
    .update(canonical)
    .digest("hex");
  return { ts, sig };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let asserts = 0;
let failures = 0;

function ok(label, cond) {
  asserts++;
  if (!cond) {
    console.error(`  ✗ ${label}`);
    failures++;
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: {
      ...process.env,
      PORT: String(SHIELD_PORT),
      REDIS_URL: "",
      REAL_RPC_URL: "https://api.devnet.solana.com",
      ADMIN_KEYS_JSON: JSON.stringify({ [KEY_ID]: SECRET_HEX }),
      PAYMENT_DESTINATION: "DemoOp11111111111111111111111111111111111",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d) => process.stdout.write(`[shield] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[shield] ${d}`));

  // Wait for server to be ready (up to 7.5 s)
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${SHIELD_PORT}/health`);
      if (r.ok) break;
    } catch {}
    await sleep(150);
  }

  try {
    // 1. GET /admin/config → 200, shape check
    {
      const { ts, sig } = sign("GET", "/admin/config");
      const r = await fetch(`http://127.0.0.1:${SHIELD_PORT}/admin/config`, {
        headers: {
          "X-Admin-Key-Id": KEY_ID,
          "X-Admin-Timestamp": String(ts),
          "X-Admin-Auth": sig,
        },
      });
      ok("GET /admin/config → 200", r.status === 200);
      const j = await r.json();
      ok("config has RATE_IP_LIMIT (number)", typeof j.config.RATE_IP_LIMIT === "number");
      ok(
        "config has ENFORCEMENT_TIER_MAX default = 3",
        j.config.ENFORCEMENT_TIER_MAX === 3
      );
    }

    // 2. POST with non-whitelisted key → 400
    {
      const body = JSON.stringify({
        updates: { NONEXISTENT_KEY: 999 },
        reason: "test bad key",
      });
      const { ts, sig } = sign("POST", "/admin/config", body);
      const r = await fetch(`http://127.0.0.1:${SHIELD_PORT}/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key-Id": KEY_ID,
          "X-Admin-Timestamp": String(ts),
          "X-Admin-Auth": sig,
        },
        body,
      });
      ok("non-whitelisted key → 400", r.status === 400);
      const j = await r.json();
      ok("error is update_rejected", j.error === "update_rejected");
    }

    // 3. POST missing reason → 400
    {
      const body = JSON.stringify({ updates: { RATE_IP_LIMIT: 120 } });
      const { ts, sig } = sign("POST", "/admin/config", body);
      const r = await fetch(`http://127.0.0.1:${SHIELD_PORT}/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key-Id": KEY_ID,
          "X-Admin-Timestamp": String(ts),
          "X-Admin-Auth": sig,
        },
        body,
      });
      ok("missing reason → 400", r.status === 400);
    }

    // 4. POST valid update → 200, change visible in subsequent GET
    {
      const body = JSON.stringify({
        updates: { RATE_IP_LIMIT: 150 },
        reason: "raise per-IP limit during launch",
      });
      const { ts, sig } = sign("POST", "/admin/config", body);
      const r = await fetch(`http://127.0.0.1:${SHIELD_PORT}/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key-Id": KEY_ID,
          "X-Admin-Timestamp": String(ts),
          "X-Admin-Auth": sig,
        },
        body,
      });
      ok("valid update → 200", r.status === 200);
      const j = await r.json();
      ok("applied array length = 1", Array.isArray(j.applied) && j.applied.length === 1);
      ok("config.RATE_IP_LIMIT now 150", j.config.RATE_IP_LIMIT === 150);
    }

    // 5. Tier 4 promotion without flag → 400
    {
      const body = JSON.stringify({
        updates: { ENFORCEMENT_TIER_MAX: 4 },
        reason: "promote",
        meta: {},
      });
      const { ts, sig } = sign("POST", "/admin/config", body);
      const r = await fetch(`http://127.0.0.1:${SHIELD_PORT}/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key-Id": KEY_ID,
          "X-Admin-Timestamp": String(ts),
          "X-Admin-Auth": sig,
        },
        body,
      });
      ok("tier 4 without manual_promotion flag → 400", r.status === 400);
    }

    // 6. Tier 4 with flag → 200
    {
      const body = JSON.stringify({
        updates: { ENFORCEMENT_TIER_MAX: 4 },
        reason: "post-audit promotion",
        meta: { manual_promotion: true },
      });
      const { ts, sig } = sign("POST", "/admin/config", body);
      const r = await fetch(`http://127.0.0.1:${SHIELD_PORT}/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key-Id": KEY_ID,
          "X-Admin-Timestamp": String(ts),
          "X-Admin-Auth": sig,
        },
        body,
      });
      ok("tier 4 with manual_promotion=true → 200", r.status === 200);
      const j = await r.json();
      ok("config.ENFORCEMENT_TIER_MAX now 4", j.config.ENFORCEMENT_TIER_MAX === 4);
    }

    console.log(
      `\n${asserts - failures}/${asserts} assertions passed${failures > 0 ? ` (${failures} failed)` : ""}.\n`
    );
  } finally {
    child.kill();
    await sleep(150);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
