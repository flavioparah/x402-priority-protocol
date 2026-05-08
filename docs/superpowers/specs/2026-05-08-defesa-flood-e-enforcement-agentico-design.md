# Defesa anti-flood + Enforcement agêntico — Design

**Status:** draft
**Data:** 2026-05-08
**Autores:** João Romeiro + Claude (brainstorming)
**Escopo:** x402-Shield (`c:/projetos/x402`)
**Versão alvo:** v0.2.0 (mantém contrato SDK do v0.1)

---

## 1. Motivação

O Shield hoje protege o nó RPC com 3 mecanismos: rate-limit por IP em memória, gate dinâmico por carga (HTTP 402) e fila QoS com prioridade por pagamento. Funciona contra cliente único descontrolado, mas tem lacunas importantes contra ataques distribuídos e abuso semântico:

- **`ipCounters` é um `Map` JS sem TTL nem cap** — 50k IPs distintos viram 50k entradas eternas (memory leak).
- **Sem rate-limit global** — botnet com muitos IPs (cada um abaixo do limite por-IP) bypassa proteção.
- **Sem rate-limit por pubkey** — agente com pubkey válido + Trust-Score pode martelar dentro do orçamento.
- **`/escrow/deposit` amplifica ataques** — sig falsa força chamada `getParsedTransaction` no Solana RPC (custo no upstream, zero pro atacante).
- **`/reputation/:pubkey` é caro** — `getAttestations(100)` + `computeRisk` em cada request, sem cache.
- **Sem cheap reject em `Authorization`** — atacante mandando lixo paga 1.5ms de Ed25519 verify por request, em CPU do Shield.
- **`console.log` síncrono em hot path** — amplificador de carga sob flood.
- **Sem security headers, CORS aberto em endpoints sensíveis**, sem `trust proxy`, sem timeouts agressivos, sem graceful shutdown.

Combinado, um agente malicioso enviando 50k requisições — em 3 padrões realistas: IP único, botnet 50k IPs, ou pubkey válido abusivo — consegue degradar significativamente o serviço. Esta especificação descreve a defesa em camadas que fecha esses vetores **mantendo o contrato SDK** e adicionando regras explícitas de comportamento agêntico para minimizar falsos positivos.

## 2. Objetivos e não-objetivos

### Objetivos

1. Bloquear ≥ 99% de um flood de 50k requisições de IP único antes de tocar o `/rpc` ou Solana.
2. Bloquear ≥ 90% de um flood distribuído de 50k IPs (botnet) antes do `/rpc`.
3. Detectar e travar abuso por pubkey válido com Trust-Score sem banir agentes legítimos.
4. Reduzir CPU do Shield sob flood lixo a < 5% do baseline (cheap reject + circuit breaker).
5. Definir um **Código de Conduta dos Agentes** explícito, máquina-legível, que SDKs e operadores referenciam.
6. Disponibilizar enforcement para **operador-agente** via `/admin/*` com auditoria.
7. Auditoria OWASP completa: security headers, CORS escopado, body limits, supply chain, secrets review.

### Não-objetivos (follow-up)

- Proof-of-Work como alternativa de pagamento (quebra contrato SDK; v0.3+).
- mTLS para `/admin/*` (API key bearer é suficiente pra MVP; mTLS quando volume operador escalar).
- Audit log imutável remoto (S3 WORM, syslog externo) — logs locais bastam pro MVP.
- Cooperação cross-operator no broker (já planejada em RFC separada; este spec é single-operator).

## 3. Restrições de design

| Restrição | Implicação |
|---|---|
| Manter contrato SDK do v0.1 | Sem mudar `Authorization: x402 <sig>.<pubkey>.<msg>`, sem mudar formato dos challenges 402, sem mudar `X-x402-*` existentes. Novos headers são apenas adições. |
| Single-instance por rede (mainnet, devnet, demo) | OK usar Redis sem cluster mode; sem Raft/Paxos pra coordenação de bans. |
| Operador-agente é cidadão de primeira classe | Toda ação humana via SSH/CLI tem equivalente programático com auth. |
| Tudo agêntico | Regras explícitas, máquina-legíveis, com headers determinísticos para feedback. |
| Falso-positivo é pior que falso-negativo | Permanent ban exige evidência cumulativa; multiplicadores Trust-Score; whitelist temporal. |
| Reversível por env flag | Cada nova defesa atrás de feature flag desligável sem rebuild. |

