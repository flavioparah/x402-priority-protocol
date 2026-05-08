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

O `member` do `ZADD` é fornecido pelo cliente como ARGV[4] (formato `${now}:${counter}:${pid}`, monotônico por processo). Não usar `math.random()` em Lua — não é cripto-aleatório, pode colidir em alta concorrência e adiciona não-determinismo desnecessário.

```lua
-- KEYS[1] = bucket key
-- ARGV[1] = max; ARGV[2] = window_ms; ARGV[3] = now; ARGV[4] = unique member id
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[3] - ARGV[2])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[1]) then return {0, count} end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1, count + 1}
```

Cliente Node:
```js
const memberId = `${now}:${++ctr}:${process.pid}`;
const [ok, count] = await r.slidingWindowConsume(bucketKey, max, windowMs, now, memberId);
```

### 6.2 Três dimensões

| Dimensão | Bucket key | Limite default | Quando bloqueia |
|---|---|---|---|
| Por IP | `rl:ip:{ip}` | 100 / 60s | IP mandando muito |
| Por pubkey | `rl:pk:{pubkey}` | 200 / 60s | Agente real abusando do Trust-Score |
| Global | `rl:global` | 5000 / 60s | Botnet distribuída |

Aplicado em `/rpc`, `/escrow/*`, `/reputation/*`. Qualquer um estourar → 429 com `Retry-After` proporcional.

### 6.3 Tabela canônica de budgets por rota (obrigatória)

Cada rota tem buckets explícitos. Nenhuma rota compete contra outra (separação por chave). `[g]` indica buckets compartilhados (rate-limit global).

| Rota | Bucket por IP | Bucket por pubkey (paid lane) | Compartilha global? |
|---|---|---|---|
| `/rpc` | `rl:rpc:ip:{ip}` 100/60s | `rl:rpc:pk:{pubkey}` 200/60s · paid lane: `rl:rpc:paid:{pubkey}` (limite × multiplicador Trust-Score) | Sim — `rl:global` 5000/60s |
| `/escrow/deposit*` | `rl:deposit:ip:{ip}` 5/60s | n/a (sem auth) | Não (separado) |
| `/escrow/balance/:pk` | `rl:balance:ip:{ip}` 60/60s | n/a | Não |
| `/reputation/:pk` | `rl:reputation:ip:{ip}` 30/60s | n/a | Não |
| `/stats/*` | `rl:stats:ip:{ip}` 60/60s | n/a | Não |
| `/agent/status` | `rl:status:ip:{ip}` 10/60s | n/a | Não |
| `/admin/*` | n/a (auth obrigatória) | `rl:admin:keyid:{key_id}` 10/60s | Não |
| `/info`, `/health`, `/agent/code-of-conduct` | `rl:meta:ip:{ip}` 120/60s | n/a | Não |
| `/metrics` | `rl:metrics:ip:{ip}` 10/60s ou IP allowlist via Traefik | n/a | Não |

**Nenhum endpoint sai dessa tabela.** Adicionar nova rota implica adicionar entrada aqui — falha de revisão de PR caso contrário.

### 6.4 Paid lane (substitui o "bypass por pagamento")

**Não há bypass.** Pagamento aprovado **não pula** rate-limit por IP/pubkey/global. O Trust-Score e o pagamento concedem acesso a um bucket *separado* com orçamento *expandido*, mas sempre contado.

Por agente pagante, dois buckets (`rl:rpc:pk:{pubkey}` e `rl:rpc:paid:{pubkey}`) são consultados:

| Faixa Trust-Score | `rl:rpc:pk:{pubkey}` (sem paid) | `rl:rpc:paid:{pubkey}` (com pagamento na request anterior < 60s) |
|---|---|---|
| 0–20 | 200/60s | 200/60s × 1 = 200 |
| 21–50 | 200/60s | 200/60s × 2 = 400 |
| 51–80 | 200/60s | 200/60s × 5 = 1000 |
| 81–100 | 200/60s | 200/60s × 10 = 2000 |

**Bucket global (`rl:global` 5000/60s) sempre aplica**, mesmo pra paid lane. Defesa do nó como um todo é não-negociável.

**Vetor que isso fecha:** agente funded (escrow grande, pagou uma vez) pode martelar até 1000 ou 2000 req/min — mas não infinito. Mesmo Trust-Score 100 não vira "passe livre". Combinado com detection signals (`wash_payment_suspect`, `coordinated_burst`), abuso por agente pago detecta-se em poucos minutos.

## 7. Camada 2 — Cheap reject + endpoints sensíveis

### 7.1 Cheap reject Authorization

Antes de `nacl.sign.detached.verify`, validar formato com **comparações cheap** (regex de tamanho, sem decodificar conteúdo):

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

