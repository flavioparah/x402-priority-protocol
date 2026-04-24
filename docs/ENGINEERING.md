# Engineering Journal — x402-shield

Living record of what works, what broke, what we decided and why. Written for the team (Flávio, João, Felipe) and for hackathon judges who want depth beyond the README.

Append entries chronologically. Don't delete — mark superseded.

---

## 2026-04-23 — Session 1: cleanup, README, demo, SDK fix, benchmark

### Status snapshot (end of session)

| Component | State | Notes |
|-----------|-------|-------|
| `index.js` (Shield) | ✅ Working end-to-end | Proxy + 402 + Ed25519 verify + in-memory escrow |
| `x402-client-sdk.ts` | ✅ Working end-to-end | Verified against live devnet through Shield |
| `demo.js` | ✅ Working | Single-request 5-step handshake, pretty logs |
| `bench.js` | ✅ Working | Multi-sample latency; KPI validated |
| `README.md` | ✅ Published | English, hackathon-grade |
| Onchain settlement | ❌ Not supported | SDK throws; Shield only handles offchain |
| `X-x402-Trust-Score` | ⏳ Week 2 | Not started |

### Validated end-to-end

- Shield receives POST /rpc under simulated load, responds 402 with challenge headers (destination, amount, nonce, TTL).
- Client builds signed payload `{nonce, pubkey, amount, destination}`, signs with Ed25519 via tweetnacl.
- Authorization header format: `x402 <sig_b58>.<pubkey_b58>.<msg_b58>`.
- Shield verifies signature, looks up nonce (TTL 30s, single-use), checks escrow balance, debits, proxies to upstream (tested against `api.devnet.solana.com`).
- `rpc.getSlot()` via the SDK `X402Provider` (extending `Connection`) transparently does the handshake and returns the slot number from live devnet. Same for `rpc.request('getHealth', [])`.

### Benchmark results (N=100, localhost Shield + devnet upstream)

```
│ label       │  mean   │  p50    │  p95    │  p99    │  max
│ baseline    │ 133.5   │ 131.8   │ 140.1   │ 187.1   │ 187.1     (direct to devnet)
│ x402 total  │ 422.8   │ 419.0   │ 460.7   │ 485.2   │ 485.2     (full handshake)
│ → 402 RTT   │   1.6   │   1.5   │   1.8   │   3.7   │   3.7     (Shield-only)
│ → sign      │   4.8   │   4.5   │   6.7   │   7.2   │   7.2     (CPU only)
│ → retry RTT │ 416.4   │ 412.8   │ 454.8   │ 479.1   │ 479.1     (Shield → devnet)
│ x402 OVHD   │   6.4   │   6.1   │   8.3   │  10.8   │  10.8     (402 RTT + sign)
```

**KPI: x402 protocol overhead p95 < 50 ms → PASS at 8.3 ms.**

The big takeaway: the protocol itself is cheap. What dominates the total is the Shield's proxy to the upstream, not x402. See decision **D-004** below.

---

### Decisions taken this session

#### D-001 — Off-chain Ed25519 settlement as MVP default

Adopted the plan from the pitch deck's "Gateway de Saldo" path (not on-chain transfer per request). Confirmed in code: `settlementMode: 'offchain'` is the default in the SDK. On-chain mode now throws explicitly (see **D-005**).

**Why:** Per-request on-chain transfer adds ~400ms confirmation latency. For the MVP demo and the <50 ms KPI this is incompatible. Off-chain signature + pre-deposited escrow gives zero-wait verification with equivalent economic guarantees for the duration of the escrow balance.

**Consequences:** Agents must pre-fund. The Shield's `/escrow/deposit` endpoint currently accepts deposits without validating an on-chain transfer (trusted-deposit MVP). Production needs tx validation against the destination wallet (see open issues).

#### D-002 — Keep the flat repo layout (not `server/` + `client/`)

The context doc suggested restructuring into `server/` + `client/`. Not done this session — kept flat.

**Why:** The scope agreed on was "clean mnt, write README, make the demo work." Restructuring moves every file and invalidates all path references in the exported doc. Low leverage for the hackathon; can be done later when publishing to npm.

