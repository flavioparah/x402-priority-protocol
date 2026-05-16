# x402-shield — Threat Model

> **Audience:** Security reviewers, grant evaluators, RPC operators doing security due-diligence before deploying or integrating x402-shield.
> **Scope:** The Shield process (this repository), the inputs it accepts over HTTP, and the persistent state it owns. Cooperative QoS upstreams and the (future) Trust-Score Broker are described as boundary actors, not as in-scope code.
> **Last updated:** 2026-05-15
> **Source of truth:** [`index.js`](../index.js), [`lib/store.js`](../lib/store.js), [`lib/detection.js`](../lib/detection.js), [`lib/enforcement.js`](../lib/enforcement.js), [`lib/abuse-reasons.js`](../lib/abuse-reasons.js), and the RFCs under [`docs/rfc/`](./rfc/).

This document inventories what the Shield trusts, what it defends against, and where the residual risks land. It is intentionally honest about gaps — overselling the model in a security doc is itself a vulnerability.

---

## 1. Trust assumptions

The Shield trusts the following, and the protocol's security properties degrade or fail if any of them is violated:

| Trusted component | What we trust it for | Failure mode if violated |
|---|---|---|
| **Solana chain finality** | `verifyDepositTx` ([`index.js`](../index.js)) treats a `confirmed`-commitment SystemProgram.transfer as final escrow credit | A chain reorg deeper than the configured commitment level could uncredit a deposit |
| **The operator's own upstream RPC node** | Used to fetch deposit transactions for verification; results are believed | A compromised upstream returns spoofed transfers → forged deposits |
| **Ed25519 cryptography** (`tweetnacl`, `bs58`) | `nacl.sign.detached.verify` for signed-retry authentication | Cryptographic break invalidates the entire `Authorization: x402` model |
| **Redis durability claims** | The four critical state pieces (escrow, nonces, used signatures, reputation) are durable across restarts when Redis is configured | Redis data loss → escrow loss, nonce-replay window opens, reputation reset |
| **The operator's own keypair** | `PAYMENT_DESTINATION` is a public address; the operator's signing key is *not* held by the Shield | Operator key compromise is a wallet-level problem, not a Shield problem — see §3.4 |
| **Process-local memory** | QoS queue, request timestamps, the `qosWaitSamples` rolling window are not shared across instances | Multi-instance deployments without a shared queue can dispatch out-of-priority; bounded scope |