**Contrato comportamental** (testável, em vez de número absoluto):
- Quando `preflightAuth` retorna não-null, `nacl.sign.detached.verify` **MUST NOT** ser chamado. Verificado em `test/cheap-reject.test.js` via spy/stub no nacl.
- Quando `preflightAuth` retorna não-null, `bs58.decode` **MUST NOT** ser chamado nas partes do header.
- Latência relativa: cheap-reject < 1% do tempo de uma request com verify completo (medido em micro-bench, número de referência informativo, não SLO).

### 7.2 Nonce pre-check (com bounding obrigatório)

Pra validar o nonce antes do verify caro, é necessário decodificar a mensagem **não autenticada**. Trata-se de dado hostil — todo bound deve ser explícito:

```js
async function noncePreCheck(parts) {
  // Invariantes:
  // 1. parts[2].length já bounded por preflightAuth (50..500 base58 chars)
  // 2. messageBytes ≤ 375 bytes após bs58.decode (limite operacional, log + reject se > 1KB)
  let messageBytes;
  try {
    messageBytes = bs58.decode(parts[2]);  // bounded pela validação anterior
    if (messageBytes.length > 1024) return { ok: false, reason: "message_too_large" };
  } catch { return { ok: false, reason: "bad_base58" }; }

  // 3. JSON.parse com try/catch — falha → reject sem custo
  let payload;
  try {
    payload = JSON.parse(Buffer.from(messageBytes).toString("utf8"));
  } catch { return { ok: false, reason: "bad_json" }; }

  // 4. EXTRAIR APENAS payload.nonce. Demais campos NUNCA usados antes do verify.
  //    pubkey/amount/destination ainda não autenticados — não confiar.
  if (typeof payload?.nonce !== "string") return { ok: false, reason: "no_nonce" };
  if (!/^[a-f0-9]{32}$/.test(payload.nonce)) return { ok: false, reason: "bad_nonce_format" };

  const nonceData = await store.getNonce(payload.nonce);
  if (!nonceData) return { ok: false, reason: "nonce_unknown" };

  return { ok: true, nonce: payload.nonce, nonceData, messageBytes, payload };
}
```

**Garantias:**
- `messageBytes` ≤ 1KB sempre (defesa em profundidade ao 50–500 char check anterior).
- Apenas `payload.nonce` é lido antes do verify. `pubkey`, `amount`, `destination` ficam para depois do `nacl.verify` autenticar a mensagem inteira.
- `getNonce` é cheap (Redis GET com TTL nativo, ~0.2ms).
- Se nonce não existir, 401 imediato sem custo de verify.

Custo aproximado do pre-check: 1 base58 decode bounded + 1 JSON.parse pequeno + 1 Redis GET. Significativamente abaixo do verify Ed25519, mas o número exato é medição (test bench), não SLO.

### 7.3 `/escrow/deposit` blindado

1. Rate-limit dedicado (5/min/IP).
2. Validação regex base58 (`SIG_RE`) **antes** de qualquer chamada externa.
3. **Idempotência por sig em vôo** (NEW): antes de chamar Solana, `SET NX` em `deposit:pending:{sig}` com TTL 15s (igual ao timeout do circuit breaker). Se chave já existe → 409 Conflict com `X-Deposit-Status: in_progress` e `Retry-After: <pttl>`. Garante que N requests concorrentes com mesma sig batem Solana **uma vez**, não N vezes. Limpa em `finally` independentemente de sucesso/falha.
4. Cache negativo de "not found" / sig inválida por 60s em `deposit:negative:{sig}` (mesma sig não bate Solana de novo). Aplicável após o resultado da chamada Solana.
5. Body limit `express.json({ limit: '1kb' })`.
6. Circuit breaker `opossum` em `getParsedTransaction` — abre após 5 falhas em 30s. Estado exposto em `/metrics`.

Pseudo-código:
```js
app.post('/escrow/deposit', rl.deposit, json({limit:'1kb'}), async (req, res) => {
  const { tx_signature: sig } = req.body || {};
  if (!SIG_RE.test(sig)) return res.status(400).json({ error: "invalid_signature_format" });

  // Cache negativo
  if (await store.isDepositKnownBad(sig)) {
    return res.status(400).json({ error: "deposit_signature_known_invalid", code: 400, reason: "cached_negative" });
  }

  // Idempotência em vôo
  const claimed = await store.claimPendingDeposit(sig, req.id, 15_000);
  if (!claimed) {
    const remaining = await store.pendingDepositPttl(sig);
    res.set('Retry-After', String(Math.ceil(remaining / 1000)));
    return res.status(409).json({ error: "deposit_in_progress", code: 409, sig });
  }

  try {
    const result = await solanaCircuit.fire(sig);    // verifica + credita
    if (!result.ok) await store.markDepositKnownBad(sig, 60_000);
    return res.status(result.ok ? 200 : 400).json(result);
  } finally {
    await store.clearPendingDeposit(sig);
  }
});
```

