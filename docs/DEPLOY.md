# Deploy — x402-shield on VPS (kvm4)

> **For:** operators deploying x402-shield to production VPS / bare-metal.

Target: `ssh kvm4` → `/root/x402`, behind Traefik with TLS on `api.rpcpriority.com`.

This matches the Vokano / amiginvisivel pattern already running on this VPS: `portainer_default` external Docker network + Traefik labels + Let's Encrypt via `leresolver`.

---

## Prerequisites (one-time, already done on this VPS)

- Docker + Docker Compose installed.
- `portainer_default` network exists (`docker network ls | grep portainer`). Traefik joins this network.
- Traefik is running with `entrypoints=websecure` on `:443` and `certresolver=leresolver` pointing at Let's Encrypt.
- DNS record `api.rpcpriority.com` → the VPS public IP.

## Files that go to the server

The Docker image is built from these files only:

- `package.json`, `package-lock.json` — for `npm ci --omit=dev`
- `index.js` — the Shield runtime
- `Dockerfile` — production image
- `docker-compose.yml` — service + Traefik wiring
- `.env` — secrets (created from `.env.example`, not committed)

`demo.js`, `bench.js`, `x402-client-sdk.ts`, `docs/`, and the test tooling stay in the repo but are not needed at runtime.

---

## First deploy (from scratch)

```bash
# 1. SSH in
ssh kvm4

# 2. Clone the repo
cd /root
git clone https://github.com/flavioparah/x402-priority-protocol.git x402
cd x402

# 3. Provision the .env
cp .env.example .env
$EDITOR .env
# Set PAYMENT_DESTINATION to the production Solana wallet.
# Leave REAL_RPC_URL at mainnet-beta unless you have a private node.

# 4. Build + start
docker compose up -d --build

# 5. Check it's up
docker compose logs -f --tail=50 x402-shield
curl -s https://api.rpcpriority.com/health | jq
```

Expected `/health` output:

```json
{ "status": "ok", "load": "0.82", "threshold": 0.75, "nonces_active": 0 }
```

## Subsequent deploys (pull + rebuild)

```bash
ssh kvm4
cd /root/x402
git pull
docker compose up -d --build
docker compose logs -f --tail=50 x402-shield
```

The in-memory state (escrow, nonces, rate counters) is lost on restart. This is acceptable for the MVP — operators should treat the MVP Shield as ephemeral. Real deployments will need Redis (see open issue O-001 / O-002 in `ENGINEERING.md`).

---

## Gotcha: bind-mounted config files survive `nginx -s reload` with stale content

When a config file is mounted into a container via Docker bind mount (e.g., `./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro`), the mount is bound to the file's **inode** at container start time, not its path.

`git pull` (and `mv`, `rm + write`, IDE save-as, most editors) **replaces** the file on the host with a new inode. The old inode becomes orphaned. The container continues to see the original file content because its bind mount still points at the orphaned inode.

`docker exec <container> nginx -s reload` re-reads the file from the bind-mount path — which is the orphaned inode, with the old content. So the reload "succeeds" but nothing changes.

**Symptom**: you `git pull` config changes, run `nginx -s reload`, and behaviour doesn't change. `docker exec <container> cat <config>` shows the old content.

### Decision rule

| Change type | Action |
|---|---|
| In-place edit (`sed -i`, `tee`, vi/nano save-in-place) | `docker exec <container> nginx -s reload` is enough |
| File replacement (`git pull`, `cp`, `mv`, most IDEs) | **Recreate the container** |

### Recreate (the fix)

```bash
docker compose -f docker-compose.landing.yml up -d --force-recreate
```

`--force-recreate` re-resolves bind mounts against current host inodes. Container downtime is ~1 s.

For the application code (Node `index.js` in the shields), `--build` is the analogous step (rebuild the image).

### How to verify the bind mount is fresh

```bash
# Should match
diff <(docker exec x402-landing cat /etc/nginx/conf.d/default.conf) \
     /root/x402/nginx/default.conf
```

If diff returns anything, the container is on a stale inode — recreate.

---

## Gotcha: Solana rent-exempt minimum on multi-agent funding

When spinning up N ephemeral wallets to stress-test the Shield (see `tools/stress-test/spawn-agents.js`), each new wallet **must** end every transaction with at least ~890_880 lamports (the rent-exempt minimum for a native account). If you fund a fresh wallet with just `deposit_amount + tx_fee`, the wallet's post-tx balance falls below rent-exempt and Solana rejects the transaction with `"Transaction results in an account (0) with insufficient funds for rent"`.

**Fix**: treasury must send `FUND_LAMPORTS + 900_000 (rent-exempt buffer) + 5_500 (tx fee)` per agent. The rent-exempt portion stays stuck in the ephemeral wallet (~$0.075 per agent at $83/SOL — uncrunchable cost without closing the account in another tx).

Implemented in `tools/stress-test/spawn-agents.js` constants `RENT_EXEMPT_RESERVE` and `TX_FEE`. See commit `b949aa7`.

