# x402-shield — HTTP API Reference

> **Audience:** SDK implementers, RPC operators, security reviewers — anyone who needs the complete HTTP surface of x402-shield in one place.
> **Last updated:** 2026-05-15
> **Source of truth:** [`index.js`](../index.js), [`lib/admin.js`](../lib/admin.js), [`lib/abuse-reasons.js`](../lib/abuse-reasons.js), [`lib/agent-status.js`](../lib/agent-status.js), and the three RFCs under [`docs/rfc/`](./rfc/).
> **Companion specs:** [`x402-priority`](./rfc/x402-priority.md) (wire-level 402 challenge) · [`x402-trust-score`](./rfc/x402-trust-score.md) v0.2 (reputation) · [`x402-qos-cooperative`](./rfc/x402-qos-cooperative.md) (operator-side priority queue)

This document enumerates the HTTP API surface plus the main static dashboard routes. Broker endpoints (`/attest`, `/report`, …) live on a separate service and are noted at the end.

---

## 1. Endpoints overview

| Method | Path | Auth | Description | Rate-limited? |
|---|---|---|---|---|
| `POST` | `/rpc` | Ed25519 when load > threshold | Gated JSON-RPC proxy to upstream Solana RPC | Yes — IP + pubkey + global |
| `POST` | `/escrow/deposit` | None (on-chain proof) | Credit escrow via a Solana tx signature | Yes — 5 req/min per IP |
| `POST` | `/escrow/deposit-trusted` | None | **Demo only.** Credits escrow without on-chain verification. Mounted only when `ESCROW_TRUST_DEPOSITS=1` | Yes — 5 req/min per IP |
| `GET` | `/escrow/balance/:pubkey` | None | Read escrow balance for a pubkey | Yes — 60 req/min per IP |
| `GET` | `/reputation/:pubkey` | None | Trust-Score + sybil / fraud / churn signals for a pubkey | Yes — 30 req/min per IP |
| `GET` | `/info` | None | Static metadata about this Shield deployment | Yes — 120 req/min per IP |
| `GET` | `/agent/status?pubkey=<base58>` | None | Read-only trust + enforcement snapshot for a pubkey (10 s cache) | Yes — 120 req/min per IP |
| `GET` | `/agent/code-of-conduct` | None | Versioned operator/agent Code of Conduct (JSON or HTML) | Yes — 120 req/min per IP |
| `GET` | `/health` | None | Liveness + load + store backend | Yes — 120 req/min per IP |
| `GET` | `/metrics` | None | Prometheus exposition format | Yes — 10 req/min per IP |
| `GET` | `/stats/recent` | None | Recent payments, challenges, load history, totals | Yes — 60 req/min per IP |
| `GET` | `/stats/qos` | None | QoS dispatcher state, percentiles, cooperative-fallback status | Yes — 60 req/min per IP |
| `GET` | `/stats/leaderboard` | None | Top 10 pubkeys by Trust-Score | Yes — 60 req/min per IP |
| `GET` | `/live` | None | Static dashboard (HTML) | No |
| `GET` | `/try` | None | Interactive 402 demo (HTML) | No |
| `GET` | `/explorer` | None | Trust-Score / reputation explorer (HTML) | No |
| `GET` | `/` | None | Landing page (HTML) | No |
| `GET` | `/admin/abuse-log` | HMAC-SHA256 | Recent admin-audit entries | Yes — 60 req/min per key-id |
| `GET` | `/admin/agent/:pubkey` | HMAC-SHA256 | Fuller agent detail than `/agent/status` | Yes — 60 req/min per key-id |
| `POST` | `/admin/ban` | HMAC-SHA256 | Apply a tier 2/3/4 ban | Yes — mass-ban guard (10/min per key, 50/h global) |
| `POST` | `/admin/unban` | HMAC-SHA256 | Clear ban + permanent record | Yes — 60 req/min per key-id |
| `GET` | `/admin/config` | HMAC-SHA256 | Read hot-reloadable config | Yes — 60 req/min per key-id |
| `POST` | `/admin/config` | HMAC-SHA256 | Hot-reload config | Yes — 60 req/min per key-id |