### 7.4 `/reputation/:pubkey`

1. Rate-limit dedicado (30/min/IP).
2. Validação regex pubkey antes de Redis read.
3. Cache 30s em `cache:rep:{pubkey}`.
4. Etag para clientes que suportam.

### 7.5 `/stats/*`

1. Cache 5s.
2. `getTotalPaidVolume` vira O(1) — adicionar counter `payments_micro_lamports_total` em `K.counters`, incrementado em `recordPayment`.

### 7.6 `/rpc` — body limit sem consumir o stream

**Restrição estabelecida (D-003 do ENGINEERING.md):** `express.json()` e `express.raw()` consomem o body, o que quebra `http-proxy-middleware` (que precisa do stream intacto pra encaminhar à Solana). A versão anterior do spec recomendou `express.raw` por engano.

**Solução correta:** Content-Length middleware *antes* do proxy. Não toca o stream:

```js
function rpcBodyLimit(maxBytes) {
  return (req, res, next) => {
    const len = req.headers['content-length'];
    if (!len) {
      // Solana JSON-RPC sempre envia Content-Length. Ausente = suspeito.
      return res.status(411).json({ error: "length_required", code: 411 });
    }
    const n = parseInt(len, 10);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: "invalid_content_length", code: 400 });
    }
    if (n > maxBytes) {
      return res.status(413).json({ error: "body_too_large", code: 413, limit: maxBytes });
    }
    next();
  };
}

app.use('/rpc', rpcBodyLimit(32 * 1024), x402Shield, qosMiddleware, proxy);
```

Defesas adicionais em `/rpc`:
1. Method allowlist (POST + OPTIONS apenas; GET/PUT/DELETE → 405 sem custo).
2. Validação `Content-Type: application/json` (rejeita não-JSON sem ler body — só lê o header).
3. Traefik já reforça body máximo 64KB (Seção 5) — esta camada é defense-in-depth (32KB no Shield, mais agressivo).

**Garantia preservada:** o stream do body **nunca é consumido** pelo Express; chega intacto ao `http-proxy-middleware`, que faz pipe direto para o upstream Solana.

## 8. Camada 2 — Enforcement ladder (5 tiers)

Princípio: progressão determinística. Agente bom previu o comportamento; falso-positivo no permanent é "praticamente impossível por construção".

### 8.1 Tabela de tiers

| Tier | Trigger | Ação | TTL | Registro durável | Reversibilidade |
|---|---|---|---|---|---|
| 0 — Warning | Uso ≥ 80% do bucket | Header `X-x402-Warning` + `X-x402-Limit-Remaining` | — | nenhum | n/a |
| 1 — Throttle | Bucket cheio | 429 + `Retry-After` | janela do bucket | nenhum | reset auto |
| 2 — Soft ban | 3 throttles consec. em 5min, **OU** 10 sigs inválidas em 60s | 429 em todas as requests | 5 min | `abuse:history:{key}` (24h) | reset auto |
| 3 — Hard ban | 3 soft bans em 24h, **OU** detection signal + 1 throttle | 403 em todas as requests | 1 hora | `abuse:hard-history:{key}` (7d) | reset auto |
| 4 — Permanent ⚠️ | (a) ação assinada do operador-agente em `/admin/ban` (sempre disponível), **OU** (b) auto-trigger via 3 hard bans em 7d **— EXPERIMENTAL, OFF por default em mainnet** | 403 indefinido, set `abuse:permanent` | indef | só `/admin/unban` |

**Regra normativa do Tier 4 automático:**

- Default `ENFORCEMENT_TIER_MAX=3` em mainnet — auto-trigger do Tier 4 **inativo**. Permanent ban só por ação manual via `/admin/ban`.
- Subir `ENFORCEMENT_TIER_MAX=4` em mainnet **MUST** satisfazer simultaneamente:
  1. ≥ 30 dias com Tier 3 estável (zero falso-positivo registrado em soft/hard bans em pubkey com score ≥ 50);
  2. Auditoria manual da abuse log dos últimos 30 dias com revisão por 2 operadores;
  3. Mudança aplicada via `POST /admin/config` com motivo assinado e gravado em audit log;
  4. Smoke `test/permanent-ban-promotion.test.js` passando contra ambiente espelho.
- Em devnet: `ENFORCEMENT_TIER_MAX=4` permitido com `NEW_PUBKEY_WHITELIST_DAYS=0` para testar caminho completo da escada antes do mainnet.

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

#### CORS lockdown