**Consequences:** Judges see `index.js` and `x402-client-sdk.ts` side by side. Not ideal for an npm release later. Trade-off accepted.

#### D-003 — `express.json()` scoped to /escrow/deposit only

Original `index.js` had `app.use(express.json())` mounted globally. The body parser drained the POST body on every route, including `/rpc`. When `http-proxy-middleware` then tried to stream the request to the upstream RPC, the body was gone — upstream hung and returned HTTP 408 Request Time-out.

**Decision:** Mount the JSON parser only on the route that needs it (`/escrow/deposit`). Leave `/rpc` and `/health` to see the raw stream, which lets the proxy forward the body correctly.

**Why:** This was a silent, demo-killing bug. The 402 path "worked" — signature was accepted, escrow debited — and then upstream timed out. Without this fix, the hackathon demo video would fail on camera.

**Consequences:** `/escrow/deposit` explicitly uses `express.json()` middleware. Any new routes that need parsed JSON must do the same.

#### D-004 — Shield `http-proxy-middleware` does not keep-alive to upstream

Discovered during benchmarking. The proxy layer adds ~285 ms per request because it opens a fresh TCP + TLS connection to `api.devnet.solana.com` for every proxied request. This is a property of the default proxy configuration, not of x402.

**Decision (deferred):** Swap the proxy for a custom forwarder using `http.Agent` with `keepAlive: true`, or pass a `createAgent` option to `http-proxy-middleware`. Not addressed this session.

**Why defer:** Does not affect the <50 ms KPI (that measures x402 overhead only). Matters for overall UX / tail latency and will be needed for the public deployment. Scope for session 2 or 3.

**Consequences:** Total handshake time in the bench is ~420 ms, of which only ~8 ms is x402. The rest is proxy overhead that any plain RPC proxy of this type would also have.

#### D-005 — SDK: `_rpcRequest` instance override (not prototype)

Original SDK had `_patchRpcRequest()` that captured `originalFetch` as dead code and only overrode `_rpcBatchRequest`, which most Connection methods do not call. Every `getAccountInfo`, `getSlot`, etc. silently bypassed interception.

Attempted fix #1 — declare `_rpcRequest` on the subclass prototype. Does not work: `@solana/web3.js` assigns `_rpcRequest` as an *instance* property inside its constructor (via `createRpcClient`), which shadows the prototype method.

**Decision:** After `super()` runs, replace `this._rpcRequest` with a bound method that routes the JSON-RPC body through `_fetchWithX402`. Done in the constructor body.

```typescript
(this as any)._rpcRequest = this._x402RpcRequest.bind(this);
```

**Why:** One hook catches every Connection method (`getAccountInfo`, `getBalance`, `getSlot`, `getLatestBlockhash`, `sendTransaction`, etc.) plus batched calls. Alternative explicit per-method wrappers were rejected as higher-maintenance.

**Consequences:** The SDK relies on `_rpcRequest` being the single funnel for Connection RPCs. This is a web3.js internal contract — any major-version bump of `@solana/web3.js` needs a re-verification pass. Tracked as **O-003** below.

#### D-006 — JSON-RPC `id` must be a string in web3.js responses

Caught during SDK smoke test. `@solana/web3.js` validates responses against a superstruct schema (`jsonRpcResult`) that requires `id: string`. Devnet echoes whatever id it receives. Sending a number id → numeric echo → validation fails with a cryptic "Expected the value to satisfy a union of `type | type`".

**Decision:** `String(++this._requestId)` in the SDK when building the request body.

**Consequences:** None — matches what web3.js itself sends. Documented inline to prevent regression.

#### D-007 — On-chain settlement throws explicitly, not silently broken

The original SDK had `_payPriorityOnChain` that constructed a `SystemProgram.transfer`, serialized it, and returned `Authorization: x402-tx <bs58>`. But the Shield (`index.js`) never implements the `x402-tx` branch — only `x402 <sig>.<pubkey>.<msg>`. So on-chain mode always silently failed with "Missing x402 header".