## 4. Arquitetura — 3 camadas

```
                        Internet
                            │
                            ▼
   ┌─────────────────────────────────────────────┐
   │  Camada 1: EDGE (Traefik, já deployado)     │
   │  ─ TLS Let's Encrypt                        │
   │  ─ ratelimit (token bucket por IP)          │
   │  ─ inflightreq (cap conexões)               │
   │  ─ buffering (body size)                    │
   │  ─ headers (HSTS, frameguard, server fingerprint)│
   └─────────────────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────┐
   │  Camada 2: SEMANTIC (Shield Express)        │
   │  ─ helmet + trust proxy + body limits       │
   │  ─ Rate-limit IP/pubkey/global (Redis)      │
   │  ─ Cheap reject Authorization               │
   │  ─ Enforcement ladder (5 tiers)             │
   │  ─ Trust-Score multipliers                  │
   │  ─ /escrow/deposit blindado                 │
   │  ─ /reputation cache 30s                    │
   │  ─ /agent/status, /admin/*, /metrics        │
   │  ─ Graceful shutdown                        │
   │  ─ pino async + sampling                    │
   └─────────────────────────────────────────────┘
                            │
                ┌───────────┴────────────┐
                ▼                        ▼
        ┌──────────────┐         ┌──────────────┐
        │  Camada 3:   │         │  Camada 3:   │
        │  STATE       │         │  UPSTREAM    │
        │  (Redis)     │         │  (Solana)    │
        │              │         │              │
        │ ─ escrow     │         │ ─ /rpc proxy │
        │ ─ nonces     │         │ ─ deposits   │
        │ ─ rate-limit │         │   verify     │
        │ ─ ban tiers  │         │ ─ circuit    │
        │ ─ abuse log  │         │   breaker    │
        │ ─ caches     │         │ ─ keepalive  │
        └──────────────┘         └──────────────┘
```

**Princípio:** cada camada filtra o que a anterior não consegue. Defense-in-depth — mesmo se um middleware Traefik falhar, Shield ainda tem rate-limit Redis.

## 5. Camada 1 — Edge (Traefik middlewares)

Configurados como labels Docker no `docker-compose.{mainnet,devnet}.yml`. Aplicados antes da request chegar no Node.

```yaml
labels:
  # Rate limit por IP (token bucket): 30 req/s sustentado, burst 60
  - "traefik.http.middlewares.x402-ratelimit.ratelimit.average=30"
  - "traefik.http.middlewares.x402-ratelimit.ratelimit.period=1s"
  - "traefik.http.middlewares.x402-ratelimit.ratelimit.burst=60"
  - "traefik.http.middlewares.x402-ratelimit.ratelimit.sourcecriterion.ipstrategy.depth=1"

  # Cap global de 200 conexões em-vôo
  - "traefik.http.middlewares.x402-inflight.inflightreq.amount=200"

  # Body máx 64KB
  - "traefik.http.middlewares.x402-bodylimit.buffering.maxRequestBodyBytes=65536"
  - "traefik.http.middlewares.x402-bodylimit.buffering.memRequestBodyBytes=16384"

  # Security headers
  - "traefik.http.middlewares.x402-headers.headers.stsSeconds=31536000"
  - "traefik.http.middlewares.x402-headers.headers.stsIncludeSubdomains=true"
  - "traefik.http.middlewares.x402-headers.headers.contentTypeNosniff=true"
  - "traefik.http.middlewares.x402-headers.headers.referrerPolicy=strict-origin-when-cross-origin"
  - "traefik.http.middlewares.x402-headers.headers.customResponseHeaders.Server="
  - "traefik.http.middlewares.x402-headers.headers.customResponseHeaders.X-Powered-By="

  # Aplicar
  - "traefik.http.routers.x402-shield-mainnet.middlewares=x402-ratelimit,x402-inflight,x402-bodylimit,x402-headers"
```

**Justificativa dos números:**
- 30 req/s burst 60 por IP — cliente normal faz 1–5 req/s; 100 req/s sustentado já é abuso. Permite picos de retry (60 reqs).
- 200 conexões globais — Shield tem `QOS_MAX_INFLIGHT=100`; 200 dá folga 2× sem estourar fila.
- 64KB body — JSON-RPC do Solana cabe em <4KB; folga 16×.