`/admin/*` **never** retorna `Access-Control-Allow-Origin: *`. Comportamento:
- Se request não tem header `Origin` → trata como server-to-server, processa normalmente.
- Se tem `Origin` e está em `ADMIN_ORIGIN_ALLOWLIST` (default: `https://api.rpcpriority.com`, `https://ops.rpcpriority.com`) → ecoa o origin com `Access-Control-Allow-Credentials: true`.
- Se tem `Origin` e não está na allowlist → 403 (sem ACAO header). Browser não consegue ler resposta, blocked by CORS.
- Preflight `OPTIONS` em `/admin/*` exige Origin na allowlist.

#### Auth: API key bearer assinada com canonicalização explícita

Cada request `/admin/*` deve carregar 3 headers:

| Header | Conteúdo |
|---|---|
| `X-Admin-Key-Id` | Identificador da chave (não-secreto). Permite múltiplas chaves ativas e rotação por keyId. Ex.: `ops-2026-05`. |
| `X-Admin-Timestamp` | Epoch seconds. Server rejeita se `\|now - ts\| > 60` (anti-replay). |
| `X-Admin-Auth` | `HMAC-SHA256(secret, canonical_string)` em hex. |

**`canonical_string`** (formato fixo, exatamente este, separador `\n`):
```
{method_upper}
{path}
{query_string_sorted_by_key}
{x-admin-timestamp}
{x-admin-key-id}
{sha256_hex(body_bytes)}
```

- `method_upper` = `GET`, `POST`, etc.
- `path` = pathname sem query (ex.: `/admin/ban`).
- `query_string_sorted_by_key` = chaves ordenadas alfabeticamente, valores URI-encoded; vazio se não há query.
- `body_bytes` = bytes brutos do request body (sem reformatar JSON). Pra GET/DELETE com body vazio: `sha256_hex("")` = `e3b0c44...` (constante).
- Server e cliente **MUST** computar `sha256` dos bytes brutos, não do JSON parseado — evita ambiguidade entre cliente e servidor (espaços, ordem de chaves).

Server lookup: `secret = ADMIN_KEYS[key_id]`. Map `ADMIN_KEYS` é populado por env `ADMIN_KEYS_JSON` (JSON `{"ops-2026-05": "secret_hex_...", "ops-2026-04": "..."}`). Sem env definido → `/admin/*` monta como 503 desde o boot.

#### Endpoints

| Endpoint | Função | Rate-limit |
|---|---|---|
| `GET /admin/abuse-log?limit=N&since=ts&type=ip\|pubkey` | Stream paginado | 30/min/keyid |
| `POST /admin/ban` (`{key, type:ip\|pubkey, tier, reason, ttl_s?}`) | Tier-3/4 manual | 10/min/keyid |
| `POST /admin/unban` (`{key, type, reason}`) | Remove ban | 10/min/keyid |
| `GET /admin/config` | Lê thresholds atuais | 30/min/keyid |
| `POST /admin/config` | Hot-reload de thresholds | 5/min/keyid |
| `GET /admin/agent/:pubkey` | Detalhe completo de identidade | 30/min/keyid |

#### Audit log

Toda ação em `/admin/*` grava em `audit:admin:log` (LIST append-only) **antes** de retornar:

```json
{
  "ts": 1731412847,
  "actor_key_id": "ops-2026-05",
  "method": "POST",
  "path": "/admin/ban",
  "body_sha256": "8a3b...",
  "target": { "type": "pubkey", "key": "Abc..." },
  "action_outcome": "ok",
  "tier": 4,
  "reason": "explicit operator action: tx hash 0xdeadbeef",
  "request_id": "x1y2z3a4"
}
```

`body_sha256` permite forensia post-incidente: dado o log e o secret da época, dá pra recomputar a HMAC e provar que a request foi assinada por aquela `key_id`.

Audit log retenção: 90 dias (LTRIM por idade no Redis ou export periódico, conforme configurado).

#### Mass-ban guardrail

Se `POST /admin/ban` for chamado mais de 10 vezes em 60s pela mesma `key_id`, **ou** mais de 50 vezes em 60min globalmente, o servidor **soft-fails** com 429 + alerta especial em `audit:admin:log` (`action_outcome: "throttled_mass_ban"`). Bug em script operacional não consegue banir 1000 pubkeys de uma vez sem revisão.

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
| `/rpc` | 32KB | **Content-Length middleware (não-consumidor)**, ver Seção 7.6 |
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

- **CI**: `npm audit --production --audit-level=high` falha o build em vulnerabilidade alta/crítica. **NÃO** rodar `npm audit fix` automático — pode mexer lockfile e quebrar pinning crítico (`@solana/web3.js@1.91.0`, ver D-005). Patches manuais como tasks rastreáveis.
- Pin **exato** em deps críticas (`@solana/web3.js`, `express`, `http-proxy-middleware`, `ioredis`, `tweetnacl`, `bs58`).
- `npm ci` em build, **não** `npm install` (respeita lockfile estritamente).
- Adicionar `pino`, `helmet`, `prom-client`, `opossum` ao `package.json` com versões exatas.
- Renovate/Dependabot configurado para PRs de upgrade — revisão humana antes de merge.