**Decision:** `_payPriorityOnChain` now throws with a clear message directing users to `settlementMode: 'offchain'` and a TODO for Week-2 server-side support.

**Why:** Fail loudly. A silent failure with a misleading error is worse than a clear "not supported yet".

**Consequences:** On-chain path is explicit TODO. Server-side implementation needs: parse `x402-tx <serialized>`, verify signature, simulate the transfer, accept only if the tx is properly formed and matches the challenge. Probably also needs a watcher that confirms the tx lands on-chain before fully accepting — otherwise agents can replay serialized-but-unlanded txs. Scope for Week 2.

---

### Open issues / next work

- **O-001 — Unverified escrow deposits.** `/escrow/deposit` trusts the caller's stated amount. An attacker can top up 999M µL of free credit. Fix: take a Solana tx signature, verify on-chain that it transferred the claimed amount to `PAYMENT_DESTINATION`, only then credit escrow. Week-2 server work.
- **O-002 — Synthetic load metric.** `getRpcLoad()` returns `Math.random() * 0.4 + 0.6`. Good for demos, bad for production. Wire to real metrics (req/s sliding window or Prometheus scrape from the upstream node). Week-2.
- **O-003 — web3.js version pinning.** SDK relies on the `_rpcRequest` internal contract. Pin `@solana/web3.js` to `^1.91.x` and add a CI smoke test that actually runs `rpc.getSlot()` so any breakage surfaces immediately.
- **O-004 — Proxy keep-alive.** See **D-004**. ~285 ms per-request savings available.
- **O-005 — No LICENSE.** Repo has no license file. Permissive OSS (MIT or Apache-2.0) aligns with the Week-3 "open protocol" positioning.
- **O-006 — Trust-Score.** `X-x402-Trust-Score` header reducing per-request price for recurring well-behaved agents. Week-2 feature.

---

### Mini-runbook (how to reproduce results)

```bash
# Terminal 1 — Shield
git clone https://github.com/flavioparah/x402-priority-protocol.git
cd x402-priority-protocol
npm install
RPC_LOAD_THRESHOLD=0 \
PAYMENT_DESTINATION=DemoWallet11111111111111111111111111111111 \
REAL_RPC_URL=https://api.devnet.solana.com \
npm start

# Terminal 2 — single handshake demo (pretty output)
npm run demo

# Terminal 2 — multi-sample benchmark
BENCH_N=100 npm run bench

# Build the TS client SDK
npm run build        # emits dist/
npm run typecheck    # no emit
```

---

## 2026-04-23 — Session 1 (addendum): perf fix, deploy manifests, pitch script

### Status delta

| Component | State | Notes |
|-----------|-------|-------|
| Shield proxy keep-alive | ✅ Fixed | ~270 ms p50 saved on retry RTT (O-004 closed) |
| Docker image | ✅ Added | `Dockerfile` (production, prod-deps only) |
| docker-compose | ✅ Added | Traefik labels + `portainer_default` network, matches amiginvisivel pattern |
| `docs/DEPLOY.md` | ✅ Added | First-deploy + subsequent-deploy runbook for `ssh kvm4:/root/x402` |
| `docs/PITCH-VIDEO.md` | ✅ Added | 3-min shot list, voiceover beats, production notes |

### Benchmark delta (same N=100, same conditions)

```
                 before          after
 baseline p50    131.8 ms        138.9 ms    (network noise)
 x402 total p50  419.0 ms        151.5 ms    (−267.5 ms, −64%)
 retry RTT p50   412.8 ms        145.5 ms    (−267.3 ms, this is the fix)
 x402 OVHD p95     8.3 ms          8.7 ms    (unchanged, as expected)
```

Effective client-perceived latency collapsed from ~420 ms to ~150 ms. The x402 protocol overhead itself (what the KPI targets) was already under budget and remains unchanged — this fix is about the proxy's upstream connection hygiene, orthogonal to x402.

### Decisions

#### D-008 — Keep-alive HTTP(S) agent to the upstream RPC

Fixes **O-004**. Added `https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 })` (or `http.Agent` if the upstream is plain HTTP) and passed it as the `agent` option to `createProxyMiddleware`.