**Defense-in-depth com Shield (Seção 6):** os limites de Traefik e Shield coexistem porque catam padrões diferentes. Traefik opera em **escala de segundo** (pega spikes — script disparando 30 req/s), Shield opera em **budget por minuto** (pega abuso sustentado — agente que faz 1 req/s por uma hora). Um cliente legítimo razoável (1–5 req/s, 60–300 req/min) passa por ambos sem nem encostar nos tetos.

**Cenário 50k IPs × 1 request:** rate-limit por IP não pega (cada IP só faz 1), mas `inflightreq` global limita a 200 simultâneas; restantes ficam fila no Traefik. Combinado com global rate-limit no Shield (Seção 6), botnet trava.

## 6. Camada 2 — Rate-limit em 3 dimensões (Shield + Redis)

Substitui o `ipCounters` `Map` em memória. Sliding window via `ZSET` no Redis (timestamp como score), atomic Lua script.

### 6.1 Lua atomic — sliding window

```lua
-- KEYS[1] = bucket key; ARGV[1] = max; ARGV[2] = window_ms; ARGV[3] = now
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[3] - ARGV[2])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[1]) then return {0, count} end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[3] .. ':' .. math.random())
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1, count + 1}
```

### 6.2 Três dimensões

| Dimensão | Bucket key | Limite default | Quando bloqueia |
|---|---|---|---|
| Por IP | `rl:ip:{ip}` | 100 / 60s | IP mandando muito |
| Por pubkey | `rl:pk:{pubkey}` | 200 / 60s | Agente real abusando do Trust-Score |
| Global | `rl:global` | 5000 / 60s | Botnet distribuída |

Aplicado em `/rpc`, `/escrow/*`, `/reputation/*`. Qualquer um estourar → 429 com `Retry-After` proporcional.

### 6.3 Buckets dedicados (endpoints caros)

| Bucket | Limite | Aplicado em |
|---|---|---|
| `rl:deposit:ip:{ip}` | 5 / 60s | `/escrow/deposit*` |
| `rl:reputation:ip:{ip}` | 30 / 60s | `/reputation/*` |
| `rl:status:ip:{ip}` | 10 / 60s | `/agent/status` |

### 6.4 Bypass por pagamento

Pagamento aprovado **bypassa** os buckets de IP/pubkey (não o global, que protege o nó). Lógica: se o agente já provou pagamento na request atual (`req.x402Verified`), os contadores do **request seguinte** não recebem incremento dele.

## 7. Camada 2 — Cheap reject + endpoints sensíveis

### 7.1 Cheap reject Authorization

Antes de `nacl.sign.detached.verify` (1.5ms CPU), valida formato:

```js
function preflightAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith("x402 ")) return "missing";
  const parts = authHeader.slice(5).split(".");
  if (parts.length !== 3) return "malformed";
  if (parts[0].length < 80 || parts[0].length > 100) return "sig_length";
  if (parts[1].length < 32 || parts[1].length > 44) return "pubkey_length";
  if (parts[2].length < 50 || parts[2].length > 500) return "msg_length";
  return null;
}
```

Custo do reject: ~50ns. Custo do verify completo: ~1.5ms. **30 000× mais barato.**

### 7.2 Nonce pre-check

Antes do `nacl.verify`, lê o nonce do Redis. Se não existe → 401 imediato (0.2ms vs 1.5ms).

### 7.3 `/escrow/deposit` blindado

1. Rate-limit dedicado (5/min/IP).
2. Validação regex base58 antes de qualquer call externa.
3. Cache negativo de "not found" por 60s (mesma sig não bate Solana de novo).
4. Body limit `express.json({ limit: '1kb' })`.
5. Circuit breaker em `getParsedTransaction` — abre após 5 falhas em 30s.

### 7.4 `/reputation/:pubkey`

1. Rate-limit dedicado (30/min/IP).
2. Validação regex pubkey antes de Redis read.
3. Cache 30s em `cache:rep:{pubkey}`.
4. Etag para clientes que suportam.

### 7.5 `/stats/*`

1. Cache 5s.
2. `getTotalPaidVolume` vira O(1) — adicionar counter `payments_micro_lamports_total` em `K.counters`, incrementado em `recordPayment`.

### 7.6 `/rpc`