---

## Gotcha: Public mainnet-beta RPC throttles bursts (HTTP 429)

The Shield's `verifyDepositTx()` calls `getParsedTransaction` on the upstream RPC (defaults to `api.mainnet-beta.solana.com`) to verify each on-chain deposit. Public mainnet-beta has aggressive rate limits — concurrent `/escrow/deposit` POSTs above ~3 simultaneous trigger 429 from the upstream, propagated as HTTP 400 from the Shield with body `RPC error fetching transaction: 429 Too Many Requests`.

**Two mitigations:**

1. **Client-side**: retry the `/escrow/deposit` POST with backoff (3s, 8s, 15s). `tools/stress-test/spawn-agents.js` does this.
2. **Server-side (recommended for production)**: switch `REAL_RPC_URL` and `SOLANA_RPC_URL` to a private RPC provider (Helius, Triton, QuickNode) that doesn't throttle. Public mainnet-beta is for demo/dev only.

When running stress tests against mainnet, **keep `PARALLEL=1`** in `spawn-agents.js`. Sequential is slow (~30s per agent for 2 confirmations) but reliable. Parallel >3 hits 429s frequently even with retries.

## Edge middlewares (Phase 1)

Once Phase 1 is deployed, Traefik enforces 4 middlewares **before** any
request reaches Node:

- `x402-ratelimit` — 30 req/s sustained, burst 60, per-IP
- `x402-inflight` — 200 concurrent connections (cumulative across devnet+mainnet)
- `x402-bodylimit` — 64KB max request body
- `x402-headers` — HSTS / no-sniff / referrer policy / strip Server fingerprint

Full operational guide: [`docs/EDGE-MIDDLEWARE-RUNBOOK.md`](EDGE-MIDDLEWARE-RUNBOOK.md).

Quick post-deploy sanity from a client machine:

```bash
SHIELD_URL=https://devnet.rpcpriority.com bash tools/edge-smoke/test-security-headers.sh
SHIELD_URL=https://devnet.rpcpriority.com bash tools/edge-smoke/test-bodylimit.sh
SHIELD_URL=https://devnet.rpcpriority.com bash tools/edge-smoke/test-ratelimit.sh
```

All three must exit 0. The `test-inflight.sh` smoke is heavier and runs
once at hour 0 / 12 / 24 of the soak window per the runbook.

## Smoke test from a client machine

```bash
# Healthy?
curl -i https://api.rpcpriority.com/health

# Trigger the 402 path from any client
curl -i -X POST https://api.rpcpriority.com/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'

# Expect either 200 (load below threshold) or 402 with the
# X-x402-Payment-Destination / X-x402-Amount / X-x402-Nonce headers.
```

To exercise the full handshake against the deployed Shield, run the demo
script with `SHIELD_URL` pointing at the VPS:

```bash
SHIELD_URL=https://api.rpcpriority.com node demo.js
```

## Rollback

```bash
ssh kvm4
cd /root/x402
git log --oneline -n 10      # pick a safe commit
git checkout <sha>
docker compose up -d --build
```

## Teardown

```bash
ssh kvm4
cd /root/x402
docker compose down
# to wipe built images:
docker compose down --rmi local
```

---

## Devnet companion deployment (`x402-devnet.rpcpriority.com`)

A second Shield runs alongside the mainnet container to demonstrate the **on-chain payment verification path** without spending real SOL. It points at Solana devnet and has `ESCROW_TRUST_DEPOSITS` turned **off**, so every payment is verified via `getParsedTransaction`.

### Required prep (one-time)

1. **DNS** — add an A record `x402-devnet.rpcpriority.com` → VPS public IP (same IP as `api.rpcpriority.com`). Wait ~5 min for propagation.

2. **Wallet for devnet payments** — set `PAYMENT_DESTINATION_DEVNET` in `/root/x402/.env`. Can be the **same** Solana pubkey used for mainnet (Solana addresses are universal across clusters); devnet SOL just won't show up in mainnet explorers.

   ```bash
   echo "PAYMENT_DESTINATION_DEVNET=YourSolWalletHere" >> /root/x402/.env
   ```

### Deploy

```bash
ssh kvm4
cd /root/x402
git pull

# Bring up the devnet container (uses docker-compose.devnet.yml)
docker compose -f docker-compose.devnet.yml up -d --build

# Both containers are now running
docker ps | grep x402
# x402-shield          → api.rpcpriority.com           (mainnet, trust-deposit ON)
# x402-shield-devnet   → x402-devnet.rpcpriority.com    (devnet, on-chain verify only)
```

Traefik will issue a fresh Let's Encrypt cert for the new hostname on the first request (~30 s). If you see "404 page not found" right after `up -d`, wait a moment and retry — Traefik is still negotiating the cert.

### Verify devnet deployment

```bash
# Healthcheck
curl -s https://x402-devnet.rpcpriority.com/health | jq

# Should respond 402 (RPC_LOAD_FORCE=0.9 is the default)
curl -i -X POST https://x402-devnet.rpcpriority.com/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'
```

