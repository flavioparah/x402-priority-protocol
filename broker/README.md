# x402 Trust-Score Broker

> **Status:** MVP scaffold (Phase 1 of cross-op roadmap). In-memory only — restart loses state. Postgres + Redis + audit log + admin CLI come in Phase 2.

> **License:** see parent repo. The broker may be extracted to its own repository when it goes production — see `docs/superpowers/specs/2026-05-12-trust-score-cross-op-roadmap.md` §6 for the criteria.

## What this is

Reference implementation of the broker described in `docs/rfc/x402-trust-score.md`. Receives cryptographically-signed attestations from operators after paid challenges, aggregates per-pubkey reputation, and exposes 4 HTTP endpoints.

## Run locally

```bash
cd broker
npm install
npm start    # listens on :3001
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /attest | Ed25519 provider sig | Operator reports a paid challenge |
| POST | /report | Ed25519 provider sig | Operator flags suspicious pubkey |
| GET | /reputation/:pubkey | public | Cross-op ReputationRecord |
| GET | /info | public | Spec version, score weights, policy params |
| GET | /health | public | Liveness probe |

Every response carries `X-TrustScore-Spec-Version: 0.2`.

## What's stubbed

- Detection signals (`fraud_flags`, `sybil_risk`, `churn_pattern`) return empty / `"low"` / `"stable"`. Full detection lands in WS-C parte 2.
- Provider tier system uses 3 levels (`alpha` = 0.5, `beta` = 1.0, `production` = 1.5); promotion is manual via admin CLI (not built yet).
- Single test provider (`test-op-A`) is registered at startup. Production registers via admin CLI.
- No persistence — state lives in `Map`s and dies on restart.

## How to extract to its own repo (future)

When the broker becomes its own repo:

1. Copy `broker/` into the new repo's root.
2. Replace `require("../lib/trust-score")` with a local copy (the file is small — just copy `lib/trust-score.js` from this repo into broker's `lib/`).
3. Add its own LICENSE (per memory `broker_oss_decision_2026_05_13`, target is Apache-2.0).
4. Set up its own CI.