### 10.8 Secrets e boot guards

- Redis com `requirepass` (mesmo em rede interna): `redis://:senha@x402-redis-mainnet:6379`. Senha gerada por `openssl rand -hex 32`, em `.env` gitignored.
- **Boot guard estrito**: `ESCROW_TRUST_DEPOSITS=1` + (`NETWORK=mainnet` OU `REAL_RPC_URL` apontando pra mainnet-beta) → `process.exit(1)` no boot com erro claro. Smoke test (`test/boot-guards.test.js`) valida.
- **Boot guard de Redis**: se `REDIS_URL` definido mas connect falha após 30s de retry, processo decide pelo flag `REDIS_REQUIRED` (default `true` em mainnet, `false` em devnet). `true` → exit 1; `false` → boot em modo memory-only com warning loud + métrica `x402_store_backend{type="memory_fallback"}`.
- **Boot guard de admin**: `/admin/*` só monta se `ADMIN_KEYS_JSON` env tiver pelo menos 1 entry válida. Sem isso, qualquer request `/admin/*` retorna 503 com `X-Admin-Status: not_configured`.
- Documentar rotação de chave wallet em `docs/AGENT-OPERATOR-RUNBOOK.md`.
- Documentar rotação de `ADMIN_KEYS_JSON` (default 90 dias por `key_id`; chaves novas e velhas convivem por janela de 7 dias antes de remover a velha).

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

## 11. Resiliência: Solana e Redis fail-modes

### 11.1 Solana RPC outbound — circuit breaker

Lib: `opossum`. Wrappa `getParsedTransaction`:

```js
const solanaCircuit = new CircuitBreaker(
  (sig) => getSolanaConnection().getParsedTransaction(sig, {...}),
  { errorThresholdPercentage: 50, resetTimeout: 30_000, timeout: 15_000 }
);
```

Estado exposto em `/metrics` (`x402_solana_circuit_state`). Circuit aberto → `/escrow/deposit` retorna 503 com `Retry-After: 30`.

### 11.2 Redis fail-mode (fail-closed onde dói; degraded onde dá)

**Regra geral:** sem fallback in-memory automático para state crítico financeiro. Memória local não vê deposits, sigs usadas, escrow ou bans persistidos — fallback automático seria abertura de janela pra double-spend, replay de deposit ou ban "esquecido".

**Política por categoria de operação:**

| Categoria | Operações | Comportamento com Redis down | Resposta HTTP |
|---|---|---|---|
| **Money-critical (fail-closed)** | escrow read/write, nonce consume, deposit signature add/check, audit log write | **503** imediato. Não tenta fallback. | `503 Service Unavailable` + `Retry-After: 5` + `X-x402-Degraded: redis-down` |
| **Enforcement-critical (fail-closed)** | tier 2/3/4 ban check/write, abuse log write | **503** | mesmo |
| **`/rpc` sob gate** (fail-closed quando precisa decidir cobrança) | quando o load atual exigir 402, ou request traz `Authorization` que precisa validar nonce/escrow, ou paid lane | **503** — sem Redis, o Shield não pode saber com segurança se deve cobrar, validar pagamento ou aplicar bucket pago. Política conservadora: não encaminhar como tráfego privilegiado. | `503` + `X-x402-Degraded: redis-down` |
| **`/rpc` fora do gate** (tráfego abaixo do limiar, sem Authorization) | quando load < `RPC_LOAD_THRESHOLD` e request **não** trouxe `Authorization`, ou seja, é tráfego que hoje passaria sem 402 mesmo com Redis OK | Continua proxiando para Solana usando rate-limit local de fallback (degraded). Não há decisão de cobrança a tomar. | `200` (mais o que o upstream retornar) + `X-x402-Degraded: ratelimit-local` |
| **Read-only degraded** | `/reputation/*`, `/stats/*`, `/info`, leaderboard | 200 com payload mínimo (`degraded=1`) ou cache stale do último valor disponível | `200` + `X-x402-Degraded: 1` no header |
| **Rate-limit (fallback local explícito)** | rate-limit por IP/pubkey/global | Cai para `Map` local in-memory **só pra esse processo**, com TTL eviction. Ban tiers acima de 1 ainda fail-closed. | `200` ou `429` normais + `X-x402-Ratelimit-Degraded: local` quando aplicável |
| **Health probes** | `/health` | Retorna `200` com `redis: down` + `degraded: true`. Traefik continua roteando (degradação seletiva). | `200` mas com `degraded` no body |

**Detecção de Redis down:** ioredis `error` event seta flag `store.healthy = false`; Lua/comandos timeout em 2s lançam erro tratado em cada handler. Re-conexão restaura `healthy = true` automaticamente. Métricas `x402_store_healthy` (gauge 0/1) e `x402_store_errors_total{op}` (counter).

