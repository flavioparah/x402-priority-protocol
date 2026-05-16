/**
 * broker/index.js — Trust-Score Broker MVP entrypoint.
 *
 * Mounts the 4 RFC endpoints plus /health, sets the spec-version header on
 * every response, and registers a single test provider for dev/integration.
 *
 * Exporting the app (not just listening) lets supertest-style integration
 * tests import the app without binding a port.
 */

const express = require("express");
const store = require("./store");

const app = express();

app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  res.setHeader("X-TrustScore-Spec-Version", "0.2");
  next();
});

// Routes.
app.use(require("./routes/attest"));
app.use(require("./routes/report"));
app.use(require("./routes/reputation"));
app.use(require("./routes/info"));
app.use(require("./routes/audit"));
app.use("/admin", require("./routes/admin"));

app.get("/health", (req, res) => res.json({ status: "ok" }));

// JSON 404 (anything not matched above).
app.use((req, res) => res.status(404).json({ error: "not_found", path: req.path }));

// JSON 500 — keep error body shape consistent with the rest of the API.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const msg = err && err.message ? err.message : "internal_error";
  // Express body-parser surfaces malformed JSON as SyntaxError with status 400.
  const status = err && err.status ? err.status : 500;
  res.status(status).json({ error: status === 400 ? "bad_request" : "internal_error", reason: msg });
});

// TEST-ONLY: in production, providers register via the admin CLI.
// Hard-coded Ed25519 pubkey (32 bytes base58) — deterministic value so the
// matching secretKey in lib/signature.js test helpers stays stable across runs.
// Source: keypair `test-op-A`, see broker/test/fixtures/ (added in WS-C parte 2).
store.registerProvider(
  "test-op-A",
  "11111111111111111111111111111112",
  "alpha"
);

const PORT = process.env.BROKER_PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`broker listening on :${PORT}`);
  });
}

module.exports = app;