Test-only endpoints (`/__test/ban`, `/x-test/pubkey-bucket`) are mounted only when `ENFORCEMENT_TEST_HOOKS=1` / `X402_ENABLE_TEST_ROUTES=1` and MUST be disabled in production.

The catch-all `/admin/*` is mounted as a `503 admin_not_configured` stub when `ADMIN_KEYS_JSON` is empty.

---

## 2. RPC proxy

### 2.1 `POST /rpc`

Transparent JSON-RPC proxy to the upstream RPC node configured via `REAL_RPC_URL`. Three middleware stages run in order ([`index.js`](../index.js) line 1324):

1. **Body limit** (`BODY_LIMIT_RPC_BYTES`, default 32 KiB) — exceeding fires a `body-too-large` offense (see `lib/enforcement.js`).
2. **Edge rate-limit + enforcement** — IP and global sliding-window buckets ([`lib/ratelimit.js`](../lib/ratelimit.js)).
3. **`x402Shield`** — issues a 402 challenge when load > `RPC_LOAD_THRESHOLD` and no valid signed `Authorization` header is present.
4. **Pubkey rate-limit** (post-auth) + **QoS middleware** (priority queue, see §8).
5. **Proxy** to upstream via `http-proxy-middleware` with `Authorization` stripped and `X-x402-Verified-Pubkey` injected.

#### When 402 fires

A request returns `402 Payment Required` when:

- `load > RPC_LOAD_THRESHOLD` (default `0.75`), **and**
- no `Authorization` header is present, **or** the signed retry fails verification.

#### 402 challenge — response headers

| Header | Value |
|---|---|
| `X-x402-Status` | `challenged` |
| `X-x402-Payment-Destination` | Base58 Solana pubkey to receive payment |
| `X-x402-Amount` | Final price in micro-lamports (post Trust-Score discount) |
| `X-x402-Amount-Base` | Base price in micro-lamports (pre-discount) |
| `X-x402-Trust-Score` | Score `0..100` applied to discount, `0` if no pubkey hint |
| `X-x402-Nonce` | 32-character lowercase hex |
| `X-x402-Nonce-TTL` | Nonce lifetime in seconds (default `30`) |
| `Content-Type` | `application/json` |

#### 402 body

```json
{
  "error": "Payment Required",
  "code": 402,
  "message": "RPC node under load. Pay priority fee to proceed.",
  "payment": {
    "destination": "<base58>",
    "amount_micro_lamports": 40200,
    "amount_base_micro_lamports": 40200,
    "trust_score": 0,
    "nonce": "0bf1988e44c2...",
    "ttl_seconds": 30,
    "instructions": "Sign the payload and retry with: Authorization: x402 <sig>.<pubkey>.<msg>. Send X-x402-Agent-Pubkey to claim Trust-Score discount."
  }
}
```

#### Signed retry

The client retries with:

```
Authorization: x402 <bs58(sig)>.<pubkey>.<bs58(utf8(payload))>
```