### Run the on-chain demo end-to-end

From your laptop:

```bash
SHIELD_URL=https://x402-devnet.rpcpriority.com \
SOLANA_RPC_URL=https://api.devnet.solana.com \
node examples/deposit-with-tx.js
```

This script:
1. Generates a fresh Ed25519 keypair
2. Requests an airdrop from devnet (1 SOL — may rate-limit, see fallback below)
3. Sends `SystemProgram.transfer` to `PAYMENT_DESTINATION_DEVNET`
4. Posts the `tx_signature` to `POST /escrow/deposit`
5. Shield calls `getParsedTransaction` against `api.devnet.solana.com`, validates the transfer, credits escrow
6. Issues a paid RPC request and verifies the response

If the airdrop returns HTTP 429, set `AGENT_SECRET_KEY` in env to use a pre-funded keypair instead:

```bash
AGENT_SECRET_KEY="[1,2,3,...]" \
SHIELD_URL=https://x402-devnet.rpcpriority.com \
SOLANA_RPC_URL=https://api.devnet.solana.com \
node examples/deposit-with-tx.js
```

### Bringing it down

```bash
ssh kvm4
cd /root/x402
docker compose -f docker-compose.devnet.yml down
# mainnet container untouched
```

### Why two deployments instead of one with a flag

- The mainnet shield is the headline demo (fast, trusted-deposit, 22-req Trust-Score progression). Don't risk breaking it by reconfiguring.
- The devnet shield proves the on-chain path is real, not vapor. Two containers, two hostnames, two narratives — neither compromises the other.
- Trust-Score state is in-memory per container, so a devnet restart never affects mainnet reputation data.

---

## Known limitations and what's already in place

**Resolved (already shipped):**

- ✅ **On-chain deposit verification** — `POST /escrow/deposit` fetches the
  Solana tx via `getParsedTransaction`, verifies sender + destination +
  amount + single-use, then credits escrow at `1 lamport = 1000 µL`.
  See `verifyDepositTx` in `index.js`. End-to-end validated on mainnet
  (tx `2fP8DQhy...` finalized at slot 415702360, 2026-04-25).
- ✅ **Real load metric** — `getRpcLoad()` returns the sliding-window req/s
  over `LOAD_WINDOW_MS` (5 s default), normalized against `MAX_RPS`.
  `RPC_LOAD_FORCE=<0..1>` overrides for demo recording.
- ✅ **Redis-backed state** — escrow balances, nonces, reputation, and
  used deposit signatures persist in Redis with AOF (`lib/store.js`).
  Each shield deploys with a sidecar Redis container; eviction policy is
  `volatile-lru` so only the 30 s nonces can be evicted under pressure.
- ✅ **Atomic consume** — nonce-mark + escrow-debit run in a single
  Redis Lua script (or single JS tick for in-memory mode). Two parallel
  requests with the same signed nonce: exactly one accepted, the rest
  rejected with `nonce_already_used`. Validated by:
  - `npm run test:atomic` — 5/5 assertions in-memory mode (always runs)
  - `npm run test:atomic:redis` — same assertions against a real Redis
    instance, exercising the Lua-script path. Requires `REDIS_URL`
    env var pointing at a reachable Redis.
- ✅ **Per-pubkey attestation log + sybil/fraud detection** — every paid
  request appends to `x402:attestations:<pubkey>` (LIST, max 100). 5
  detection signals exposed via `/reputation/:pubkey` (`sybil_risk`,
  `fraud_flags`, `churn_pattern`); two are active in single-op mode,
  three activate when a 2nd operator joins with a distinct
  `OPERATOR_ID`. See `lib/detection.js` and
  `docs/TRUST-SCORE-RFC-DRAFT.md` §10.

**Still pending for production scale (post-hackathon):**

- **Multi-instance QoS coordination** — the priority queue is per-instance
  today (`qosQueue` in `index.js`). For horizontal scaling, migrate it to
  a shared Redis ZSET with cross-instance dispatch coordination via Pub/Sub.
- **Multi-region Redis with replication** — single Redis sidecar per shield
  is fine for a single-VPS deploy; multi-region needs Redis Cluster or
  Sentinel.
- **Prometheus scrape of upstream node** — each shield measures its own
  throughput as a proxy for upstream load. For better accuracy, scrape
  the upstream's `solana_rpc_*` metrics directly. Tracked as Open Issue
  in `ENGINEERING.md`.
- **Audit trail / compliance** — all `/attest` and `/report` calls (when
  the broker becomes a separate service) need immutable append-only logs
  for SOC 2 / financial-grade auditability.
- **On-chain per-request settlement (`x402-tx`)** — currently only deposits
  are on-chain; per-request settlement is off-chain via the escrow ledger.
  A future `x402-tx` mode would let agents submit serialized
  SystemProgram.transfer per request without a pre-deposit step.