**The broker is trusted to be neutral.** The cross-operator Trust-Score Broker (described in [`x402-trust-score` §2](./rfc/x402-trust-score.md#2-architecture)) is a single point of trust for cross-operator reputation. Today, broker neutrality is governance-only — there is no cryptographic enforcement. The roadmap to mitigate this is signed audit log + change-window governance (Phase 4 of the cross-op roadmap), neither of which is implemented yet.

---

## 2. Attack surfaces

Each attack below names the threat, the defense in code, and the residual risk a reviewer should weigh.

### 2.1 Replay attack on signed challenges

**Attack:** An attacker captures a valid `Authorization: x402 <sig>.<pk>.<msg>` header (e.g., from a logged proxy or a man-in-the-middle on a misconfigured client) and resubmits it to drain the original payer's escrow on every retry.

**Mitigation:**

- **Nonce** — every 402 challenge issues a `crypto.randomBytes(16)` (128 bits) nonce. The nonce is stored in Redis as a STRING with `PX <ttl>` set to the 30 s TTL (`NONCE_TTL_MS` in [`index.js`](../index.js)).
- **Atomic consume + debit** — the verification is a single Redis Lua script `consumeNonceAndDebit` ([`lib/store.js`](../lib/store.js) line 414). Two concurrent retries with the same nonce: exactly one wins; the other gets `nonce_already_used`. The TTL is preserved across the `SET` to prevent TTL-reset abuse.
- **Used-signature set** — `/escrow/deposit` writes consumed tx signatures to `x402:deposit-sigs` (SET); a second submission of the same tx signature returns `signature already used for a deposit`.

**Residual risk:** Within the 30 s nonce TTL, a captured token is single-use anyway. If both the legitimate retry and the attacker's replay reach the Shield simultaneously, the Lua script guarantees only one debit, but the legitimate caller may lose its single chance and need to retry. The 30 s TTL is a tunable trade-off: shorter narrows the replay window but increases the chance of legitimate-client clock-skew failures.

### 2.2 Sybil ring / score farming

**Attack:** An attacker spins up many Ed25519 pubkeys, has each one pay just enough to gain a few Trust-Score points, then aggregates the discounts (or sells the keys).

**Mitigation:**

- **Single-operator signal — `coordinated_burst`** ([`lib/detection.js`](../lib/detection.js)) flags when ≥5 attestations across ≥2 distinct operators appear within 24 h for a single pubkey. In single-operator mode this signal is **inert** until the broker observes attestations from a 2nd operator (`distinctOperators(attestations).size >= 2`).
- **Cross-operator signal — `cross_provider_velocity`** flags when a pubkey is attested by ≥3 distinct operators in <24 h and the account is <72 h old (`SEVENTY_TWO_HOURS_MS`). Strong sybil-farm indicator. Activates when the broker ships and a 2nd operator joins.
- **Score saturation** — `trust_score = min(100, paidCount * 5)`. A sybil with 1 payment per pubkey gains only 5 points per identity, and the discount caps at 50 %.
- **Whitelist window** — new pubkeys (<30 days since `firstPaidAt`, configurable via `NEW_PUBKEY_WHITELIST_DAYS`) are never auto-promoted to tier 4 (permanent ban) — only operator-issued bans can. Conservative default reduces false-positives on first contact.

**Residual risk:** In single-operator mode today, sybil rings are detected only after the network grows past one operator. A patient attacker who farms slowly (1 payment per pubkey per day) defeats `coordinated_burst` (count threshold) and `wash_payment_suspect` (50-event minimum). The score cap is the only structural defense in this regime.

### 2.3 Wash payment / score farming via self-pay

**Attack:** An agent transfers SOL from a wallet under its control to the operator's `PAYMENT_DESTINATION` purely to drive its own paid-count up and qualify for the Trust-Score discount.

**Mitigation:**

- **`wash_payment_suspect`** ([`lib/detection.js`](../lib/detection.js)) — flagged when, across ≥50 attestations in the last 24 h, the same exact `amount` value appears on >50 % of them. Real agent traffic varies because the price varies with load; scripted self-pay tends to be constant.
- **H1 hygiene subscore (RFC v0.2)** — Laplace-smoothed report-rate is one of the planned components of the cross-op composite score (see [`x402-trust-score`](./rfc/x402-trust-score.md) §5.1.3 in v0.2). Until `/report` ships, H1 is gated as `inactive_until_report_endpoint`.
- **Pricing curve** — wash payments still cost real lamports. With `MAX_PRICE = 1 000 000 µL` (1000 lamports) at saturation, farming meaningful score is economically expensive.

**Residual risk:** A patient attacker can defeat the constant-amount detector by paying at different load levels (different prices). Cross-op visibility is the structural fix; in single-op mode the operator has limited recourse beyond the score saturation cap and manual `/admin/ban`.

### 2.4 Operator key compromise

**Attack:** An attacker exfiltrates the operator's wallet secret key (e.g., from a backup, an exposed admin host, or social engineering).

**Impact:** The attacker can:
- Sweep accumulated SOL from `PAYMENT_DESTINATION`.
- Forge `provider_signature` on `POST /attest` calls to the broker, polluting cross-operator reputation.
- Sign authentic-looking operational changes.

**Mitigation:**

- **Key is not held by the Shield.** `PAYMENT_DESTINATION` is a public address. The recommended operator setup keeps the signing key offline (hardware wallet) and uses periodic sweeps. See [`x402-priority` §9.3](./rfc/x402-priority.md#93-operator-key-compromise).
- **Admin key rotation runbook** — `/admin/*` HMAC keys (`ADMIN_KEYS_JSON`) are operationally separate from the Solana wallet. Rotation procedure documented in [`docs/AGENT-OPERATOR-RUNBOOK.md` §2 "Key Rotation — 90-day cadence with 7-day overlap"](./AGENT-OPERATOR-RUNBOOK.md). Multiple keys may coexist during the 7-day overlap window.
- **No central auth** — there is no provider-cluster master key the operator can leak. Each operator manages its own keys.

**Residual risk:** The Solana wallet sweep operation is a single-key catastrophic risk and is outside the Shield's threat model. Operators are responsible for their own hot/cold wallet split. The broker (future) does not enforce key freshness; a stolen attestation key can pollute reputation until manually revoked.

### 2.5 Broker compromise

**Attack:** The neutral Trust-Score Broker (future, separate service) is compromised. The attacker rewrites scores, censors attestations, or favors one operator over another.

**Mitigation (planned):**

- **Signed audit log** — every `/attest` and `/report` event will be logged with the provider's signature so the input stream is independently auditable. Immutability mechanism is **TBD** (Phase 4 of the cross-op roadmap).
- **Governance change-window** — broker policy changes go through an announced window; downstream operators can refuse to consume scores after a compromise alert. **Not yet implemented.**
- **Federation** — multi-broker gossip ([`x402-trust-score` §9](./rfc/x402-trust-score.md#9-federation-optional-extension)) lets operators consume the consensus of independent brokers. **Deferred to RFC v1.1.**

**Residual risk:** Today, broker compromise is detected only by social signal. The Shield does not cryptographically verify the broker's responses — it consumes scores at face value. This is the largest known structural weakness in the cross-op model.

### 2.6 Denial of service at the edge

**Attack:** A large IP-distributed flood targets `/rpc`, `/escrow/deposit`, or the `/admin/*` surface to exhaust CPU, Redis, or upstream RPC budget before any per-request economic cost applies.

**Mitigation:**

- **Three-dimension sliding-window rate limit** ([`lib/ratelimit.js`](../lib/ratelimit.js)):
  - IP (default 100 req/min)
  - Pubkey (default 200 req/min, post-auth)
  - Global (default 5 000 req/min)
- **Cheap-reject path** — preflight checks (format-only validation in [`lib/preflight.js`](../lib/preflight.js)) reject malformed `Authorization` headers and unknown nonces **before** the expensive `bs58.decode` and `nacl.sign.detached.verify` calls. Confirmed by [`test/cheap-reject.test.js`](../test/cheap-reject.test.js).
- **Pre-flight ban check** — every request first consults the ban store (`enforcement.checkBan`); banned keys are short-circuited before any signature work.
- **Body limit + circuit breaker** — `/rpc` rejects bodies >32 KiB (`BODY_LIMIT_RPC_BYTES`) before parsing. Solana deposit verification is wrapped in an opossum circuit breaker ([`lib/solana-circuit.js`](../lib/solana-circuit.js)) that opens on 50 % failure rate for 30 s, preventing cascading upstream stalls.
- **Helmet** baseline (HSTS, CSP, frameguard, noSniff, referrer-policy) is applied to all responses.

**Residual risk:** The IP rate-limit is per-shield-instance unless Redis is the store. A botnet large enough to send <100 req/min from each of 10 000 IPs still saturates a single Shield. Defense at that scale requires upstream WAF / Anycast / CDN protections, which are out of scope.

### 2.7 Legitimate-looking spam burst

**Attack:** A pattern-matching agent pays correctly for every request but at a volume that effectively monopolizes upstream RPC capacity.

**Mitigation:**

- **Pricing curve** — the price scales linearly from `BASE_PRICE` (20 lamports) to `MAX_PRICE` (1000 lamports) over the gated load range. Sustained high traffic costs the attacker proportionally more.
- **QoS priority queue** ([`index.js`](../index.js) `qosMiddleware`) — under contention, requests are ordered by `verifiedAmount + verifiedTrustScore * 100 + ageMs/50`. Aging boost prevents legitimate low-priority callers from being starved by the spammer.
- **`dormant_revival` detection** — accounts silent for >90 days that suddenly burst >50 events in 24 h are flagged (see [`lib/detection.js`](../lib/detection.js)). Often precedes coordinated abuse or stolen-key exploitation.
- **Enforcement ladder** ([`lib/enforcement.js`](../lib/enforcement.js)): 5 tiers (warning → throttle → soft-ban → hard-ban → permanent) with auto-promotion thresholds (3 throttles in 5 min → soft, 3 softs in 24 h → hard, 3 hards in 7 d → permanent). High-trust pubkeys require fraud-signal corroboration before escalation (`requireFraudCorroboration` in [`lib/_enforcement-trust-hooks.js`](../lib/_enforcement-trust-hooks.js)).
- **`paid_count` threshold gating** — `getActiveFraudFlags` only escalates after enough attestations exist to make a signal statistically meaningful (e.g., `wash_payment_suspect` requires ≥50 events in 24 h).
- **`/admin/ban`** — operator can manually intervene at any time (`type: pubkey`, `tier: 3` or `4`).

**Residual risk:** Pricing alone cannot stop a well-funded actor from monopolizing capacity. The auto-escalation ladder requires multiple throttles to fire before it acts, by which time the upstream may already be saturated. Manual operator intervention is the backstop.

---

## 3. Cryptographic primitives

| Primitive | Library | Purpose |
|---|---|---|
| **Ed25519** | `tweetnacl` (`nacl.sign.detached.verify`) | Signed-retry authentication on `/rpc` |
| **Base58** (Bitcoin alphabet) | `bs58` | Encoding for signatures, pubkeys, payloads in the `Authorization` header (matches Solana wallet convention — not base64) |
| **HMAC-SHA256** | Node `crypto` | `/admin/*` authentication; canonical string defined in [`lib/admin.js`](../lib/admin.js) `buildCanonicalString` |
| **SHA-256** | Node `crypto` | Body hash component of admin canonical string |
| **`crypto.randomBytes(16)`** | Node `crypto` | Nonce generation (128 bits of entropy, hex-encoded) |
| **RFC 8785 JSON Canonicalization** | (recommended) | Broker `provider_signature` over `/attest` and `/report` bodies (broker side; not enforced here) |

Constant-time comparison (`crypto.timingSafeEqual`) is used for HMAC verification. The Lua-script atomic check on Redis avoids any TOCTOU race in the nonce / escrow path.

---

## 4. Storage durability

The four critical state primitives — **escrow balances**, **nonces**, **reputation**, **used deposit signatures** — live behind a uniform store abstraction ([`lib/store.js`](../lib/store.js)):

| Backend | Activated by | Durability |
|---|---|---|
| **Redis** | `REDIS_URL` set | Persistent (subject to your Redis snapshotting / AOF policy). HASH for escrow + reputation. STRING with `PX` TTL for nonces. SET for used signatures. ZSET for the reputation leaderboard. Survives restart. |
| **In-memory** | Default | Lost on restart. Sweepers prune expired nonces and bans every 30 s (`NONCE_TTL_MS` interval). |

**Boot guard.** `BootGuards.checkTrustedDepositsGuard` ([`lib/boot-guards.js`](../lib/boot-guards.js)) hard-exits the process if `ESCROW_TRUST_DEPOSITS=1` is set on a mainnet deployment. `REDIS_REQUIRED=true` (auto-on for mainnet by default) blocks boot until Redis is reachable.

**Fail-soft.** If Redis is set but unhealthy and `REDIS_REQUIRED=false`, the Shield falls back to in-memory and logs `redis_unhealthy_memory_fallback`. Use this only in non-production; restart loses the escrow ledger.

**Phase-4 retroactive additions.** `slidingWindowQuery` and `incrMassBanCounter` were added later but logically belong with Phase-0 primitives; placement-only deviation noted in `lib/store.js` header.

---

## 5. Out-of-scope

The following are explicitly **not** defended by the Shield and are the responsibility of the deployment, the network, or the client:

- **Solana protocol bugs** — consensus failures, chain reorgs deeper than the configured commitment, validator bugs.
- **RPC node operator-side compromise** — if the operator's own upstream RPC returns wrong data, the Shield will faithfully proxy it (clients SHOULD independently verify on-chain state for high-value operations; see [`x402-priority` §9.4](./rfc/x402-priority.md#94-upstream-rpc-compromise)).
- **Third-party SDKs and wallets** — bugs in `@solana/web3.js`, `tweetnacl`, `bs58`, or the user's wallet software are outside the Shield's control.
- **Browser security on the public dashboards** (`/live`, `/try`, `/explorer`) — these are read-only HTML and use the Tailwind Play CDN (`'unsafe-eval'` in CSP — see [`index.js`](../index.js) helmet config). Treat the dashboards as untrusted display, not as a security boundary.
- **Operator-host security** — OS hardening, container isolation, log retention, secret management for `ADMIN_KEYS_JSON` and `REDIS_URL` are operator-owned.
- **Network-level attacks** — TLS termination, DDoS mitigation at the edge, BGP / DNS attacks are upstream of the Shield.
- **Quantum-cryptographic attacks** — Ed25519 is not post-quantum; no PQ defense is planned in this Shield. Migration is a Solana-wide concern.

---

## 6. Known limitations

These are real gaps in the current implementation. They are listed openly so reviewers and integrators can plan around them.

| # | Limitation | Impact | Path to fix |
|---|---|---|---|
| 1 | **Single-broker centralized today.** No federation; one broker is a single point of trust and failure. | If the broker is compromised or goes offline, cross-operator scoring degrades to single-operator mode. | Federation deferred to [`x402-trust-score` v1.1 §9](./rfc/x402-trust-score.md#9-federation-optional-extension). |
| 2 | **`/report` endpoint not yet built.** The broker-side `POST /report` (see [`x402-trust-score` §4.3](./rfc/x402-trust-score.md#43-post-report)) and the H1 hygiene subscore depend on it. | The hygiene component of the v0.2 composite score is gated as `inactive_until_report_endpoint`. Operators cannot file fraud reports cross-network today. | Tracked in Phase 1 of the cross-op roadmap. |
| 3 | **Audit log immutability TBD.** `/admin/*` writes go to `auditAdminWrite` ([`lib/admin.js`](../lib/admin.js)) and `store.pushAuditAdmin`. The store implementation does not yet provide append-only or external-anchor guarantees. | A compromised admin host could rewrite recent audit entries. | Phase 4 of the cross-op roadmap — likely a signed daily-anchor scheme. |
| 4 | **HMAC keys for admin are operator-managed; no central auth.** Each operator runs its own `ADMIN_KEYS_JSON`. | Cross-operator admin coordination requires out-of-band channels. Loss of all admin keys means rebooting with new `ADMIN_KEYS_JSON`. | Intentional. No central authority by design. |
| 5 | **In-memory QoS queue per instance.** Multi-instance deployments do not share the priority queue. | A request may be dispatched out of global priority order if it lands on a different Shield instance than a higher-priority sibling. | Multi-instance coordination deferred (see [`lib/store.js`](../lib/store.js) header note). |
| 6 | **Cooperative QoS hint is not authenticated.** `X-Priority-Score` is a hint, not a security primitive — operators MUST NOT use it for billing ([`x402-qos-cooperative` §7](./rfc/x402-qos-cooperative.md#7-privacy--security)). | A malicious intermediate could rewrite the score header in transit (TLS provides integrity; out-of-TLS deployments do not). | Always run cooperative QoS over TLS between Shield and operator. |
| 7 | **`negative balance` is best-effort.** Concurrent refund + signed retry could briefly result in a negative escrow row ([`x402-priority` §12](./rfc/x402-priority.md#12-open-issues)). | Cosmetic / accounting only; no money loss because refunds are not yet implemented. | Deferred. |

---

## 7. Reporting

Security disclosures: see [`SECURITY.md`](../SECURITY.md) (**added in PR #3** — the file is being introduced on the `chore/repo-hygiene` branch and may not yet be on `main` at the time you read this). Until that file lands, please file a private security advisory on GitHub at <https://github.com/flavioparah/x402-priority-protocol/security/advisories> rather than opening a public issue.

Please do not disclose vulnerabilities in public until the maintainer has had a chance to ship a fix and announce.

---

## 8. See also

- [`docs/API-REFERENCE.md`](./API-REFERENCE.md) — full HTTP surface enumerated
- [`docs/rfc/x402-priority.md` §9](./rfc/x402-priority.md#9-security-considerations) — protocol-level security considerations
- [`docs/rfc/x402-trust-score.md` §6, §10](./rfc/x402-trust-score.md#6-privacy--security) — privacy + sybil/fraud detection
- [`docs/AGENT-OPERATOR-RUNBOOK.md`](./AGENT-OPERATOR-RUNBOOK.md) — operational procedures
- [`lib/abuse-reasons.js`](../lib/abuse-reasons.js) — closed vocabulary of enforcement reasons
- [`lib/detection.js`](../lib/detection.js) — the 5 fraud signals
- [`lib/enforcement.js`](../lib/enforcement.js) — the 5-tier enforcement ladder
- [`lib/store.js`](../lib/store.js) — the persistence layer + atomic Lua primitives