**Trade-off explícito:** durante Redis outage, agentes pagantes não conseguem pagar (escrow read falha), mas tráfego que não envolve escrow continua passando se a route for read-only. **Bom**: nenhum risco financeiro. **Ruim**: receita zerada durante outage. Mitigação: monitoramento de uptime do Redis com alerta agressivo (>30s outage = page); deploy de Redis em modo persistido com volume durável (`appendonly yes` já configurado).

**Fallback de rate-limit local — por que esse é OK fail-open?** Rate-limit é proteção *do nó*, não autoridade financeira. Em outage do Redis, mesmo perdendo precisão (cada Shield-instance vê só seu próprio Map), bloquear flagrante de IP único ainda funciona. O risco: agente que estava em soft/hard ban no Redis pode escapar até reconnect. Aceitável durante outage curto (< minutos). Tier 4 permanent **NUNCA** cai pra Map local — fica fail-closed.

**Boot sob Redis indisponível:** ver Seção 10.8 ("Boot guard de Redis"). Em mainnet `REDIS_REQUIRED=true` (default) → exit 1. Em devnet `REDIS_REQUIRED=false` permite boot em modo memory-only com warning.

### 11.3 Métrica `blocked_at` por estágio (granularidade de defesa)

Distinguir onde cada bloqueio aconteceu pra otimizar/calibrar:

```
x402_requests_total{route, stage, outcome}
  stage   = edge|shield_ratelimit|shield_auth|shield_deposit_validation|shield_qos|forwarded
  outcome = blocked|throttled|served|forwarded_solana|deposit_called_solana
```

Permite responder perguntas:
- Quantas requests foram bloqueadas no Traefik vs Shield? → `stage=edge` vs `stage=shield_*`
- Quantas chegaram a tocar Solana RPC outbound (deposit)? → `outcome=deposit_called_solana`
- Quantas foram cheap-rejected antes de Ed25519? → `stage=shield_auth, outcome=blocked`
- Qual é o "funil" de defesa? → série temporal de cada `stage`

## 12. Feature flags (env vars)

| Flag | Default | Descrição |
|---|---|---|
| `RATELIMIT_ENABLED` | `true` | Liga rate-limit Redis 3-dim |
| `BADSIG_CIRCUIT_ENABLED` | `false` no código | Liga ban tier-2 por sigs inválidas. Procedimento de deploy: ligar em devnet imediatamente; em mainnet só após 7 dias de observação dos logs. |
| `ENFORCEMENT_TIER_MAX` | `3` em mainnet, `4` em devnet | Limite máx auto-tier (`3` = nunca permanent automático). Subir pra `4` em mainnet exige condições normativas (Seção 8.1). |
| `TRUST_MULTIPLIERS_ENABLED` | `true` | Liga multiplicadores e paid lane |
| `NEW_PUBKEY_WHITELIST_DAYS` | `30` em mainnet, `0` em devnet | Janela "agente novo nunca permanente" |
| `ADMIN_KEYS_JSON` | (vazio) | Map JSON `{key_id: secret_hex}`. Vazio = `/admin/*` retorna 503 desde o boot |
| `ADMIN_ORIGIN_ALLOWLIST` | `https://api.rpcpriority.com,https://ops.rpcpriority.com` | CSV de origins permitidos em `/admin/*` (browsers). Server-to-server (sem Origin) sempre OK. |
| `METRICS_ENABLED` | `true` | Expõe `/metrics` |
| `LOG_LEVEL` | `info` | `debug` em devnet inicial |
| `LOG_SAMPLE_AFTER` | `100` | Sample após N eventos do mesmo `reason` |
| `BODY_LIMIT_RPC_BYTES` | `32768` | Body máx em /rpc (Content-Length check) |
| `RATE_IP_LIMIT` | `100` | reqs/min por IP em `/rpc` |
| `RATE_PUBKEY_LIMIT` | `200` | reqs/min por pubkey em `/rpc` (sem paid lane) |
| `RATE_PAID_PUBKEY_BASE` | `200` | base do bucket paid lane; multiplicado por Trust-Score |
| `RATE_GLOBAL_LIMIT` | `5000` | reqs/min globais em `/rpc` |
| `SOFT_BAN_DURATION_MS` | `300000` | 5 min |
| `HARD_BAN_DURATION_MS` | `3600000` | 1 h |
| `DEPOSIT_PENDING_TTL_MS` | `15000` | TTL do lock `deposit:pending:{sig}` (Seção 7.3) |
| `DEPOSIT_NEGATIVE_CACHE_TTL_MS` | `60000` | TTL do `deposit:negative:{sig}` (cache de sigs inválidas) |
| `SOLANA_CIRCUIT_THRESHOLD_PCT` | `50` | % falhas que abre circuit Solana |
| `SOLANA_CIRCUIT_TIMEOUT_MS` | `15000` | timeout chamada Solana |
| `REDIS_REQUIRED` | `true` em mainnet, `false` em devnet | Boot guard: `true` faz processo exitar 1 se Redis indisponível após 30s. `false` permite boot memory-only com warning. |
| `STORE_OP_TIMEOUT_MS` | `2000` | Timeout por operação Redis (lança erro tratável). |
| `MASS_BAN_GUARD_PER_KEY_PER_MIN` | `10` | Limite de `POST /admin/ban` por key_id por minuto. |
| `MASS_BAN_GUARD_GLOBAL_PER_HOUR` | `50` | Limite global de bans manuais por hora. |

