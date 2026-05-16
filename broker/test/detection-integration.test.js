/**
 * broker/test/detection-integration.test.js
 *
 * End-to-end test that the detection signals wired into /reputation actually
 * fire when the upstream conditions are met. Complements integration.test.js
 * (which covers attest/report/idempotency happy paths) by hammering the
 * detection module specifically.
 *
 * Scenarios:
 *   1. Unknown pubkey                → empty flags, churn=ephemeral
 *   2. 60 attestations same amount   → wash_payment_suspect fires
 *   3. 2 providers, same category    → cross_provider_dispute fires
 *   4. 3 providers, fresh pubkey     → sybil_risk=high via velocity
 *   5. GET /info                     → detection_signals[] exposed
 *
 * Run: node broker/test/detection-integration.test.js
 */

const http = require("http");
const app = require("../index");
const store = require("../store");
const { generateKeypair, sign } = require("../lib/signature");
const { signalDefinitions } = require("../lib/detection");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Tiny HTTP client (lifted verbatim from integration.test.js) ─────────────

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

// Helper: register a provider with a real Ed25519 keypair we control, so we
// can sign payloads it submits. Returns { id, kp }.
function makeProvider(id) {
  const kp = generateKeypair();
  store.registerProvider(id, kp.publicKey, "production");
  return { id, kp };
}

// Helper: POST /attest with a signed body, return the response.
async function postAttest(server, provider, { pubkey, amount, tx_signature, timestamp }) {
  const bodyToSign = {
    pubkey,
    amount_micro_lamports: amount,
    tx_signature,
    provider_id: provider.id,
    timestamp: timestamp || Date.now(),
  };
  const signature = sign(bodyToSign, provider.kp.secretKey);
  return request(server, { path: "/attest", method: "POST" }, {
    ...bodyToSign,
    provider_signature: signature,
  });
}

// Helper: POST /report with a signed body, return the response.
async function postReport(server, provider, { pubkey, category, evidence }) {
  const bodyToSign = {
    pubkey,
    provider_id: provider.id,
    category,
    evidence: evidence || "",
    timestamp: Date.now(),
  };
  const signature = sign(bodyToSign, provider.kp.secretKey);
  return request(server, { path: "/report", method: "POST" }, {
    ...bodyToSign,
    provider_signature: signature,
  });
}

// ── Test plan ───────────────────────────────────────────────────────────────