**Why:** See the before/after above. The default http-proxy-middleware behaviour (no explicit agent) opens a fresh TCP + TLS connection per request, which against a public Solana RPC across the internet is the dominant cost.

**Consequences:** Up to 64 concurrent upstream sockets kept warm. Under sustained traffic this is strictly better; under very bursty traffic the first few requests after a 30-second idle still pay the reconnect tax (agent closes idle sockets after `keepAliveMsecs`). If we hit concurrency ceilings, raise `maxSockets` — public Solana RPCs tolerate high connection counts per client IP in our experience, but revisit if we see 429s.

#### D-009 — Production deploy via Docker + Traefik on `portainer_default`

Matches the existing VPS pattern (Vokano, amiginvisivel). Service name `x402-shield`, domain `x402.assistent.top`, TLS via Let's Encrypt `leresolver`, network `portainer_default` external.

**Why:** The VPS already runs Traefik + Portainer in this configuration. Bolting on a new service is one compose file. A non-Docker deployment (systemd unit + nginx) would cost us an hour for zero upside.

**Consequences:** The `docker-compose.yml` builds from the local `Dockerfile` which copies only the production-needed files (`index.js`, `package*.json`). The `demo.js`, `bench.js`, SDK TypeScript, and docs ship with the source repo but are not in the container image. `.env` provides secrets — critically, `PAYMENT_DESTINATION` — and is gitignored.

#### D-010 — Dockerfile copies only runtime files, `npm ci --omit=dev`

The container does not need `typescript`, `@solana/web3.js` (peer/dev), `@types/node`, or `nodemon`. Those are for local SDK builds and watch mode, not for the running Shield.

**Consequences:** Smaller image. If we ever move the SDK build into CI and publish to npm, this split becomes a hard boundary. No action needed now.

### Open issues delta

- **O-004** — ✅ **closed** in this addendum (D-008).
- **O-007** (new) — `.env` on the VPS is hand-edited. Good enough for the hackathon; long-term, use Portainer secrets or Docker secrets so `PAYMENT_DESTINATION` doesn't live in a writable file as plaintext.
- **O-008** (new) — Container runs as `root` (node:22-alpine default). Fine for the demo. Harden by running as non-root user before any external traffic.

---

## 2026-04-23 — Session 1 (continued): LICENSE, SDK smoke test

### Changes

- **LICENSE** — Apache-2.0, copyright to the three founders. Aligns with the upstream Solana ecosystem (the core is Apache-2.0) and carries an explicit patent grant. README "License: TBD" updated. Closes **O-005**.
- **test/smoke.js + `npm test`** — regression guard for **O-003**. The SDK depends on an internal contract of `@solana/web3.js` (D-005: `_rpcRequest` as an instance property assigned in Connection's constructor). A web3.js upgrade that moves this hook will silently bypass our 402 interception. The smoke test calls `rpc.getSlot()` (Connection path) AND `rpc.request('getHealth', [])` (escape hatch), then asserts the escrow was debited — any breakage of the override fails loudly.

Smoke test run (localhost Shield, devnet upstream):
```
✓ escrow credited — balance 200000 µL
✓ rpc.getSlot() returned slot 457653963 (Connection path intercepted)
✓ rpc.request('getHealth', []) returned ok (escape hatch works)
✓ escrow debited 93651 µL across 2 requests
SMOKE PASSED
```

### Open issues delta

- **O-003** — partially closed. The *test* exists and catches the contract break. *Pinning* the web3.js version is not done — kept `^1.91.0` so we get patch fixes automatically. The smoke test is the safety net. Full closure needs this test in CI (not yet wired).
- **O-005** — ✅ closed.

---

## Template for future entries

```
## YYYY-MM-DD — Session N: <headline>

### Status snapshot
<table: component / state / notes>

### Validated end-to-end
<what you actually proved works, with evidence>

### Decisions (D-NNN)
<context / decision / why / consequences>

### Open issues (O-NNN)
<clear, narrow, with fix direction>

### Bench / metrics (optional)
<numbers with N and conditions>
```