1. Body limit `express.raw({ limit: '32kb', type: '*/*' })`.
2. Method allowlist (POST + OPTIONS apenas).
3. Validação Content-Type (rejeita não-JSON).

## 8. Camada 2 — Enforcement ladder (5 tiers)

Princípio: progressão determinística. Agente bom previu o comportamento; falso-positivo no permanent é "praticamente impossível por construção".

### 8.1 Tabela de tiers

| Tier | Trigger | Ação | TTL | Registro durável | Reversibilidade |
|---|---|---|---|---|---|
| 0 — Warning | Uso ≥ 80% do bucket | Header `X-x402-Warning` + `X-x402-Limit-Remaining` | — | nenhum | n/a |
| 1 — Throttle | Bucket cheio | 429 + `Retry-After` | janela do bucket | nenhum | reset auto |
| 2 — Soft ban | 3 throttles consec. em 5min, **OU** 10 sigs inválidas em 60s | 429 em todas as requests | 5 min | `abuse:history:{key}` (24h) | reset auto |
| 3 — Hard ban | 3 soft bans em 24h, **OU** detection signal + 1 throttle | 403 em todas as requests | 1 hora | `abuse:hard-history:{key}` (7d) | reset auto |
| 4 — Permanent | 3 hard bans em 7d, **OU** ação manual via `/admin/ban` | 403 indefinido, set `abuse:permanent` | indef | persistente | só `/admin/unban` |

### 8.2 Chave do bucket por tipo de ofensa

| Tipo | Chave |
|---|---|
| Excesso de RPS | IP |
| Sigs inválidas | IP (sem pubkey verificado) |
| Pubkey-hint mismatch (Trust-Score abuse) | **pubkey** |
| Replay de nonce | IP + pubkey combinado |
| `wash_payment_suspect`, `coordinated_burst`, `dormant_revival` | **pubkey** |
| Tx sig inválida em `/escrow/deposit` | IP |

### 8.3 Multiplicadores Trust-Score

Tolerância maior a quem já provou cooperação:

| Score | Multiplicador rate-limit | Tier ladder |
|---|---|---|
| 0–20 (novo) | 1× | normal |
| 21–50 | 2× | normal |
| 51–80 | 5× + bypass tier 0 | tier 4 inacessível por auto-trigger |
| 81–100 | 10× + tier 2/3 só com evidência cruzada (rate AND fraud signal) | tier 4 inacessível |

### 8.4 Whitelist temporal

Pubkey com idade < `NEW_PUBKEY_WHITELIST_DAYS` (default 30): nunca cai em tier 4 automático. Evita banimento de agentes em fase de bootstrap/debug.

### 8.5 Headers de feedback

Toda resposta de enforcement carrega:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 47
X-x402-Tier: 1
X-x402-Reason: ip-rate-limit
X-x402-Limit-Remaining: 0
X-x402-Until: 1731412847
X-x402-Trust-Impact: none
Content-Type: application/json