## 13. Plano de rollout (4 fases)

### Pré-condição obrigatória — RPC_LOAD_FORCE em mainnet

Hoje `docker-compose.mainnet.yml:47` define `RPC_LOAD_FORCE: ${RPC_LOAD_FORCE_MAINNET:-0.9}`. Isso força carga sintética de 90% — **toda** request em mainnet recebe 402 hoje (era para demo / pitch). Antes de iniciar a Fase 3 do rollout (em mainnet), remover esse default:
- Opção A: deletar a env var dos compose mainnet (load passa a ser medido).
- Opção B: setar `RPC_LOAD_FORCE_MAINNET=` (vazio) no `.env` do operador.
- Validar: `/health` retorna `load_forced: false`; `/info` mostra threshold real.

Sem essa pré-condição, o teste de paid lane e do ladder fica viesado pelo gate sempre ativo.

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
2. `/admin/*` por último; deploy só após `ADMIN_KEYS_JSON` (map `{key_id: secret_hex}`) configurado e procedimento de rotação documentado.
3. Audit log de admin testado (gravando event de cada chamada antes de retornar).
4. Documentar `docs/AGENT-OPERATOR-RUNBOOK.md`.

## 14. Smoke tests novos

| Arquivo | Cobre |
|---|---|
| `test/ratelimit-3dim.test.js` | Os 3 buckets (IP, pubkey, global) bloqueando independentemente |
| `test/paid-lane.test.js` | Pagamento aprovado **não** bypassa IP/pubkey/global; ativa bucket paid com multiplicador correto |
| `test/enforcement-ladder.test.js` | Tier 0→3 com cenários determinísticos |
| `test/permanent-ban-promotion.test.js` | Auto-tier-4 só dispara com `ENFORCEMENT_TIER_MAX=4`; com `=3` (default mainnet) jamais promove |
| `test/trust-multiplier.test.js` | Pubkey score 80 não cai em tier-2 com 3 throttles; multiplicador 5× aplicado |
| `test/agent-status.test.js` | `/agent/status` retorna histórico correto, cache 10s |
| `test/admin-hmac.test.js` | HMAC canônico (method/path/query_sorted/timestamp/key_id/sha256(body)); replay (>60s) rejeita; key_id desconhecido rejeita; body adulterado rejeita |
| `test/admin-ban.test.js` | `/admin/ban` com auth válida banca; auth inválida 401; audit log entry com `body_sha256` |
| `test/admin-mass-ban-guard.test.js` | 11º `POST /admin/ban` em 60s pela mesma key_id retorna 429; alerta gravado em audit log |
| `test/feedback-headers.test.js` | Toda 429/403 carrega `X-x402-Tier/Reason/Until/Trust-Impact` com vocabulário fechado |
| `test/circuit-breaker-solana.test.js` | `/escrow/deposit` abre circuit após 5 falhas |
| `test/deposit-idempotency.test.js` | N requests concorrentes com mesma sig batem Solana **uma vez**; N-1 recebem 409 com Retry-After |
| `test/deposit-negative-cache.test.js` | Sig conhecida-inválida retorna 400 sem tocar Solana (TTL 60s) |
| `test/cheap-reject.test.js` | Lixo no Authorization: `nacl.sign.detached.verify` **MUST NOT** ser chamado (spy); `bs58.decode` também não |
| `test/nonce-precheck-bounded.test.js` | messageBytes >1KB rejeitado; JSON malformado rejeitado; pubkey/amount/destination não lidos antes do verify |
| `test/rpc-content-length.test.js` | request sem `Content-Length` em /rpc retorna 411; >32KB retorna 413; ≤32KB passa sem o body ser consumido (proxy ainda funciona) |
| `test/redis-down.test.js` | Redis abate em runtime → /escrow/deposit 503; /reputation degraded=1; /rpc com Authorization 503; /rpc sem Authorization e load baixo continua proxiando; /health body inclui `redis: down`; métrica `x402_ratelimit_degraded_total` incrementa |
| `test/boot-guards.test.js` | `ESCROW_TRUST_DEPOSITS=1` + mainnet aborta boot; `REDIS_REQUIRED=true` + Redis indisponível aborta após 30s; `ADMIN_KEYS_JSON` vazio mantém /admin/* 503 |
| `test/graceful-shutdown.test.js` | SIGTERM drena fila QoS antes de fechar Redis; novas conns 503; in-flight terminam |

## 15. Métricas de sucesso ("pronto")

| Métrica | Threshold | Como medir |
|---|---|---|
| Falso-positivo soft-ban em pubkey score≥50 | < 0.1% da população | `x402_abuse_events_total{reason,trust_score_band}` filtrado por band 51–100 |
| Bloqueio de 50k req de 1 IP sem chegar em Solana | > 99% bloqueadas em `stage=edge` ou `stage=shield_ratelimit` | `x402_requests_total{outcome="blocked"}` / total |
| Bloqueio de botnet (50k IPs × 1 req) | > 90% bloqueadas em `stage=edge` (inflight) ou `shield_ratelimit` (global) | `x402_requests_total{stage,outcome}` |
| Taxa de `outcome=deposit_called_solana` durante flood de sigs falsas | < 1% (idempotency lock + cache negativo trabalham) | `x402_requests_total{outcome="deposit_called_solana"}` |
| p95 do `/rpc` em load normal | mesmo do bench atual (~150ms) | `npm run bench` |
| CPU do Shield em load 100 RPS | < 30% em 1 vCPU | docker stats + `/metrics` |
| Memória estável após 24h em flood | crescimento < 5% / hora | docker stats + `/metrics` |
| Falsos positivos em `/admin/abuse-log` | <1 / dia | revisão manual da log durante soak |
| `x402_store_healthy` durante soak | = 1 sustentado | gauge no `/metrics`; alertar se cair |

## 16. Riscos e mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Falso-positivo banindo agente legítimo | Baixa (Tier 4 auto OFF por default em mainnet; 3 hard bans em 7d com decay) | Alto | Multiplicadores Trust-Score (bypass tier 0 em score≥51); whitelist 30 dias; permanent ban auto OFF até condições normativas (Seção 8.1) atendidas |
| Evasão por rotação de identidade | Alta | Médio | Permanent ban também banca IP histórico; `coordinated_burst` detecta padrão; rate-limit global cobre o escape |
| Operador-agente abusivo (banca competidores) | Média | Alto | HMAC canônico assinado; permanent exige `reason`; mass-ban guard (10/min/keyid + 50/h global); broker cross-operator (futuro) cross-valida |
| Mass-ban acidental (bug em script) | Baixa | Catastrófico | Mass-ban guard (Seção 9.2); soft-fail com alerta em audit log; revisão obrigatória pra reativar |
| Vazamento de chave admin (`ADMIN_KEYS_JSON`) | Média | Catastrófico | Rotação por key_id (90d); HMAC com timestamp anti-replay 60s; convivência de chaves nova/velha por 7 dias; CORS lockdown nos `/admin/*`; IP allowlist via Traefik opcional |
| Container hardening quebra Solana SDK | Média | Médio | Testar em devnet primeiro; tmpfs adicional se necessário; flag pra desligar `read_only` |
| **Redis down — fail-closed em paths financeiros** (NEW) | Baixa-média | Alto operacional, mas baixo financeiro | Money-critical e enforcement-critical 503 imediato (Seção 11.2). Read-only routes degradam. /rpc fora do gate continua proxiando com rate-limit local. Receita zerada durante outage é trade-off aceito vs risco financeiro. Alerta agressivo em `x402_store_healthy=0`. |
| Idempotência ausente em /escrow/deposit | (mitigada) | Alto (flood de sigs falsas amplifica chamadas Solana) | Pending-lock `deposit:pending:{sig}` SET NX 15s + cache negativo 60s (Seção 7.3) |
| Cache stale em `/reputation` (30s) | Alta | Baixo (preço Trust-Score lag até 30s) | TTL curto; trade-off aceito |
| `RPC_LOAD_FORCE=0.9` permanecer em mainnet pós-rollout | Alta se esquecido | Médio (todo tráfego desafiado mesmo sem carga real) | Pré-condição obrigatória Seção 13 (remover/setar vazio antes da Fase 3); smoke checa `/health` `load_forced=false` |

## 17. Out of scope (follow-ups explícitos)

- **Classificação de custo por método JSON-RPC** (v0.3) — `getProgramAccounts`, `getSignaturesForAddress` consomem peso maior do bucket que `getHealth`. Implementação requer parser do body em /rpc, tabela de pesos por método, integração com bucket /rpc atual. Depende de Seção 7.6 (Content-Length sem consumir stream) estar sólido. Seção dedicada quando puxado pra design.
- **Proof-of-Work tier free** (v0.3+) — quebra contrato SDK.
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
