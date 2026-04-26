# Deploy — x402-shield on VPS (kvm4)

Target: `ssh kvm4` → `/root/x402`, behind Traefik with TLS on `x402.rpcpriority.com`.

This matches the Vokano / amiginvisivel pattern already running on this VPS: `portainer_default` external Docker network + Traefik labels + Let's Encrypt via `leresolver`.

---

## Prerequisites (one-time, already done on this VPS)

- Docker + Docker Compose installed.
- `portainer_default` network exists (`docker network ls | grep portainer`). Traefik joins this network.
- Traefik is running with `entrypoints=websecure` on `:443` and `certresolver=leresolver` pointing at Let's Encrypt.
- DNS record `x402.rpcpriority.com` → the VPS public IP.

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
curl -s https://x402.rpcpriority.com/health | jq
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

## Smoke test from a client machine

```bash
# Healthy?
curl -i https://x402.rpcpriority.com/health

# Trigger the 402 path from any client
curl -i -X POST https://x402.rpcpriority.com/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'

# Expect either 200 (load below threshold) or 402 with the
# X-x402-Payment-Destination / X-x402-Amount / X-x402-Nonce headers.
```

To exercise the full handshake against the deployed Shield, run the demo
script with `SHIELD_URL` pointing at the VPS:

```bash
SHIELD_URL=https://x402.rpcpriority.com node demo.js
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

1. **DNS** — add an A record `x402-devnet.rpcpriority.com` → VPS public IP (same IP as `x402.rpcpriority.com`). Wait ~5 min for propagation.

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
# x402-shield          → x402.rpcpriority.com           (mainnet, trust-deposit ON)
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

## Known things to do before mainnet-beta traffic (not before the hackathon demo)

- **Validate deposits on-chain** — `/escrow/deposit` currently trusts the posted amount (see O-001 in `ENGINEERING.md`). For any public traffic, wire it to verify a Solana tx signature that transfers the claimed amount to `PAYMENT_DESTINATION`.
- **Wire a real load metric** — `getRpcLoad()` returns a `Math.random()` value (O-002). Replace with a sliding window of `req/s` or with a Prometheus scrape from the upstream node's metrics.
- **Redis-backed state** — escrow balances, nonces, and rate counters live in-memory. A restart wipes them and multiple Shield replicas can't share state.