Where `payload = JSON.stringify({ nonce, pubkey, amount, destination })` in that exact key order. See [`x402-priority` §5](./rfc/x402-priority.md#5-the-signed-retry) for the canonical signing rules. Reference: `verifyX402Authorization` in [`index.js`](../index.js).

#### Request headers honored

| Header | Purpose |
|---|---|
| `Authorization: x402 <sig>.<pk>.<msg>` | Proof of payment for a previously-issued nonce |
| `X-x402-Agent-Pubkey` | Optional Trust-Score hint; binds the issued nonce to that pubkey |

---

## 3. Trust-Score endpoints (Shield-side)

These endpoints are the **local** view of reputation maintained by this Shield. They are spec-compliant with [`x402-trust-score`](./rfc/x402-trust-score.md) when this Shield is the sole operator. Cross-operator aggregation requires the broker (see §10).

### 3.1 `GET /reputation/:pubkey`

```json
{
  "pubkey": "<base58>",
  "trust_score": 25,
  "paid_count": 5,
  "total_paid_micro_lamports": 201000,
  "first_paid_at": 1714000000000,
  "last_paid_at": 1715000000000,
  "current_discount_percent": 12.5,
  "example_price_at_max_load": 875000,
  "sybil_risk": "low",
  "fraud_flags": [],
  "churn_pattern": "stable",
  "attestations_observed": 5
}
```

- `trust_score` saturates at 100 after 20 successful payments (`min(100, paidCount * 5)`).
- `sybil_risk` / `fraud_flags` / `churn_pattern` are computed via [`lib/detection.js`](../lib/detection.js) over the last ≤100 attestations.
- Public read. Returns HTML when `Accept: text/html`; force JSON with `?raw=1`.

### 3.2 `GET /info`

```json
{
  "operator_pubkey": "<base58>",
  "network": "mainnet" | "devnet" | "unknown",
  "upstream_rpc": "<URL>",
  "base_price_micro_lamports": 20000,
  "max_price_micro_lamports": 1000000,
  "threshold": 0.75,
  "nonce_ttl_seconds": 30,
  "trusted_deposits_enabled": false
}
```

**Note (RFC v0.2 alignment):** PRs #4 and #5 will extend this response with `score_components` (subscore breakdown) and `provider_weight_policy` (broker-published weight formula) once the v0.2 broker surface ships. Until then, this Shield reports only the local pricing parameters.

### 3.3 `GET /agent/status?pubkey=<base58>`

Read-only enforcement snapshot, served from a 10-second cache ([`lib/agent-status.js`](../lib/agent-status.js)):

```json
{
  "pubkey": "<base58>",
  "trust_score": 50,
  "trust_band": "...",
  "trust_multiplier": 2,
  "current_tier": 0,
  "throttles_5m": 0,
  "soft_bans_24h": 0,
  "hard_bans_7d": 0,
  "fraud_flags": [],
  "rate_limit_remaining": { "ip": null, "pubkey": null, "global": null },
  "rate_limit_reset_seconds": 60,
  "permanent": false,
  "whitelist_window": true,
  "since": 1714000000000,
  "until_epoch": null,
  "abuse_history_count": 0
}
```

Response sets `X-x402-Cache: hit|miss`. Returns `400 invalid_pubkey` if the pubkey does not match `^[1-9A-HJ-NP-Za-km-z]{32,44}$`.

### 3.4 `GET /agent/code-of-conduct?version=1.0`

Returns the frozen Code of Conduct document ([`lib/code-of-conduct.js`](../lib/code-of-conduct.js)) — rate budgets, backoff protocol, identity rules, deposit rules, enforcement tiers. JSON by default, HTML when `Accept: text/html`. `404 unknown_version` for unknown `?version`.

---

## 4. Stats / dashboards

### 4.1 `GET /stats/recent`

Recent activity feed for the live dashboard. All counters are persisted in Redis (`LIST` + `HASH`) and survive restart:

```json
{
  "payments": [{ "ts": 1715000000000, "pubkey": "...", "amount": 40200, "score": 25 }, ...],
  "challenges": [{ "ts": ..., "pubkeyHint": null, "basePrice": 40200, "finalPrice": 40200, "load": 0.82 }, ...],
  "load_history": [{ "ts": ..., "load": 0.5, "rps": 12.0 }, ...],
  "totals": {
    "total_challenges_issued": 1234,
    "total_payments": 987,
    "total_paid_micro_lamports": 5000000,
    "unique_paying_pubkeys": 42,
    "total_challenges_issued_session": 1234,
    "total_payments_session": 987
  }
}
```

### 4.2 `GET /stats/qos`

QoS dispatcher state for the `/live` dashboard's QoS card. Counters persisted in Redis; `wait_p*_ms` computed from an in-memory rolling 200-sample window:

```json
{
  "mode": "standalone" | "cooperative" | "off",
  "queue_depth": 0,
  "in_flight": 12,
  "max_inflight": 100,
  "max_queue_depth": 1000,
  "queue_timeout_ms": 10000,
  "utilization": 0.12,
  "bypass_threshold": 0.5,
  "dispatched_total": 0,
  "bypassed_total": 9999,
  "total_settled": 9999,
  "rejected_overflow_total": 0,
  "rejected_timeout_total": 0,
  "wait_p50_ms": 0,
  "wait_p95_ms": 8,
  "wait_p99_ms": 12,
  "wait_samples_count": 200,
  "cooperative_fallback_active": false,
  "cooperative_fallback_until": null,
  "cooperative_health": { ... }
}
```

`cooperative_health` is non-null and populated only when `QOS_MODE=cooperative`. See [`x402-qos-cooperative` §5](./rfc/x402-qos-cooperative.md).

### 4.3 `GET /stats/leaderboard`

```json
{
  "leaderboard": [
    { "pubkey": "<base58>", "trust_score": 100, "paid_count": 23, "total_paid_micro_lamports": 924600, "last_paid_at": 1715000000000 },
    ...
  ],
  "generated_at": 1715000000000
}
```

Top 10 pubkeys by paid-count, sourced from the reputation index ZSET.

The leaderboard widget returns an approximate score computed from `paidCount` and `lastPaidAt` only (no `firstPaidAt` in the leaderboard query payload). For canonical Trust-Score per pubkey, use `GET /reputation/:pubkey`.

### 4.4 Dashboard HTML pages

| Path | Source | Purpose |
|---|---|---|
| `GET /` | `public/index.html` | Landing page |
| `GET /live` | `public/live.html` | Live operations dashboard (load, payments, QoS) |
| `GET /try` | `public/try.html` | Interactive 402 handshake demo |
| `GET /explorer` | `public/explorer.html` | Trust-Score / reputation explorer |

Static assets are served via `express.static(public)` mounted **before** the `/rpc` proxy so they are not intercepted.

---

## 5. Operations

### 5.1 `GET /health`

```json
{
  "status": "ok",
  "load": "0.42",
  "rps": "12.34",
  "max_rps": 50,
  "load_forced": false,
  "threshold": 0.75,
  "nonces_active": 3,
  "escrow_accounts": 17,
  "store_backend": "redis"
}
```

Returns `503 { status: "shutting_down", code: 503 }` once `SIGTERM`/`SIGINT` is received.

### 5.2 `GET /metrics`

Prometheus exposition format. Public (no auth — scrapers do not send credentials). Per-IP rate-limit: 10 req/min.

Exported series (see [`lib/metrics.js`](../lib/metrics.js)):

- `x402_requests_total{route,stage,outcome}` — hot-path request counter
- `x402_ratelimit_blocks_total{dimension,route}`
- `x402_abuse_events_total{reason}`
- `x402_admin_actions_total{action,outcome}`
- `x402_qos_inflight`, `x402_qos_queue_depth`
- `x402_solana_circuit_state`, `x402_store_healthy`
- `x402_solana_rpc_duration_seconds` (histogram)
- Plus `process_*` and `nodejs_*` default metrics from `prom-client`.

---

## 6. Admin (HMAC-authenticated)

All `/admin/*` routes are mounted via [`lib/admin.js`](../lib/admin.js) and require all of:

| Header | Value |
|---|---|
| `X-Admin-Key-Id` | Key identifier matching a key in `ADMIN_KEYS_JSON` |
| `X-Admin-Timestamp` | Unix seconds; must be within ±60 s of server clock |
| `X-Admin-Auth` | HMAC-SHA256 hex over the canonical string |

**Canonical string** (joined with `\n`): `METHOD\nPATH\nSORTED_QUERY\nTIMESTAMP\nKEY_ID\nSHA256_BODY_HEX`. See `buildCanonicalString` in [`lib/admin.js`](../lib/admin.js). Query parameters are sorted ASCII lexicographically by key before signing.

**CORS lockdown:** `/admin/*` never sends `Access-Control-Allow-Origin: *`. Allowed origins are configured via `ADMIN_ORIGIN_ALLOWLIST` (default `https://api.rpcpriority.com,https://ops.rpcpriority.com`). Server-to-server callers omit the `Origin` header entirely.

**Body limit:** 4 KiB hard cap (`/admin/*` bodies larger than this return `413 body_too_large`).

**When unconfigured:** if `ADMIN_KEYS_JSON` is empty/missing, all `/admin/*` routes return `503 admin_not_configured` with header `X-Admin-Status: not_configured`.

**Key rotation:** see [`docs/AGENT-OPERATOR-RUNBOOK.md` §2 "Key Rotation — 90-day cadence with 7-day overlap"](./AGENT-OPERATOR-RUNBOOK.md).

### 6.1 `GET /admin/abuse-log?limit=N&since=ts&type=ip|pubkey`

Returns the audit log entries written by `auditAdminWrite`. `limit` defaults to 100, max 500. `type` must be `ip` or `pubkey` if supplied; invalid values return `400`.

### 6.2 `GET /admin/agent/:pubkey`

Fuller per-agent detail than `/agent/status`:

```json
{
  "pubkey": "<base58>",
  "reputation": { ... },
  "trust_score": 50,
  "attestations": [ ... ],
  "fraud_signals": { "sybil_risk": "low", "fraud_flags": [], "churn_pattern": "stable" },
  "ban_history": [ ... ],
  "current_ban": null,
  "permanent": false
}
```

### 6.3 `POST /admin/ban`

```json
{ "key": "<ip-or-pubkey>", "type": "ip" | "pubkey", "tier": 2 | 3 | 4, "reason": "...", "ttl_s": 3600 }
```

- `tier` must be `2`, `3`, or `4`. Tier 4 sets a permanent ban.
- `reason` must be ≥ 3 characters; otherwise `400 reason_required`.
- `ttl_s` clamped to `[60, 7*86400]` seconds. Default per tier: tier 2 `SOFT_BAN_DURATION_MS` (5 min), tier 3 `HARD_BAN_DURATION_MS` (1 h).
- Runs through `massBanGuard`: 10/min per key-id and 50/h global. Exceeding returns `429 mass_ban_guard_triggered`.

### 6.4 `POST /admin/unban`

```json
{ "key": "...", "type": "ip" | "pubkey", "reason": "..." }
```

Clears both the timed ban and the permanent set for the key. Audit entry written on every call.

### 6.5 `GET /admin/config` · `POST /admin/config`

`GET` returns the current hot-reloadable config (`config: { ... }`). `POST` applies updates atomically:

```json
{ "updates": { "RATE_IP_LIMIT": 200 }, "reason": "spike absorption", "meta": { "actor": "ops" } }
```

Validation per key via `lib/config.js applyUpdate`. First failure short-circuits; nothing is applied. Returns the applied set + the post-update config snapshot.

---

## 7. Cooperative QoS endpoints

Per [`x402-qos-cooperative` §3](./rfc/x402-qos-cooperative.md#3-header-contract), when the Shield runs in `QOS_MODE=cooperative` it forwards two request headers to the upstream operator:

| Header | Direction | Value |
|---|---|---|
| `X-Priority-Score` | request (Shield → operator) | Integer in `[0, 2^31)`. Formula: `verifiedAmountMicroLamports + verifiedTrustScore * 100` |
| `X-QoS-Spec-Version` | request (Shield → operator) | `"1"` |
| `X-QoS-Operator-Tier` | request, optional | Integer `1`/`2`/`3` (Shield never emits today; reserved) |
| `X-QoS-Overload` | response (operator → Shield) | `"1"` triggers a 30 s fallback to standalone queueing |

The Shield **periodically probes** the operator's `OPTIONS /qos-status` endpoint every 30 s (see `QOS_HEALTH_INTERVAL_MS` in [`index.js`](../index.js)). Reference operator implementation: [`examples/operator-qos-reference.js`](../examples/operator-qos-reference.js).

`/qos-status` on the **operator side** returns:

```json
{ "mode": "cooperative", "max_inflight": 4, "in_flight": 0, "queue_depth": 0, "dispatched_total": 0, "overload_responses_total": 0 }
```

with header `X-QoS-Spec-Version: 1`. The Shield itself does **not** mount `/qos-status` — it only consumes it.

---

## 8. Headers reference

### 8.1 Request headers consumed by the Shield

| Header | Purpose |
|---|---|
| `Authorization: x402 <sig>.<pk>.<msg>` | Proof of payment for a nonce |
| `X-x402-Agent-Pubkey` | Trust-Score hint (Shield discounts price, binds nonce to pubkey) |
| `X-Admin-Key-Id` / `X-Admin-Timestamp` / `X-Admin-Auth` | `/admin/*` HMAC auth |

### 8.2 Response headers emitted by the Shield

| Header | Where | Value |
|---|---|---|
| `X-Request-ID` | every response | 8-character hex correlation id (server-generated; client-supplied ignored) |
| `X-x402-Status` | 402 | `challenged` |
| `X-x402-Payment-Destination` | 402 | Operator's payment pubkey |
| `X-x402-Amount` | 402 | Final price in micro-lamports |
| `X-x402-Amount-Base` | 402 | Base price (pre-discount) |
| `X-x402-Trust-Score` | 402 | Score `0..100` |
| `X-x402-Nonce` | 402 | 32-char hex nonce |
| `X-x402-Nonce-TTL` | 402 | Seconds (default `30`) |
| `X-x402-Tier` | enforcement (429/403) | Integer `0..4` |
| `X-x402-Reason` | enforcement | Closed vocabulary — see §9 |
| `X-x402-Trust-Impact` | enforcement | `none` \| `warn` \| `throttle` \| `softban` \| `hardban` \| `permanent` |
| `X-x402-Until` | enforcement | Unix seconds or `permanent` |
| `X-x402-Limit-Remaining` | enforcement | Integer |
| `X-x402-Warning` | tier-0 only | `rate-limit-approaching` |
| `X-x402-Reset` | tier-0 only | Seconds |
| `X-x402-Verified-Pubkey` | proxy → upstream | Set when a paid request is forwarded |
| `X-x402-Cache` | `/agent/status` | `hit` \| `miss` |
| `X-Admin-Status` | `/admin/*` error | `not_configured` / `missing_headers` / `expired` / `unknown_key` / `invalid_signature` / `body_too_large` |
| `X-Priority-Score` | cooperative QoS req | Integer score (Shield → operator) |
| `X-QoS-Spec-Version` | cooperative QoS req | `"1"` |
| `Retry-After` | 429 / 503 / 504 | Seconds |

### 8.3 Headers consumed from the operator

| Header | Direction | Value |
|---|---|---|
| `X-QoS-Overload` | response (operator → Shield) | `"1"` triggers 30 s fallback |

---

## 9. Error codes — `X-x402-Reason` vocabulary

Closed enum, exported from [`lib/abuse-reasons.js`](../lib/abuse-reasons.js). Adding or renaming is a breaking SDK contract change.

| Identifier | Triggered by |
|---|---|
| `ip-rate-limit` | Edge IP sliding-window exceeded |
| `pubkey-rate-limit` | Post-auth pubkey sliding-window exceeded |
| `global-rate-limit` | Global RPS cap exceeded |
| `invalid-signature-burst` | Repeated invalid `Authorization` signatures |
| `nonce-replay` | Same nonce consumed twice |
| `pubkey-hint-mismatch` | Signer pubkey ≠ `hintedPubkey` set during challenge issuance |
| `wash-payment` | Detection signal (`lib/detection.js` `washPaymentSuspect`) |
| `coordinated-burst` | Detection signal — `≥2` distinct operators attesting same pubkey in <24 h |
| `dormant-revival` | Detection signal — 90+ day silence then sudden burst |
| `deposit-signature-invalid` | `/escrow/deposit` could not verify the on-chain tx |
| `deposit-amount-mismatch` | Reserved for partial-credit dispute paths |
| `body-too-large` | `/rpc` body > `BODY_LIMIT_RPC_BYTES` (32 KiB default) |
| `malformed-payload` | JSON parse failure or schema mismatch |

HTTP status mapping (from `enforcementResponse` in [`lib/enforcement.js`](../lib/enforcement.js)):

| Tier | HTTP | Body `error` |
|---|---|---|
| 0 (warning) | 200 (next() proceeds) | n/a — header only |
| 1 (throttle) | 429 | `rate_limited` |
| 2 (soft ban) | 429 | `rate_limited` |
| 3 (hard ban) | 403 | `banned` |
| 4 (permanent) | 403 | `banned` |

Other notable status codes:

| Code | Meaning |
|---|---|
| `400 invalid_signature_format` / `invalid_json` / `invalid_pubkey` / `invalid_type` / `invalid_tier` / `reason_required` / `update_rejected` | Validation failures |
| `400 deposit_signature_known_invalid` | Negative cache hit (`lib/store.js`) |
| `401 missing_admin_headers` / `timestamp_out_of_range` / `unknown_key_id` / `invalid_signature` | Admin HMAC failures |
| `402 Payment Required` | Gating active |
| `403 origin_forbidden` | `/admin/*` Origin not in allowlist |
| `409 deposit_in_progress` | Idempotency lock active on same deposit signature |
| `413 body_too_large` | Body cap exceeded |
| `429 admin_rate_limit` / `mass_ban_guard_triggered` | Admin rate-limits |
| `502 RPC upstream error` | `http-proxy-middleware` `onError` |
| `503 admin_not_configured` / `ban_guard_unavailable` / `solana_rpc_unavailable` / `QoS queue full` / `shutting_down` | Various unavailable states |
| `504 QoS queue timeout` | Per-request wait > `QOS_QUEUE_TIMEOUT_MS` (default 10 s) |

---

## 10. Versioning

- **Trust-Score** — every Trust-Score broker request/response SHOULD carry `X-TrustScore-Spec-Version` (see [`x402-trust-score` §7](./rfc/x402-trust-score.md#7-versioning)). The Shield does not emit this header today; the broker (when extracted) will require it.
- **Cooperative QoS** — every cooperative request MUST carry `X-QoS-Spec-Version: 1` (see [§7](#7-cooperative-qos-endpoints)).
- **Shield HTTP API** — there is **no separate Shield API version header**. The Shield's surface is implicitly versioned by the repo tag (`git describe --tags`). Breaking changes bump the repo's semantic version; the Code of Conduct document carries its own `version` field.
- **x402-priority** — the wire-level 402 protocol is at v1.0; `X-x402-Spec-Version` MAY be sent by clients but is not required by this Shield.

---

## 11. Broker endpoints (separate service)

Broker endpoints are served by the separate `broker/` service, not by the Shield process. A local MVP implementation exists in this repository (in-memory; `cd broker && npm start`); public neutral broker deployment is pending operational setup (VPS, DNS, persistence).

The endpoints exposed by the local MVP today (matches the contract described in [`x402-trust-score` §4](./rfc/x402-trust-score.md#4-http-api)):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/attest` | Operator reports a successful payment; signed with provider key |
| `POST` | `/report` | Operator flags suspicious behavior; categories: `spam_burst`, `duplicate_signature`, `wash_payment`, `payment_dispute`, `refund_abuse`, `other` |
| `GET` | `/reputation/:pubkey` | Aggregated cross-operator `ReputationRecord` |
| `GET` | `/info` | Broker metadata: spec version, provider weight policy, federation peers |
| `GET` | `/audit/:date` | Daily signed audit-log dump (immutability TBD — Phase 4) |
| `GET` | `/health` | Liveness + storage backend |
| `POST` | `/admin/providers` | Register a new provider (operator) |
| `GET` | `/admin/providers` | List registered providers |
| `GET` | `/admin/providers/:id` | Fetch a single provider record |
| `POST` | `/admin/providers/:id/suspend` | Mark provider as suspended (attestations/reports rejected) |
| `POST` | `/admin/providers/:id/unsuspend` | Reverse a suspension |
| `POST` | `/admin/providers/:id/promote` | Promote a provider weight tier |

**Status:** Local MVP usable for development and tests. The Shield's `/reputation/:pubkey` and `/info` provide the single-operator equivalents until a public broker deployment is announced. See [`x402-trust-score` §4](./rfc/x402-trust-score.md#4-http-api) for the full broker contract.

---

## 12. See also

- [`docs/rfc/x402-priority.md`](./rfc/x402-priority.md) — wire-level 402 challenge specification
- [`docs/rfc/x402-trust-score.md`](./rfc/x402-trust-score.md) — reputation layer + score formula
- [`docs/rfc/x402-qos-cooperative.md`](./rfc/x402-qos-cooperative.md) — operator-side priority queue
- [`docs/AGENT-OPERATOR-RUNBOOK.md`](./AGENT-OPERATOR-RUNBOOK.md) — operational procedures including admin key rotation
- [`docs/THREAT-MODEL.md`](./THREAT-MODEL.md) — security model + residual risks
- [`x402-client-sdk.ts`](../x402-client-sdk.ts) — reference TypeScript client
- [`examples/operator-qos-reference.js`](../examples/operator-qos-reference.js) — reference cooperative-QoS operator
