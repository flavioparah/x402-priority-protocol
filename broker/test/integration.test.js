/**
 * broker/test/integration.test.js
 *
 * End-to-end smoke test for the broker:
 *   1. Starts the broker on a random port (in-process)
 *   2. Generates a fresh Ed25519 keypair
 *   3. Registers that pubkey as a test provider
 *   4. Signs an attestation with the secret key
 *   5. POSTs it to /attest
 *   6. GETs /reputation/:pubkey — confirms score updated
 *   7. POSTs a tampered attestation → expects 401
 *   8. Verifies idempotency: second POST with same tx_signature is a no-op
 *
 * No supertest, no fetch lib — uses Node's http directly.
 *
 * Run: node broker/test/integration.test.js
 */

const http = require("http");
const app = require("../index");
const store = require("../store");
const { generateKeypair, sign } = require("../lib/signature");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function approx(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label}: expected ${expected} (±${tol}), got ${actual}`);
  }
}

// ── Tiny HTTP client ────────────────────────────────────────────────────────

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

// ── Test plan ───────────────────────────────────────────────────────────────

(async () => {
  console.log("\nx402 Trust-Score Broker — integration smoke test\n");

  // Generate test keypair + register the provider
  const kp = generateKeypair();
  const PROVIDER_ID = "integration-test-op";
  store.registerProvider(PROVIDER_ID, kp.publicKey, "production");

  // Start broker on a free port
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  try {
    // ── GET /info ──────────────────────────────────────────────────────────
    await test("GET /info returns spec_version 0.2 + score_components + weight policy", async () => {
      const r = await request(server, { path: "/info" });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (r.body.spec_version !== "0.2") throw new Error(`spec_version=${r.body.spec_version}`);
      if (!Array.isArray(r.body.score_components)) throw new Error("score_components missing");
      if (r.body.score_components.length !== 5) throw new Error(`expected 5 components, got ${r.body.score_components.length}`);
      if (!r.body.provider_weight_policy) throw new Error("provider_weight_policy missing");
      if (r.body.provider_weight_policy.pubkey_reach_threshold !== 25) throw new Error("bad reach_threshold");
    });

    await test("GET /info response has X-TrustScore-Spec-Version header", async () => {
      const r = await request(server, { path: "/info" });
      if (r.headers["x-trustscore-spec-version"] !== "0.2") {
        throw new Error(`header missing or wrong: ${r.headers["x-trustscore-spec-version"]}`);
      }
    });

    // ── GET /health ────────────────────────────────────────────────────────
    await test("GET /health returns ok", async () => {
      const r = await request(server, { path: "/health" });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (r.body.status !== "ok") throw new Error(`status field: ${r.body.status}`);
    });

    // ── GET /reputation/:pubkey for unknown pubkey ─────────────────────────
    const AGENT_PUBKEY = "G8KyXwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY6pG";
    await test("GET /reputation/:pubkey for unknown pubkey → 200 with zeroed record", async () => {
      const r = await request(server, { path: `/reputation/${AGENT_PUBKEY}` });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (r.body.pubkey !== AGENT_PUBKEY) throw new Error(`pubkey mismatch`);
      if (r.body.global_trust_score !== 0) throw new Error(`expected score 0, got ${r.body.global_trust_score}`);
      if (r.body.paid_count_total !== 0) throw new Error(`expected paid_count_total 0`);
    });

    // ── POST /attest with valid signature ──────────────────────────────────
    let firstAttestResp;
    await test("POST /attest with valid signature → 200 + ReputationRecord updated", async () => {
      const bodyToSign = {
        pubkey: AGENT_PUBKEY,
        amount_micro_lamports: 40200,
        tx_signature: "test-sig-001",
        provider_id: PROVIDER_ID,
        timestamp: Date.now(),
      };
      const signature = sign(bodyToSign, kp.secretKey);
      const fullBody = { ...bodyToSign, provider_signature: signature };

      const r = await request(server, { path: "/attest", method: "POST" }, fullBody);
      if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
      if (r.body.pubkey !== AGENT_PUBKEY) throw new Error(`pubkey mismatch`);
      if (r.body.paid_count_total !== 1) throw new Error(`paid_count_total expected 1, got ${r.body.paid_count_total}`);
      firstAttestResp = r.body;
    });

    // ── POST /attest with tampered signature ───────────────────────────────
    await test("POST /attest with tampered body → 401", async () => {
      const bodyToSign = {
        pubkey: AGENT_PUBKEY,
        amount_micro_lamports: 50000,
        tx_signature: "test-sig-002",
        provider_id: PROVIDER_ID,
        timestamp: Date.now(),
      };
      const signature = sign(bodyToSign, kp.secretKey);
      // Tamper with amount AFTER signing
      const fullBody = { ...bodyToSign, amount_micro_lamports: 999999, provider_signature: signature };

      const r = await request(server, { path: "/attest", method: "POST" }, fullBody);
      if (r.status !== 401) throw new Error(`expected 401, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    // ── POST /attest with unknown provider → 401 ───────────────────────────
    await test("POST /attest with unknown provider_id → 401", async () => {
      const otherKp = generateKeypair();
      const bodyToSign = {
        pubkey: AGENT_PUBKEY,
        amount_micro_lamports: 40000,
        tx_signature: "test-sig-003",
        provider_id: "ghost-provider-does-not-exist",
        timestamp: Date.now(),
      };
      const signature = sign(bodyToSign, otherKp.secretKey);
      const fullBody = { ...bodyToSign, provider_signature: signature };

      const r = await request(server, { path: "/attest", method: "POST" }, fullBody);
      if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
    });

    // ── Idempotency: same tx_signature is a no-op ──────────────────────────
    await test("POST /attest with duplicate tx_signature → idempotent (count not incremented)", async () => {
      const bodyToSign = {
        pubkey: AGENT_PUBKEY,
        amount_micro_lamports: 40200,
        tx_signature: "test-sig-001",     // SAME as the first successful one
        provider_id: PROVIDER_ID,
        timestamp: Date.now(),
      };
      const signature = sign(bodyToSign, kp.secretKey);
      const fullBody = { ...bodyToSign, provider_signature: signature };

      const r = await request(server, { path: "/attest", method: "POST" }, fullBody);
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (r.body.paid_count_total !== 1) {
        throw new Error(`expected paid_count_total still 1 (idempotent), got ${r.body.paid_count_total}`);
      }
    });

    // ── GET /reputation after attest ───────────────────────────────────────
    await test("GET /reputation/:pubkey after attest → reflects updated state", async () => {
      const r = await request(server, { path: `/reputation/${AGENT_PUBKEY}` });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (r.body.paid_count_total !== 1) throw new Error(`paid_count_total=${r.body.paid_count_total}`);
      if (r.body.total_paid_micro_lamports !== 40200) throw new Error(`total_paid=${r.body.total_paid_micro_lamports}`);
      if (r.body.active_in_n_providers !== 1) throw new Error(`N=${r.body.active_in_n_providers}`);
      // global_trust_score should be > 0 now (paid_count=1, H1 active, recent)
      if (!(r.body.global_trust_score > 0)) throw new Error(`score should be > 0, got ${r.body.global_trust_score}`);
    });

    // ── POST /report with valid signature ──────────────────────────────────
    await test("POST /report with valid signature → 200", async () => {
      const bodyToSign = {
        pubkey: AGENT_PUBKEY,
        provider_id: PROVIDER_ID,
        category: "spam_burst",
        evidence: "test evidence",
        timestamp: Date.now(),
      };
      const signature = sign(bodyToSign, kp.secretKey);
      const fullBody = { ...bodyToSign, provider_signature: signature };

      const r = await request(server, { path: "/report", method: "POST" }, fullBody);
      if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
      if (!r.body.accepted) throw new Error(`expected accepted: true`);
    });

    // ── POST /report with invalid category → 400 ───────────────────────────
    await test("POST /report with unknown category → 400", async () => {
      const bodyToSign = {
        pubkey: AGENT_PUBKEY,
        provider_id: PROVIDER_ID,
        category: "this-category-is-not-allowed",
        evidence: "",
        timestamp: Date.now(),
      };
      const signature = sign(bodyToSign, kp.secretKey);
      const fullBody = { ...bodyToSign, provider_signature: signature };

      const r = await request(server, { path: "/report", method: "POST" }, fullBody);
      if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
    });

  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