{
  "error": "rate_limited",
  "code": 429,
  "tier": 1,
  "reason": "ip-rate-limit",
  "retry_after_seconds": 47,
  "until_epoch": 1731412847,
  "limit": 100,
  "window_seconds": 60,
  "trust_impact": "none",
  "your_score": 12,
  "history": { "throttles_5m": 3, "soft_bans_24h": 0, "hard_bans_7d": 0 },
  "next_tier_at": "soft_ban after 1 more throttle in 5min"
}
```

**Vocabulário fechado de `X-x402-Reason`** (estável, versionado):
- `ip-rate-limit`, `pubkey-rate-limit`, `global-rate-limit`
- `invalid-signature-burst`, `nonce-replay`
- `pubkey-hint-mismatch`, `wash-payment`, `coordinated-burst`, `dormant-revival`
- `deposit-signature-invalid`, `deposit-amount-mismatch`
- `body-too-large`, `malformed-payload`

## 9. Endpoints novos

### 9.1 `GET /agent/status`

Auto-introspecção pelo agente. Cache 10s. Rate-limit 10/min/IP.

```
GET /agent/status?pubkey=<base58>
```

```json
{
  "pubkey": "...",
  "trust_score": 35,
  "trust_multiplier": 2.0,
  "current_tier": 0,
  "throttles_5m": 1,
  "soft_bans_24h": 0,
  "hard_bans_7d": 0,
  "fraud_flags": [],
  "rate_limit_remaining": { "ip": 87, "pubkey": 142, "global": 4823 },
  "rate_limit_reset_seconds": 23,
  "permanent": false,
  "since": 1730000000
}
```

### 9.2 `/admin/*`

Auth: API key bearer assinada (HMAC-SHA256 do `{method, path, body, timestamp}`, header `X-Admin-Auth`). Timestamp anti-replay (válido por 60s). Set via `ADMIN_API_KEY` env. Sem essa env, todos os `/admin/*` retornam 503.

| Endpoint | Função | Rate-limit |
|---|---|---|
| `GET /admin/abuse-log?limit=N&since=ts` | Stream paginado | 30/min |
| `POST /admin/ban` (`{key, type:ip\|pubkey, tier, reason, ttl_s?}`) | Tier-3/4 manual | 10/min |
| `POST /admin/unban` (`{key, type, reason}`) | Remove ban | 10/min |
| `GET /admin/config` | Lê thresholds atuais | 30/min |
| `POST /admin/config` | Hot-reload de thresholds (rate-limit, ban TTLs) | 5/min |
| `GET /admin/agent/:pubkey` | Detalhe completo de identidade | 30/min |

Toda ação em `/admin/*` grava em `audit:admin:log` (LIST append-only):

```json
{
  "ts": 1731412847,
  "actor_key_id": "ops-alice",
  "action": "ban",
  "target": { "type": "pubkey", "key": "Abc..." },
  "tier": 4,
  "reason": "explicit operator action: tx hash 0xdeadbeef",
  "request_signature": "..."
}
```

### 9.3 `GET /agent/code-of-conduct`

Documento estável publicado em JSON. Versionado. Imutável dentro de cada major version (mudanças quebrantes bumpam `version`).

```json
{
  "version": "1.0",
  "rate_budgets": {
    "per_ip": { "sustained_rps": 1.66, "burst": 100, "window_s": 60 },
    "per_pubkey": { "sustained_rps": 3.33, "burst": 200, "window_s": 60 },
    "global": { "sustained_rps": 83.3, "burst": 5000, "window_s": 60 }
  },
  "backoff_protocol": {
    "on_429": "respect Retry-After header; exponential after 3rd consecutive",
    "on_402": "complete handshake; do not retry without payment",
    "on_503": "exponential 1s..30s; check /agent/status before continuing"
  },
  "identity_rules": {
    "pubkey_hint_must_match_signer": true,
    "nonce_single_use": true,
    "pubkey_rotation_max_per_hour": 1,
    "_note_pubkey_rotation_enforcement": "descritiva — enforced indiretamente via cross_provider_velocity / coordinated_burst signals em lib/detection.js, não via middleware dedicado"
  },
  "deposit_rules": {
    "signature_must_be_valid_base58": true,
    "signature_must_credit_payment_destination": true,
    "invalid_signatures_per_5min_max": 5
  },
  "enforcement": {
    "tiers": ["warning", "throttle", "soft_ban", "hard_ban", "permanent"],
    "trust_multipliers": {"0-20": 1, "21-50": 2, "51-80": 5, "81-100": 10},
    "new_pubkey_whitelist_days": 30,
    "feedback_headers": ["X-x402-Tier", "X-x402-Reason", "X-x402-Until", "X-x402-Trust-Impact"]
  },
  "operator_obligations": {
    "audit_log_retention_days": 90,
    "permanent_ban_must_have_reason": true,
    "api_key_rotation_max_days": 90
  }
}
```

### 9.4 `GET /metrics` (Prometheus)

`prom-client`. Rate-limit 10/min/IP ou IP allowlist via Traefik.

Métricas mínimas:
- `x402_requests_total{route, status}` (counter)
- `x402_ratelimit_blocks_total{dimension, tier}` (counter)
- `x402_qos_inflight` (gauge)
- `x402_qos_queue_depth` (gauge)
- `x402_solana_rpc_duration_seconds` (histogram)
- `x402_abuse_events_total{reason}` (counter)
- `x402_admin_actions_total{action}` (counter)

## 10. Hardening operacional

### 10.1 Helmet + trust proxy

```js
app.use(helmet({
  contentSecurityPolicy: { directives: { /* ver design */ } },
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
}));
app.disable("x-powered-by");
app.set("trust proxy", 1);  // só 1º hop (Traefik)
```

### 10.2 Body limits explícitos por rota

| Rota | Limite | Tipo |
|---|---|---|
| `/escrow/deposit*` | 1KB | `express.json` |
| `/admin/*` | 4KB | `express.json` |
| `/rpc` | 32KB | `express.raw` |
| Outros | default 10KB | conforme handler |

### 10.3 Timeouts (4 níveis)

```js
server.headersTimeout = 10_000;     // headers in 10s
server.requestTimeout = 30_000;     // total 30s
server.keepAliveTimeout = 5_000;    // idle 5s
server.timeout = 60_000;            // socket fallback
```

Upstream Solana: `https.Agent({ timeout: 15_000 })` + `proxyTimeout: 15_000`.

### 10.4 CORS escopado

```js
const PUBLIC_READONLY = ["/info", "/health", "/stats/", "/reputation/", "/escrow/balance/", "/agent/code-of-conduct"];
const PROTECTED = ["/escrow/deposit", "/escrow/deposit-trusted", "/admin/"];
```

`Access-Control-Allow-Origin: *` para `PUBLIC_READONLY` e `/rpc`. Origin allowlist (`https://rpcpriority.com`, `https://api.rpcpriority.com`) para `PROTECTED`. SDK server-side não envia Origin → unaffected.

### 10.5 Graceful shutdown

```js
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function shutdown(signal) {
  server.close();                           // stop accept new connections
  app.get("/health", (req, res) => res.status(503).json({ status: "shutting_down" }));
  // wait QoS queue drain (up to 25s) then store.close() and process.exit(0)
}
```

`docker-compose.{mainnet,devnet}.yml`:
```yaml
stop_grace_period: 30s
```

### 10.6 Logging estruturado

`pino` com transport assíncrono:
```js
const logger = pino({ level: process.env.LOG_LEVEL || "info" }, pino.transport({ target: "pino/file", options: { destination: 1, sync: false } }));
```

Substitui todos os `console.log/warn/error`. Sample 1-em-50 após 100 eventos do mesmo `reason`.

Correlation ID (`req.id` 8 chars) em todos os logs + header `X-Request-ID`.

Audit stream separado (`logger.child({ kind: "audit" })`) para deposits validados e ações de admin.

### 10.7 OWASP supply chain

- `npm audit fix` baseline
- Pin exato em deps críticas (`@solana/web3.js`, `express`, `http-proxy-middleware`, `ioredis`, `tweetnacl`, `bs58`)
- `npm ci` em build, não `npm install`
- Adicionar `pino`, `helmet`, `prom-client`, `opossum` ao `package.json`

### 10.8 Secrets

- Redis com `requirepass` (mesmo em rede interna): `redis://:senha@x402-redis-mainnet:6379`
- `ESCROW_TRUST_DEPOSITS=1 + NETWORK=mainnet` → throw na inicialização (guard explícito)
- Documentar rotação de chave wallet em `docs/AGENT-OPERATOR-RUNBOOK.md`
- Documentar rotação de `ADMIN_API_KEY` (default 90 dias)

### 10.9 Container hardening

`docker-compose.{mainnet,devnet}.yml`:
```yaml
services:
  x402-shield-mainnet:
    user: "1000:1000"
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    ulimits:
      nofile: 65535
```

Verificar que Solana SDK não escreve em /var/cache (se escrever, mount tmpfs adicional).

## 11. Solana RPC outbound — circuit breaker

Lib: `opossum`. Wrappa `getParsedTransaction`:

```js
const solanaCircuit = new CircuitBreaker(
  (sig) => getSolanaConnection().getParsedTransaction(sig, {...}),
  { errorThresholdPercentage: 50, resetTimeout: 30_000, timeout: 15_000 }
);
```

Estado exposto em `/metrics` (`x402_solana_circuit_state`). Circuit aberto → `/escrow/deposit` retorna 503.

## 12. Feature flags (env vars)

| Flag | Default | Descrição |
|---|---|---|
| `RATELIMIT_ENABLED` | `true` | Liga rate-limit Redis 3-dim |
| `BADSIG_CIRCUIT_ENABLED` | `false` no código | Liga ban tier-2 por sigs inválidas. Procedimento de deploy: ligar em devnet imediatamente; em mainnet só após 7 dias de observação dos logs. |
| `ENFORCEMENT_TIER_MAX` | `3` | Limite máx auto-tier (`3` = nunca permanent automático) |
| `TRUST_MULTIPLIERS_ENABLED` | `true` | Liga multiplicadores |
| `NEW_PUBKEY_WHITELIST_DAYS` | `30` | Janela "agente novo nunca permanente" |
| `ADMIN_API_KEY` | (vazio) | Vazio = `/admin/*` retorna 503 |
| `METRICS_ENABLED` | `true` | Expõe `/metrics` |
| `LOG_LEVEL` | `info` | `debug` em devnet inicial |
| `LOG_SAMPLE_AFTER` | `100` | Sample após N eventos |
| `BODY_LIMIT_RPC_BYTES` | `32768` | Body máx em /rpc |
| `RATE_IP_LIMIT` | `100` | reqs/min por IP |
| `RATE_PUBKEY_LIMIT` | `200` | reqs/min por pubkey |
| `RATE_GLOBAL_LIMIT` | `5000` | reqs/min globais |
| `SOFT_BAN_DURATION_MS` | `300000` | 5 min |
| `HARD_BAN_DURATION_MS` | `3600000` | 1 h |
| `SOLANA_CIRCUIT_THRESHOLD_PCT` | `50` | % falhas que abre circuit |
| `SOLANA_CIRCUIT_TIMEOUT_MS` | `15000` | timeout chamada Solana |

## 13. Plano de rollout (4 fases)

### Fase 1 — Traefik (edge), devnet → mainnet (~2 dias, baixo risco)

1. Adicionar middlewares ao `docker-compose.devnet.yml`.
2. `docker compose up -d`.
3. Smoke: `npm run bench` + `tools/multi-agent-stress`. p95 inalterado, KPI mantido.
4. Soak 24h. Logs Traefik por 429/413.
5. Replicar em mainnet.

### Fase 2 — Shield base (rate-limit + helmet + trust proxy + body limits + timeouts), devnet → mainnet (~1 semana, médio risco)

1. Code change. Tudo via flags com default `true` (rate-limit-redis, helmet, trust proxy) ou `false` (badsig circuit).
2. Deploy devnet. Bench + multi-agent stress + smoke existentes (`atomic`, `cooperative-qos`, `detection`).
3. Smoke novo: `test/enforcement-ladder.test.js` cobrindo tier 0→3 com cenários determinísticos.
4. Soak 72h. Métricas: `x402_ratelimit_blocks_total`, false-positive rate, CPU baseline.
5. Mainnet com `BADSIG_CIRCUIT_ENABLED=false`. Aguardar 7 dias monitorando.
6. Habilitar `BADSIG_CIRCUIT_ENABLED=true` em mainnet quando confortável.

### Fase 3 — Enforcement ladder + Trust-Score multipliers (~1 semana, médio risco)

1. Rollout com `ENFORCEMENT_TIER_MAX=2` (só warning + throttle + soft-ban; hard-ban e permanent off).
2. Smoke individual de cada tier.
3. Após 7 dias estável: `ENFORCEMENT_TIER_MAX=3` (libera hard-ban).
4. Após mais 14 dias estável: `ENFORCEMENT_TIER_MAX=4` **se** zero falso-positivo conhecido. Caso contrário, manter `3` indefinidamente — permanent só via `/admin/ban`.

### Fase 4 — `/agent/status`, `/admin/*`, `/metrics`, `/agent/code-of-conduct` (~3 dias, baixo risco)

1. `/agent/status`, `/agent/code-of-conduct` e `/metrics` primeiro (read-only).
2. `/admin/*` por último; deploy só após `ADMIN_API_KEY` rotativa configurada e documentada.
3. Audit log de admin testado (gravando event de cada chamada antes de retornar).
4. Documentar `docs/AGENT-OPERATOR-RUNBOOK.md`.

## 14. Smoke tests novos

| Arquivo | Cobre |
|---|---|
| `test/ratelimit-3dim.test.js` | Os 3 buckets (IP, pubkey, global) bloqueando independentemente |
| `test/enforcement-ladder.test.js` | Tier 0→3 com cenários determinísticos |
| `test/trust-multiplier.test.js` | Pubkey score 80 não cai em tier-2 com 3 throttles |
| `test/agent-status.test.js` | `/agent/status` retorna histórico correto, cache 10s |
| `test/admin-ban.test.js` | `/admin/ban` com auth válida banca; auth inválida 401; audit log entry |
| `test/feedback-headers.test.js` | Toda 429/403 carrega `X-x402-Tier/Reason/Until/Trust-Impact` |
| `test/circuit-breaker-solana.test.js` | `/escrow/deposit` abre circuit após 5 falhas |
| `test/cheap-reject.test.js` | Lixo no Authorization rejeita em <50ns sem chamar Ed25519 |
| `test/graceful-shutdown.test.js` | SIGTERM drena fila QoS antes de fechar Redis |

## 15. Métricas de sucesso ("pronto")

| Métrica | Threshold | Como medir |
|---|---|---|
| Falso-positivo soft-ban em pubkey score≥50 | < 0.1% da população | `/metrics` filtrado por trust score |
| Bloqueio efetivo de 50k requests de 1 IP | > 99% 429/403 sem tocar Solana | bench específico |
| Bloqueio efetivo de botnet (50k IPs × 1 req) | > 90% via global/inflight | `tools/multi-agent-stress` |
| p95 do `/rpc` em load normal | mesmo do bench atual (~150ms) | `npm run bench` |
| CPU do Shield em load 100 RPS | < 30% em 1 vCPU | docker stats + `/metrics` |
| Memória estável após 24h em flood | crescimento < 5% / hora | docker stats + `/metrics` |
| Falsos positivos em `/admin/abuse-log` | <1 / dia | revisão manual da log durante soak |

## 16. Riscos e mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Falso-positivo banindo agente legítimo | Baixa (3 hard bans em 7d, com decay) | Alto | Multiplicadores Trust-Score; whitelist 30 dias; alertas tier-3 antes de tier-4 auto |
| Evasão por rotação de identidade | Alta | Médio | Permanent ban também banca IP histórico; `coordinated_burst` detecta padrão; rate-limit global cobre |
| Operador-agente abusivo (banca competidores) | Média | Alto | Audit log assinado; permanent exige `reason`; broker cross-operator (futuro) cross-valida |
| Mass-ban acidental (bug) | Baixa | Catastrófico | Rate-limit em `/admin/ban` (10/min); soft-fail se taxa exceder 10% por hora |
| Vazamento da `ADMIN_API_KEY` | Média | Catastrófico | Rotação documentada (90d); HMAC com timestamp anti-replay; IP allowlist Traefik |
| Container hardening quebra Solana SDK | Média | Médio | Testar em devnet primeiro; tmpfs adicional se necessário; flag pra desligar `read_only` |
| Redis down | Baixa | Alto (degradação) | Fallback in-memory automático com warning log; monitor health no `/health` |
| Cache stale em `/reputation` (30s) | Alta | Baixo (preço Trust-Score lag) | TTL curto; trade-off aceito |

## 17. Out of scope (follow-ups explícitos)

- **Proof-of-Work tier free** — quebra contrato SDK (v0.3+).
- **mTLS para `/admin/*`** — quando volume operador escalar.
- **Container `seccomp` profile customizado** — após `cap_drop: ALL` baseline estabilizar.
- **Audit log imutável remoto** — quando crescer pra multi-operator (S3 WORM, syslog externo).
- **Rotação automática de wallet key** — operacional, runbook humano por enquanto.
- **Cooperação cross-operator no broker** — RFC separada (`docs/TRUST-SCORE-RFC-DRAFT.md`).
- **Detection signals em tempo real** — hoje rodam só em `/reputation`; mover pra hot path requer caching/streaming não trivial.

## 18. Cronograma estimado

| Semana | Atividade |
|---|---|
| 1 | Fase 1 (Traefik) + Fase 2 início (Shield base) em devnet |
| 2 | Fase 2 finalização + Fase 3 (ladder) em devnet + soak |
| 3 | Fase 1+2+3 em mainnet (com `ENFORCEMENT_TIER_MAX=2`) |
| 4 | Fase 4 (admin endpoints) + escalar `ENFORCEMENT_TIER_MAX` em mainnet conforme métricas |

Total: **~4 semanas até full rollout**, cada incremento já trazendo proteção utilizável.

---

**Próximo passo:** após aprovação deste spec, gerar plano de implementação detalhado via skill `writing-plans` com tarefas TDD por fase.