(async () => {
  console.log("\nx402 Trust-Score Broker — detection integration test\n");

  // Fresh state. Note: index.js registers "test-op-A" at module load — that's
  // already happened by the time we require the app above. _resetAll wipes it
  // along with everything else, and these tests don't depend on it.
  store._resetAll();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  try {
    // ── (1) Unknown pubkey → empty flags ──────────────────────────────────
    const UNKNOWN_PUBKEY = "G8KyXwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY6pG";
    await test("unknown pubkey returns empty flags + low risk + ephemeral churn", async () => {
      const r = await request(server, { path: `/reputation/${UNKNOWN_PUBKEY}` });
      assert(r.status === 200, `status ${r.status}`);
      assert(Array.isArray(r.body.fraud_flags), `fraud_flags not array`);
      assert(r.body.fraud_flags.length === 0, `expected [], got ${JSON.stringify(r.body.fraud_flags)}`);
      assert(r.body.sybil_risk === "low", `sybil_risk=${r.body.sybil_risk}`);
      assert(r.body.churn_pattern === "ephemeral", `churn_pattern=${r.body.churn_pattern} (paidCount<3 rule)`);
    });

    // ── (2) wash_payment_suspect: 60 same-amount attestations ─────────────
    const WASH_PUBKEY = "WASH" + "1".repeat(40);  // 44 chars, in valid pubkey-length range
    await test("60 same-amount attestations from one provider → wash_payment_suspect", async () => {
      const opWash = makeProvider("op-wash-A");
      for (let i = 0; i < 60; i++) {
        const r = await postAttest(server, opWash, {
          pubkey: WASH_PUBKEY,
          amount: 40200,             // identical amount every time
          tx_signature: `wash-tx-${i}`,
        });
        assert(r.status === 200, `attest ${i} failed: ${r.status} ${JSON.stringify(r.body)}`);
      }
      const r = await request(server, { path: `/reputation/${WASH_PUBKEY}` });
      assert(r.status === 200, `status ${r.status}`);
      assert(r.body.paid_count_total === 60, `paid_count_total=${r.body.paid_count_total}`);
      assert(
        r.body.fraud_flags.includes("wash_payment_suspect"),
        `expected wash_payment_suspect in fraud_flags, got ${JSON.stringify(r.body.fraud_flags)}`
      );
      // Note: with paidCount=60 in <6h, sybil_risk also goes "high" via the
      // single-op young-account heuristic — not asserted here (covered by 4).
    });

    // ── (3) cross_provider_dispute: 2 providers same category ─────────────
    const DISPUTE_PUBKEY = "DISP" + "2".repeat(40);
    await test("2 providers reporting same category → cross_provider_dispute fires", async () => {
      const opDispA = makeProvider("op-disp-A");
      const opDispB = makeProvider("op-disp-B");
      // One attestation each so the pubkey is "known" — not strictly required
      // for dispute detection (reports are independent state) but matches the
      // realistic flow where reports follow attestations.
      const aResp = await postAttest(server, opDispA, {
        pubkey: DISPUTE_PUBKEY, amount: 5000, tx_signature: "disp-att-A",
      });
      assert(aResp.status === 200, `attest A: ${aResp.status}`);
      const bResp = await postAttest(server, opDispB, {
        pubkey: DISPUTE_PUBKEY, amount: 5000, tx_signature: "disp-att-B",
      });
      assert(bResp.status === 200, `attest B: ${bResp.status}`);

      // Two distinct providers report same category.
      const r1 = await postReport(server, opDispA, {
        pubkey: DISPUTE_PUBKEY, category: "spam_burst", evidence: "burst from A",
      });
      assert(r1.status === 200, `report A: ${r1.status} ${JSON.stringify(r1.body)}`);
      const r2 = await postReport(server, opDispB, {
        pubkey: DISPUTE_PUBKEY, category: "spam_burst", evidence: "burst from B",
      });
      assert(r2.status === 200, `report B: ${r2.status} ${JSON.stringify(r2.body)}`);

      const rep = await request(server, { path: `/reputation/${DISPUTE_PUBKEY}` });
      assert(rep.status === 200, `status ${rep.status}`);
      const disputeFlag = rep.body.fraud_flags.find(
        (f) => typeof f === "string" && f.startsWith("cross_provider_dispute:spam_burst")
      );
      assert(
        disputeFlag !== undefined,
        `expected cross_provider_dispute:spam_burst in fraud_flags, got ${JSON.stringify(rep.body.fraud_flags)}`
      );
    });

    // ── (4) cross_provider_velocity: 3 providers, fresh pubkey ────────────
    const VELOCITY_PUBKEY = "VELO" + "3".repeat(40);
    await test("3 distinct providers attesting one fresh pubkey → sybil_risk=high", async () => {
      const opVa = makeProvider("op-velo-A");
      const opVb = makeProvider("op-velo-B");
      const opVc = makeProvider("op-velo-C");
      const a = await postAttest(server, opVa, {
        pubkey: VELOCITY_PUBKEY, amount: 1000, tx_signature: "velo-tx-A",
      });
      assert(a.status === 200, `attest A: ${a.status}`);
      const b = await postAttest(server, opVb, {
        pubkey: VELOCITY_PUBKEY, amount: 1000, tx_signature: "velo-tx-B",
      });
      assert(b.status === 200, `attest B: ${b.status}`);
      const c = await postAttest(server, opVc, {
        pubkey: VELOCITY_PUBKEY, amount: 1000, tx_signature: "velo-tx-C",
      });
      assert(c.status === 200, `attest C: ${c.status}`);

      const rep = await request(server, { path: `/reputation/${VELOCITY_PUBKEY}` });
      assert(rep.status === 200, `status ${rep.status}`);
      assert(rep.body.active_in_n_providers === 3, `active_in_n=${rep.body.active_in_n_providers}`);
      assert(
        rep.body.sybil_risk === "high",
        `expected sybil_risk=high, got ${rep.body.sybil_risk}`
      );
    });

    // ── (5) /info exposes detection_signals[] with 5 entries ──────────────
    await test("GET /info exposes detection_signals matching signalDefinitions()", async () => {
      const r = await request(server, { path: "/info" });
      assert(r.status === 200, `status ${r.status}`);
      assert(Array.isArray(r.body.detection_signals), `detection_signals missing or not array`);
      assert(
        r.body.detection_signals.length === 5,
        `expected 5 signals, got ${r.body.detection_signals.length}`
      );
      const defs = signalDefinitions();
      const expectedIds = new Set(defs.map((d) => d.id));
      const gotIds = new Set(r.body.detection_signals.map((d) => d.id));
      for (const id of expectedIds) {
        assert(gotIds.has(id), `missing signal id ${id} in /info`);
      }
      // Sanity: every entry has the documented shape.
      for (const sig of r.body.detection_signals) {
        assert(typeof sig.id === "string" && sig.id.length > 0, `signal id malformed`);
        assert(["single_operator", "cross_operator"].includes(sig.type), `signal type=${sig.type}`);
        assert(typeof sig.triggers === "string", `signal.triggers not string`);
        assert(typeof sig.effect === "string", `signal.effect not string`);
      }
    });

  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
