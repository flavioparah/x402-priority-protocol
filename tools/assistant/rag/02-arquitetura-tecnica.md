# Arquitetura técnica

## Stack

- **Backend Shield**: Node.js + Express + http-proxy-middleware
- **Persistência**: Redis (com fallback in-memory pra dev)
- **Edge**: Traefik na VPS (TLS terminating, Let's Encrypt automático)
- **Static**: nginx no container x402-landing (serve HTML/JS dashboards)
- **Crypto**: tweetnacl (Ed25519), bs58 (base58 Solana)
- **Solana SDK**: @solana/web3.js + ioredis

## Layout de subdomínios em produção

| URL | Função | Container |
|---|---|---|
| rpcpriority.com | Landing institucional | x402-landing (nginx) |
| www.rpcpriority.com | Redirect 301 → apex | Traefik middleware |
| app.rpcpriority.com | Dashboard interativo (try/live/explorer) | x402-landing (nginx) |
| api.rpcpriority.com | API canônica mainnet | x402-shield-mainnet (Node) |
| mainnet.rpcpriority.com | Alias mainnet | x402-shield-mainnet |
| devnet.rpcpriority.com | Shield devnet | x402-shield-devnet |
| demo.rpcpriority.com | Shield trust-score demo (trusted deposits) | x402-shield (base) |

Todos com cert Let's Encrypt válido, deploy via Docker Compose + Traefik labels.

## Camadas de prioridade Solana (mapa mental)

```
┌────────────┐                                   ┌─────────┐
│  Client/   │                                   │ Solana  │
│  Agent     │                                   │ chain   │
└─────┬──────┘                                   └────┬────┘
      │                                                │
      │  [1. RPC ACCESS layer — NÓS]                  │
      ├─→ x402 Shield (priority pra falar com RPC)    │
      │                                                │
      │  [2. RPC NODE]                                 │
      ├─→ Helius/Triton/Jito-RPC                      │
      │                                                │
      │  [3. NATIVE PRIORITY FEES]                     │
      ├─→ ComputeUnitPrice (TX inclusion)             │
      │                                                │
      │  [4. NATIVE BASE FEE]                          │
      ├─→ 5k lamports/sig (TX existence)              │
      │                                                │
      │  [5. VALIDATOR/LEADER ordering]                │
      └────────────────────────────────────────────────┘
                                      ↑
                              Jito Bundles
                              (bundle landing)
```

**Implicação**: nós não competimos com Jito (camada do validator) nem com native fees (camada do consensus). Operamos numa camada acima (RPC access). **Cliente paga TODOS, em ordem, sem conflito.**

## Fluxo de pagamento detalhado

### 1. Discovery (zero código, zero custo)
```
GET https://api.rpcpriority.com/info
→ {operator_pubkey, network, base/max prices, threshold, trusted_deposits}
```

### 2. Funding da escrow (1× por cliente)
```
# On-chain transfer
SystemProgram.transfer({
  fromPubkey: clientWallet,
  toPubkey: <operator_pubkey>,
  lamports: 10000  // 0.00001 SOL
})

# Post pra Shield
POST /escrow/deposit
{ "tx_signature": "<bs58>" }

# Shield verifica on-chain (origem, destino, valor, anti-replay)
# Credita 1.000 µL por lamport (1.000 lamports = 1.000.000 µL)
```

### 3. Request normal sob carga
```
POST /rpc {jsonrpc:"2.0", method:"getBalance", params:[<pk>], id:1}
```

### 4. Resposta 402 (gating ativo)
```
HTTP/1.1 402 Payment Required
X-x402-Status: challenged
X-x402-Payment-Destination: <pubkey>
X-x402-Amount: 20100
X-x402-Amount-Base: 40200
X-x402-Trust-Score: 100
X-x402-Nonce: <32-char hex>
X-x402-Nonce-TTL: 30
Content-Type: application/json

{
  "error": "Payment Required",
  "code": 402,
  "payment": {
    "destination": "...",
    "amount_micro_lamports": 20100,
    "trust_score": 100,
    "nonce": "...",
    "ttl_seconds": 30
  }
}
```

### 5. Cliente assina nonce off-chain (Ed25519)
```javascript
const payload = JSON.stringify({nonce, pubkey, amount, destination});
const sig = nacl.sign.detached(Buffer.from(payload, "utf8"), secretKey);
const auth = `x402 ${bs58.encode(sig)}.${pubkey_b58}.${bs58.encode(payload)}`;
```

### 6. Retry com proof
```
POST /rpc {jsonrpc:"2.0", method:"getBalance", params:[<pk>], id:1}
Authorization: x402 <bs58sig>.<bs58pubkey>.<bs58msg>

→ Shield verifica:
   - Lua atomic: check nonce → debit escrow (race-free)
   - Forward pro upstream RPC
   - Returns RPC response
```

## Persistência (Redis)

| Key pattern | Tipo Redis | Conteúdo |
|---|---|---|
| `x402:escrow` | HASH | pubkey → microLamports |
| `x402:nonce:<id>` | STRING + TTL | JSON {amount, destination, used, hintedPubkey} |
| `x402:reputation:<pubkey>` | HASH | paidCount, firstPaidAt, lastPaidAt, totalPaid |
| `x402:reputation:index` | ZSET | pubkey → paidCount (leaderboard) |
| `x402:deposit-sigs` | SET | tx_signatures consumidas (anti-replay) |
| `x402:stats:payments` | LIST (LPUSH+LTRIM 100) | últimos 100 payments |
| `x402:stats:challenges` | LIST (LPUSH+LTRIM 100) | últimos 100 challenges |
| `x402:stats:load-history` | LIST (LPUSH+LTRIM 60) | 60 amostras de load (1h) |
| `x402:stats:counters` | HASH | payments_total, challenges_total |
| `x402:stats:qos-totals` | HASH | dispatched_total, bypassed_total, rejected_* |

**Atomic primitive (Lua)**: `consumeNonceAndDebit` faz check + mark + debit em uma execução server-side. Race-free. 2 callers concorrentes com mesma nonce: 1 ganha, outro recebe `nonce_already_used`.

## QoS interno

Modos:
- **standalone** (default): fila de prioridade dentro do Shield, ordenada por `effectiveScore = (verifiedAmount + verifiedTrustScore × 100) + ageMs/50`. Aging boost previne starvation.
- **cooperative**: Shield envia `X-Priority-Score` ao operador upstream; operador retorna `X-QoS-Overload:1` se sobrecarregado, Shield faz fallback automático pra standalone.
- **off**: passa direto.

Backpressure:
- queue_depth > QOS_MAX_QUEUE_DEPTH (default 1000) → HTTP 503
- waiting > QOS_QUEUE_TIMEOUT_MS (default 10s) → HTTP 504

## Endpoints completos

### POST
- `/rpc` — proxy gated
- `/escrow/deposit` — verified on-chain deposit
- `/escrow/deposit-trusted` — só em demo (ESCROW_TRUST_DEPOSITS=1)

### GET (com content negotiation: browser → HTML, SDK → JSON)
- `/info` — gateway metadata
- `/health` — load + RPS + nonces ativos
- `/stats/recent` — últimos 20 payments + totals
- `/stats/qos` — QoS dispatcher state
- `/stats/leaderboard` — top 10 por Trust-Score
- `/escrow/balance/:pubkey`
- `/reputation/:pubkey`

Force JSON num browser via `?raw=1`.
