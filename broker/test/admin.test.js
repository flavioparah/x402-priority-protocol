/**
 * broker/test/admin.test.js
 *
 * Integration tests for /admin/* routes (provider lifecycle).
 *
 * Same pattern as integration.test.js: boot the broker in-process on a
 * random port, talk to it over real HTTP via Node's `http` module. No
 * mocks, no supertest, no fetch lib.
 *
 * IMPORTANT: BROKER_ADMIN_TOKEN must be set BEFORE requiring the app, so
 * that the auth middleware sees the configured token on every request.
 * (The middleware re-reads the env var on each call, but pinning it here
 * documents the contract clearly.)
 *
 * Run: node broker/test/admin.test.js
 */

process.env.BROKER_ADMIN_TOKEN = "test-token";

const http = require("http");
const app = require("../index");
const store = require("../store");
const { generateKeypair } = require("../lib/signature");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Tiny HTTP client (copied from integration.test.js — bounded helper) ────

function request(server, opts, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: "127.0.0.1",
      port: addr.port,
      path: opts.path,
      method: opts.method || "GET",
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(buf); } catch { json = buf; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function withToken(extra) {
  return { "X-Admin-Token": "test-token", ...(extra || {}) };
}

// ── Test plan ──────────────────────────────────────────────────────────────

(async () => {
  console.log("\nx402 Trust-Score Broker — admin route tests\n");

  // Reset store so the hard-coded test-op-A from index.js doesn't bleed in.
  store._resetAll();

  const kp1 = generateKeypair();
  const kp2 = generateKeypair();
  const kp3 = generateKeypair();
  const PROVIDER_ID = "admin-test-op-1";
  const PROVIDER_ID_2 = "admin-test-op-2";
  const PROVIDER_ID_PROD = "admin-test-op-prod";

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  try {
    // ── Auth ─────────────────────────────────────────────────────────────
    await test("POST /admin/providers without token → 401", async () => {
      const r = await request(server, { path: "/admin/providers", method: "POST" }, {
        id: PROVIDER_ID, pubkey: kp1.publicKey, tier: "alpha",
      });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    await test("POST /admin/providers with wrong token → 401", async () => {
      const r = await request(server, {
        path: "/admin/providers",
        method: "POST",
        headers: { "X-Admin-Token": "wrong-token" },
      }, { id: PROVIDER_ID, pubkey: kp1.publicKey, tier: "alpha" });
      assert(r.status === 401, `expected 401, got ${r.status}`);
      assert(r.body.error === "unauthorized", `expected error=unauthorized, got ${r.body.error}`);
    });

    await test("GET /admin/providers without token → 401", async () => {
      const r = await request(server, { path: "/admin/providers", method: "GET" });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    // ── Register ─────────────────────────────────────────────────────────
    await test("POST /admin/providers with valid token + body → 200", async () => {
      const r = await request(server, {
        path: "/admin/providers", method: "POST", headers: withToken(),
      }, { id: PROVIDER_ID, pubkey: kp1.publicKey, tier: "alpha" });
      assert(r.status === 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert(r.body.id === PROVIDER_ID, `id mismatch`);
      assert(r.body.pubkey === kp1.publicKey, `pubkey mismatch`);
      assert(r.body.tier === "alpha", `tier=${r.body.tier}`);
      assert(r.body.status === "active", `status=${r.body.status}`);
      assert(typeof r.body.registeredAt === "number", `registeredAt missing/bad type`);
      assert(r.body.attestedCount30d === 0, `attestedCount30d=${r.body.attestedCount30d}`);
    });

    await test("POST /admin/providers with duplicate id → 409", async () => {
      const r = await request(server, {
        path: "/admin/providers", method: "POST", headers: withToken(),
      }, { id: PROVIDER_ID, pubkey: kp2.publicKey, tier: "beta" });
      assert(r.status === 409, `expected 409, got ${r.status}`);
      assert(r.body.error === "provider_exists", `error=${r.body.error}`);
    });

    await test("POST /admin/providers with invalid pubkey (non-bs58 chars) → 400", async () => {
      const r = await request(server, {
        path: "/admin/providers", method: "POST", headers: withToken(),
      }, { id: "bad-pubkey-1", pubkey: "not-valid-base58-O0Il!", tier: "alpha" });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(r.body.error === "invalid_pubkey", `error=${r.body.error}`);
    });

    await test("POST /admin/providers with bs58 but wrong length → 400", async () => {
      // "abc" is valid bs58 but decodes to 2 bytes, not 32.
      const r = await request(server, {
        path: "/admin/providers", method: "POST", headers: withToken(),
      }, { id: "bad-pubkey-2", pubkey: "abc", tier: "alpha" });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(r.body.error === "invalid_pubkey", `error=${r.body.error}`);
    });

    await test("POST /admin/providers with invalid tier → 400", async () => {
      const r = await request(server, {
        path: "/admin/providers", method: "POST", headers: withToken(),
      }, { id: "bad-tier-1", pubkey: kp2.publicKey, tier: "platinum" });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(r.body.error === "invalid_tier", `error=${r.body.error}`);
    });

    await test("POST /admin/providers missing pubkey → 400", async () => {
      const r = await request(server, {
        path: "/admin/providers", method: "POST", headers: withToken(),
      }, { id: "missing-pubkey", tier: "alpha" });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(r.body.error === "missing_field", `error=${r.body.error}`);
    });

    // ── List ─────────────────────────────────────────────────────────────
    await test("GET /admin/providers → returns array including the registered one", async () => {
      const r = await request(server, {
        path: "/admin/providers", method: "GET", headers: withToken(),
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(Array.isArray(r.body), `expected array`);
      assert(r.body.length >= 1, `expected at least 1 provider, got ${r.body.length}`);
      const found = r.body.find((p) => p.id === PROVIDER_ID);
      assert(found, `registered provider not in list`);
      assert(found.tier === "alpha", `tier mismatch in list`);
      assert(found.status === "active", `status mismatch in list`);
    });

    // ── Show ─────────────────────────────────────────────────────────────
    await test("GET /admin/providers/:id → returns the provider", async () => {
      const r = await request(server, {
        path: `/admin/providers/${PROVIDER_ID}`, method: "GET", headers: withToken(),
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.id === PROVIDER_ID, `id mismatch`);
      assert(r.body.pubkey === kp1.publicKey, `pubkey mismatch`);
    });

    await test("GET /admin/providers/:id → 404 for unknown id", async () => {
      const r = await request(server, {
        path: "/admin/providers/does-not-exist", method: "GET", headers: withToken(),
      });
      assert(r.status === 404, `expected 404, got ${r.status}`);
      assert(r.body.error === "not_found", `error=${r.body.error}`);
    });

    // ── Suspend / unsuspend ──────────────────────────────────────────────
    await test("POST /admin/providers/:id/suspend → status changes to suspended", async () => {
      const r = await request(server, {
        path: `/admin/providers/${PROVIDER_ID}/suspend`, method: "POST", headers: withToken(),
      }, { reason: "test-suspend" });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.status === "suspended", `status=${r.body.status}`);
      assert(r.body.reason === "test-suspend", `reason=${r.body.reason}`);

      const detail = await request(server, {
        path: `/admin/providers/${PROVIDER_ID}`, method: "GET", headers: withToken(),
      });
      assert(detail.body.status === "suspended", `subsequent GET status=${detail.body.status}`);
    });

    await test("POST /admin/providers/:id/suspend on unknown id → 404", async () => {
      const r = await request(server, {
        path: "/admin/providers/ghost/suspend", method: "POST", headers: withToken(),
      }, { reason: "x" });
      assert(r.status === 404, `expected 404, got ${r.status}`);
    });

    await test("POST /admin/providers/:id/unsuspend → status back to active", async () => {
      const r = await request(server, {
        path: `/admin/providers/${PROVIDER_ID}/unsuspend`, method: "POST", headers: withToken(),
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.status === "active", `status=${r.body.status}`);
    });

    // ── Promote ──────────────────────────────────────────────────────────
    await test("POST /admin/providers/:id/promote (alpha→beta) → tier changes", async () => {
      const r = await request(server, {
        path: `/admin/providers/${PROVIDER_ID}/promote`, method: "POST", headers: withToken(),
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.tier === "beta", `tier=${r.body.tier}`);
    });

    await test("POST /admin/providers/:id/promote (beta→production) → tier changes", async () => {
      const r = await request(server, {
        path: `/admin/providers/${PROVIDER_ID}/promote`, method: "POST", headers: withToken(),
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.tier === "production", `tier=${r.body.tier}`);
    });

    await test("POST /admin/providers/:id/promote on production → 400 (already at top)", async () => {
      // Register a fresh provider already at production tier to make the case explicit.
      const reg = await request(server, {
        path: "/admin/providers", method: "POST", headers: withToken(),
      }, { id: PROVIDER_ID_PROD, pubkey: kp3.publicKey, tier: "production" });
      assert(reg.status === 200, `setup failed: status ${reg.status}`);

      const r = await request(server, {
        path: `/admin/providers/${PROVIDER_ID_PROD}/promote`, method: "POST", headers: withToken(),
      });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(r.body.error === "already_at_top_tier", `error=${r.body.error}`);
    });

    await test("POST /admin/providers/:id/promote on the alpha → beta → production provider should now also 400", async () => {
      const r = await request(server, {
        path: `/admin/providers/${PROVIDER_ID}/promote`, method: "POST", headers: withToken(),
      });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    // ── Second provider, list grows ──────────────────────────────────────
    await test("POST /admin/providers (second valid provider) → list shows both", async () => {
      const reg = await request(server, {
        path: "/admin/providers", method: "POST", headers: withToken(),
      }, { id: PROVIDER_ID_2, pubkey: kp2.publicKey, tier: "beta" });
      assert(reg.status === 200, `setup failed: status ${reg.status}`);

      const r = await request(server, {
        path: "/admin/providers", method: "GET", headers: withToken(),
      });
      const ids = r.body.map((p) => p.id);
      assert(ids.includes(PROVIDER_ID), `missing ${PROVIDER_ID}`);
      assert(ids.includes(PROVIDER_ID_2), `missing ${PROVIDER_ID_2}`);
      assert(ids.includes(PROVIDER_ID_PROD), `missing ${PROVIDER_ID_PROD}`);
    });

  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
