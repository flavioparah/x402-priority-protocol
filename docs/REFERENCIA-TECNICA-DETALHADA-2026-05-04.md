---
title: "Referência técnica detalhada — x402-shield"
author: "RPC Priority Protocol"
date: "2026-05-04"
subject: "Arquitetura, padrões de implantação, settlement, sizing e modelo operacional"
---

# Referência técnica detalhada — x402-shield

**Data:** 2026-05-04
**Audiência:** equipe técnica do projeto, engenheiros de operadores RPC integrando o shield, contribuidores externos do RFC.
**Escopo:** arquitetura consolidada, padrões de implantação, arquiteturas de settlement e split de receita, sizing, observabilidade, modelo de ameaças e tier técnico.
**Status:** documento vivo — atualizar conforme decisões de implementação evoluem.

---

## Como usar este documento

Este documento **não substitui** a especificação formal do protocolo nem o journal de engenharia — ele consolida e aprofunda decisões de implementação, padrões de operação e arquiteturas de settlement que não cabem na RFC.

| Onde | Conteúdo | Quando consultar |
|---|---|---|
| [`rfc/x402-priority.md`](rfc/x402-priority.md) | Especificação wire-protocol formal v1.0 | Ao integrar SDK, headers, signing, atomic consume |
| [`rfc/x402-qos-cooperative.md`](rfc/x402-qos-cooperative.md) | Cooperação shield ↔ operador via headers QoS | Ao implementar operador-side scheduling |
| [`ENGINEERING.md`](ENGINEERING.md) | Journal cronológico de decisões e benchmarks | Para entender por que algo está como está |
| [`JORNADA-NODE-OPERADOR.md`](JORNADA-NODE-OPERADOR.md) | Onboarding operador (perspectiva produto) | Em conversas comerciais |
| [`DEPLOY.md`](DEPLOY.md) / [`DEPLOY-VPS-ADAPTADO.md`](DEPLOY-VPS-ADAPTADO.md) | Runbook de deploy | Ao subir ambiente |
| **Este documento** | Padrões transversais, settlement, sizing, tiers | Ao decidir arquitetura de uma nova integração |
| [`GLOSSARIO.md`](GLOSSARIO.md) | Termos técnicos | Ao encontrar jargão |

---

## 1. Visão geral arquitetural

### 1.1 Posicionamento na stack Solana

| Camada | Pergunta principal | Componentes típicos | x402-shield |
|---|---|---|---|
| Aplicação | O agente quer fazer o quê? | Wallets, dApps, bots, agentes IA | Indireto (via SDK) |
| **RPC acesso** | Quem consegue consultar/enviar pelo nó agora? | JSON-RPC, leituras, simulações, `sendTransaction` | **Foco principal** |
| **RPC QoS** | Quem recebe prioridade sob carga? | Filas, rate limits, backpressure | **Foco principal** |
| Transação | Qual tx tem melhor chance de landing? | Priority fee, Jito tip, fast send | Complementar |
| MEV/blockspace | Qual bundle ganha o leilão? | Jito Block Engine, bundles | Fora do escopo |
| Validador | Quem produz/processa bloco? | Jito-Solana, Agave, Firedancer | Fora do escopo |

A camada **RPC acesso** é a que sofre saturação quando agentes autônomos disparam milhares de leituras (`getAccountInfo`, `getProgramAccounts`, `getMultipleAccounts`) antes de enviarem qualquer transação. Essas leituras consomem CPU, banda, cache e conexões do nó RPC mas não pagam fee on-chain — o operador arca com o custo sem capturar valor. O shield monetiza exatamente essa camada.

### 1.2 Princípios de design

1. **Pagamento ≠ Autenticação.** Identidade é a pubkey Ed25519 do agente. Não há API key, não há contrato, não há whitelist.
2. **Sob baixa carga, passa grátis.** O shield só ativa cobrança quando a carga ultrapassa o threshold configurado. Não é taxa universal.
3. **Cobrança por requisição, não por valor.** O shield não enxerga semântica da chamada RPC — não pode cobrar % de valor de transação. Cobra por *acesso* à capacidade do nó.
4. **Stateless do ponto de vista do cliente.** Cliente assina challenge, refaz request — sem sessão, sem cookie.
5. **Fail loudly.** Decisão D-007: caminhos não-suportados devem falhar com mensagem clara, não silenciosamente.
6. **Open standard.** SDK e spec são abertos; defesa não vem de código fechado, vem de adoção e dataset cross-operador.

### 1.3 Componentes principais

```
┌──────────────────────────────────────────────────────────────────┐
│                          x402-shield                             │
│                                                                  │
│  ┌────────────┐    ┌────────────┐    ┌────────────────────────┐  │
│  │  Detector  │───▶│   Pricer   │───▶│  Challenge Issuer      │  │
│  │ (load+IP)  │    │ (curve+TS) │    │  (nonce + headers)     │  │
│  └────────────┘    └────────────┘    └────────────────────────┘  │
│         │                                       │                │
│         ▼                                       ▼                │
│  ┌────────────┐    ┌────────────┐    ┌────────────────────────┐  │
│  │  Verifier  │───▶│   Store    │───▶│  Forwarder (proxy)     │  │
│  │ (Ed25519)  │    │ (Redis Lua)│    │  (keep-alive upstream) │  │
│  └────────────┘    └────────────┘    └────────────────────────┘  │
│         │                                       │                │
│         ▼                                       ▼                │
│  ┌────────────┐    ┌────────────┐    ┌────────────────────────┐  │
│  │ Trust-Score│    │   Escrow   │    │  Telemetry             │  │
│  │  backend   │    │  ledger    │    │  (load, p95, balance)  │  │
│  └────────────┘    └────────────┘    └────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

| Componente | Arquivo de referência | Função |
|---|---|---|
| Detector | [`lib/detection.js`](../lib/detection.js) | Mede carga (sliding window RPS) + rate limit per-IP |
| Pricer | [`index.js`](../index.js) `calcDynamicPrice`, `applyTrustDiscount` | Calcula preço final em µ-lamports |
| Challenge Issuer | [`index.js`](../index.js) `issueNonce` | Gera nonce, monta headers 402 |
| Verifier | [`index.js`](../index.js) `verifyX402Authorization` | Valida assinatura Ed25519 + payload |
| Store | [`lib/store.js`](../lib/store.js) `consumeNonceAndDebit` | Atomic consume via Lua (Redis) ou map (memória) |
| Forwarder | `http-proxy-middleware` + `https.Agent` keep-alive | Proxy para upstream RPC |
| Trust-Score backend | [`index.js`](../index.js) `recordPayment`, `getTrustScore` | Reputação por pubkey |
| Escrow ledger | `lib/store.js` | Saldo pre-funded por pubkey, atomic debit |
| Telemetry | `/health`, `/stats/*` | Métricas operacionais |

---

## 2. Fluxo end-to-end completo

### 2.1 Sequência canônica (caminho feliz)

```
  Agent                       Shield                       Upstream RPC
    │                           │                                │
    │  1. POST /rpc {body}      │                                │
    ├──────────────────────────▶│                                │
    │  X-x402-Agent-Pubkey: X   │                                │
    │                           │  2. detect load > threshold    │
    │                           │  3. lookup TS(X)               │
    │                           │  4. price = pricer(load, TS)   │
    │                           │  5. nonce = issueNonce(X)      │
    │  6. 402 Payment Required  │                                │
    │◀──────────────────────────│                                │
    │  X-x402-Nonce + amount    │                                │
    │                           │                                │
    │  7. sign(nonce|pk|amt|dst)│                                │
    │  8. POST /rpc {body}      │                                │
    │     Authorization: x402   │                                │
    ├──────────────────────────▶│                                │
    │                           │  9. verify Ed25519             │
    │                           │ 10. consumeNonceAndDebit(Lua)  │
    │                           │ 11. recordPayment(pk)          │
    │                           │ 12. proxy to upstream          │
    │                           ├───────────────────────────────▶│
    │                           │                                │
    │                           │ 13. upstream response          │
    │                           │◀───────────────────────────────│
    │ 14. 200 OK {result}       │                                │
    │◀──────────────────────────│                                │
```

### 2.2 Timing observado (mainnet, devnet upstream, N=100)

| Passo | p50 | p95 | Observação |
|---|---|---|---|
| 402 RTT (1→6) | 1,5 ms | 1,8 ms | Local — Shield decide e responde |
| Sign Ed25519 (7) | 4,5 ms | 6,7 ms | CPU agente |
| Verify + consume (9–11) | < 2 ms | < 4 ms | Atômico via Lua |
| Proxy upstream (12–13) | 145 ms | 150 ms | Dominante — depende da rede ao upstream |
| **x402 protocol overhead** | **6,1 ms** | **8,3 ms** | **PASS contra KPI < 50 ms** |
| Total handshake | 151 ms | 155 ms | Após D-008 (keep-alive) |

A sobrecarga do x402 sobre o RPC direto é **pequena (~6 ms p50)**. O custo dominante do total é o proxy ao upstream — irredutível para qualquer arquitetura proxy.

### 2.3 Fluxo de pré-funding (escrow)

```
  Agent                       Solana                        Shield
    │                           │                              │
    │  1. transfer(lamports)    │                              │
    ├──────────────────────────▶│                              │
    │  2. tx_signature          │                              │
    │◀──────────────────────────│                              │
    │                                                          │
    │  3. POST /escrow/deposit { tx_signature }                │
    ├─────────────────────────────────────────────────────────▶│
    │                           │  4. getParsedTransaction     │
    │                           │◀─────────────────────────────│
    │                           │     verify destination       │
    │                           │     check anti-replay        │
    │                           │     credit µL = lamports*1000│
    │  5. { credited, balance }                                │
    │◀─────────────────────────────────────────────────────────│
```

Escrow é **off-chain** após o depósito on-chain inicial. Justificativa em D-001: settlement on-chain por requisição adiciona ~400 ms — incompatível com KPI < 50 ms.

---

## 3. Padrões de implantação

Três modos de operação para diferentes perfis de operador. Escolha técnica afeta sizing, latência e modelo comercial.

### 3.1 Modo **co-residente** (recomendado para operadores médios)

Shield roda na **mesma máquina/datacenter** que o nó Solana RPC. Comunicação via `localhost` ou rede privada — latência sub-milissegundo entre shield e RPC.

```
                              ┌──────────────── operator VPS / baremetal ─────┐
   Internet                   │                                               │
   ───────────▶ [Cloudflare] ─▶│ [shield :3000] ──localhost──▶ [solana RPC]   │
                              │                                               │
                              └───────────────────────────────────────────────┘
```

**Vantagens:**
- Menor latência total (proxy hop é trivial).
- Operador mantém controle total da infra.
- Falha do shield não derruba o RPC (failover possível).

**Desvantagens:**
- Operador precisa hospedar e manter o shield.
- Compute extra na mesma máquina (mitigado: shield é leve, ~50 MB RAM em idle).

**Sizing típico:** 1 KVM 4 (Hostinger) ao lado de cada nó RPC. Suporta ~500 req/s sem virar gargalo.

### 3.2 Modo **edge proxy** (recomendado para operadores grandes / multi-região)

Shield roda em **edge** (Cloudflare Workers, regional VPS, ou multi-região) e proxia para o upstream RPC (que pode estar em qualquer lugar).

```
   Internet                    Edge layer                    Origin
   ───────────▶ [Cloudflare] ─▶ [shield BR] ─▶ [helius mainnet RPC]
                                [shield EU] ─▶ [helius mainnet RPC]
                                [shield US] ─▶ [helius mainnet RPC]
```

**Vantagens:**
- Latência regional ao agente (challenge response sub-50 ms global).
- Operador upstream desacoplado — não precisa rodar o shield.
- Escala horizontal trivial.

**Desvantagens:**
- Hop extra adiciona ~30–80 ms por região distante.
- Estado (escrow, nonces) precisa ser compartilhado via Redis cluster.

**Sizing típico:** 1 KVM 2 (Hostinger) por região + 1 Redis dedicado (KVM 4). 3 regiões = R$ 162/mês promocional.

### 3.3 Modo **hosted/managed** (recomendado para operadores pequenos / nicho)

Você (RPC Priority Protocol) hospeda o shield para o operador. Operador apenas plugga o endpoint dele e configura `PAYMENT_DESTINATION`.

```
                    ┌─────── nosso ambiente ────────┐
                    │                               │
   Agente ──────────▶│ [shield managed] ─────┐      │
                    │   - configurado por    │      │
                    │     operador via UI    │      │
                    │   - traefik + multi-tenant   │
                    │                        ▼      │
                    │   ◀──── settlement ────       │
                    └────────────────────────│──────┘
                                             │
                                             ▼
                                    [operador upstream RPC]
```

**Vantagens:**
- Operador integra em minutos, não dias.
- Único ponto de manutenção/atualização do shield.
- Permite take-rate alto (justifica modelo hosted: 25–30%).

**Desvantagens:**
- Custódia de estado do operador (escrows, settlements) — implicações regulatórias.
- Operador depende da nossa infra — SLA importa.

**Sizing típico:** multi-tenant em 1 KVM 8 (Hostinger) suporta ~10 operadores pequenos. Escala horizontal por sharding.

### 3.4 Matriz de decisão

| Perfil de operador | Modo recomendado | Take-rate justo | Tier comercial |
|---|---|---|---|
| Helius/Triton/QuickNode | Co-residente ou edge | 3–5% | Enterprise SaaS |
| Operador médio multi-região | Edge proxy | 5% | Pro SaaS |
| Validador/operador BR pequeno | Co-residente | 10% | Starter SaaS |
| Operador novo sem infra | Hosted/managed | 25–30% | Hosted |

---

## 4. Arquiteturas de settlement e split de receita

Quando há split de receita entre operador e protocolo (ex: 95/5 ou 80/20), há quatro padrões técnicos para implementar a divisão. Escolha depende de fase do projeto, regulatório e perfil do operador.

### 4.1 Padrão A — Multi-destination payment (single tx) ⭐ recomendado growth

Agente paga em **uma única transação Solana** com 2 instruções de transferência:

```javascript
// Cliente monta tx atomicamente
const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: agent.publicKey,
    toPubkey:   new PublicKey(challenge.destinations[0].to), // operator
    lamports:   challenge.destinations[0].amount,            // 9500
  }),
  SystemProgram.transfer({
    fromPubkey: agent.publicKey,
    toPubkey:   new PublicKey(challenge.destinations[1].to), // protocol
    lamports:   challenge.destinations[1].amount,            // 500
  }),
);
```

**Challenge x402 carrega ambos os destinos:**

```http
HTTP/1.1 402 Payment Required
X-x402-Payment-Destinations: [
  {"to":"OperatorWallet...","amount":9500},
  {"to":"ProtocolWallet...","amount":500}
]
X-x402-Nonce: a1b2c3...
X-x402-Total: 10000
```

**Verificação no shield:**
```javascript
function verifyMultiDestinationTx(tx, expectedDestinations) {
  const transfers = tx.instructions.filter(ix => 
    ix.programId.equals(SystemProgram.programId)
  );
  for (const dest of expectedDestinations) {
    const match = transfers.find(t => 
      t.keys[1].pubkey.toBase58() === dest.to &&
      t.data.readBigUInt64LE(4) === BigInt(dest.amount)
    );
    if (!match) throw new Error(`missing transfer to ${dest.to}`);
  }
}
```

**Vantagens:** atômico, trustless, sem settlement off-chain, sem custódia de fundos do operador.
**Desvantagens:** schema do challenge expandido (extensão v1.1 do RFC); um pouco mais de CU consumida na tx (negligível).

### 4.2 Padrão B — Smart contract splitter (programa Solana)

Um programa Solana on-chain `x402-splitter` recebe pagamento atômico e distribui:

```rust
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[program]
pub mod x402_splitter {
    use super::*;

    pub fn pay_with_split(
        ctx: Context<PayWithSplit>,
        amount: u64,
        protocol_bps: u16,  // basis points: 500 = 5%
    ) -> Result<()> {
        require!(protocol_bps <= 5000, ErrorCode::SplitTooHigh); // max 50%
        let protocol_cut = (amount as u128 * protocol_bps as u128 / 10_000) as u64;
        let operator_cut = amount.checked_sub(protocol_cut).unwrap();

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.agent.to_account_info(),
                    to:   ctx.accounts.operator.to_account_info(),
                },
            ),
            operator_cut,
        )?;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.agent.to_account_info(),
                    to:   ctx.accounts.protocol_treasury.to_account_info(),
                },
            ),
            protocol_cut,
        )?;
        Ok(())
    }
}
```

**Vantagens:** auditável, regras codificadas, governança on-chain (DAO pode mudar `protocol_bps` via instrução `update_split`), composabilidade com outros programas Solana.

**Desvantagens:** custo de auditoria do programa (~$30–50k OtterSec/Zellic), CU adicional por tx (~5k CU), risco de bug em programa imutável.

**Quando usar:** fase Scale (ano 2+) quando volume justifica auditoria e operadores enterprise exigem regras imutáveis e auditáveis.

### 4.3 Padrão C — Escrow + settlement periódico

Agente faz pre-deposit em PDA escrow controlado pelo shield. Cada request debita escrow off-chain. Settlement periódico (diário/semanal) distribui:

```javascript
// Cron job de settlement (executar 02:00 UTC diariamente)
async function dailySettlement() {
  const operators = await db.getActiveOperators();
  for (const op of operators) {
    const totalReceived = await db.sumPaymentsToday(op.id);
    if (totalReceived === 0n) continue;

    const protocolCut = (totalReceived * 500n) / 10000n; // 5%
    const operatorCut = totalReceived - protocolCut;

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: ESCROW_AUTHORITY.publicKey,
        toPubkey:   new PublicKey(op.payout_address),
        lamports:   Number(operatorCut / 1000n), // µL → lamports
      }),
      SystemProgram.transfer({
        fromPubkey: ESCROW_AUTHORITY.publicKey,
        toPubkey:   PROTOCOL_TREASURY,
        lamports:   Number(protocolCut / 1000n),
      }),
    );
    await sendAndConfirmTransaction(connection, tx, [ESCROW_AUTHORITY]);
    await db.markSettled(op.id, totalReceived);
  }
}
```

**Vantagens:** custo per-request quase zero (sem fee de tx por requisição); suporta micropagamentos sub-cent rentavelmente; latência de pagamento zero (escrow off-chain).

**Desvantagens:** **custodial** — implica MSB licensing nos EUA, registro de PSP no Brasil, etc. Risco de incidente na chave de settlement. Gap entre payment e settlement (operador espera 24h).

**Quando usar:** apenas após avaliação regulatória. Modelo viável para SaaS-as-a-service mas não para operadores enterprise que querem fundos imediatos.

### 4.4 Padrão D — Pagamento direto + invoice mensal (recomendado MVP)

Agente paga 100% direto à wallet do operador. Shield contabiliza o volume processado e emite invoice mensal cobrando % do que processou.

```javascript
// Telemetria de billing
async function recordProcessedRequest(operatorId, paidAmount) {
  await db.incrementMonthlyVolume(operatorId, paidAmount);
}

// Mensalmente
async function generateInvoice(operatorId) {
  const monthlyVolume = await db.getMonthlyVolume(operatorId);
  const invoiceAmount = monthlyVolume * TAKE_RATE;
  const invoice = await invoiceProvider.create({
    operator: operatorId,
    line_items: [{
      description: `x402-shield take-rate (${(TAKE_RATE * 100).toFixed(1)}%)`,
      amount_usd: invoiceAmount,
    }],
    due_date: addDays(new Date(), 14),
  });
  await emailOperator(operatorId, invoice);
  return invoice;
}
```

**Vantagens:** zero fricção técnica para o operador (ele recebe 100% direto); zero custódia (não tocamos nos fundos); regulatório trivial.

**Desvantagens:** risco de inadimplência (operador pode não pagar invoice); enforcement só via contrato off-chain; precisa contabilidade tradicional.

**Quando usar:** **fase MVP (mês 1–6)**. Foca em adoção, não otimiza extração. Mitiga regulatório.

### 4.5 Recomendação por fase

| Fase | Padrão | Justificativa técnica |
|---|---|---|
| **MVP (mês 1–6)** | D — invoice mensal | Zero fricção, foco em adoção |
| **Growth (mês 6–18)** | A — multi-destination tx | Trustless sem audit de programa; extensão menor do RFC |
| **Scale (mês 18+)** | B — splitter on-chain | Governança + auditabilidade exigidas por enterprise |
| **Hosted/managed** | C — escrow + settlement | Único onde faz sentido por arquitetura (você já custodia) |

---

## 5. Sizing matriz e capacidade

### 5.1 Pressuposto de carga

Baseado em benchmarks (ENGINEERING.md, sessão 1):
- x402 protocol overhead: ~6 ms p50, ~9 ms p95.
- Shield CPU por requisição: ~0,5 ms (verify Ed25519 + Redis Lua).
- Memória por nonce ativo: ~200 bytes; TTL 30s.
- Memória por escrow account: ~150 bytes.

### 5.2 Capacidade por VPS Hostinger

| Plano | vCPU | RAM | Throughput sustentável | p95 esperado | Operadores suportados (managed) |
|---|---|---|---|---|---|
| KVM 1 (1 vCPU, 4 GB) | 1 | 4 GB | ~100 req/s | < 15 ms | 1 (staging) |
| KVM 2 (2 vCPU, 8 GB) | 2 | 8 GB | ~300 req/s | < 12 ms | 2–3 |
| **KVM 4 (4 vCPU, 16 GB)** | 4 | 16 GB | **~700 req/s** | **< 10 ms** | **4–6** |
| KVM 8 (8 vCPU, 32 GB) | 8 | 32 GB | ~1.500 req/s | < 8 ms | 8–12 |

**Notas:**
- Throughput considera shield + Redis local. Com Redis dedicado, multiplique por ~1,5×.
- p95 é sobrecarga x402 (não inclui upstream RPC).
- Com keep-alive ao upstream (D-008), upstream RPC vira gargalo antes do shield em throughputs altos.

### 5.3 Bottlenecks por componente

| Componente | Limite teórico | Limite prático | Mitigação |
|---|---|---|---|
| Verify Ed25519 (CPU) | ~50k ops/s/core | ~30k req/s/core | Usar `tweetnacl-js-pure` ou Rust nativo |
| Redis Lua atomic | ~30k ops/s | ~20k req/s | Redis cluster sharded por pubkey |
| Proxy upstream | Limited by upstream | ~500 req/s direto | Keep-alive pool + multi-upstream |
| Banda de rede | 1 Gbps Hostinger | ~80% util | Compress payloads grandes (`getProgramAccounts`) |
| Memória | 200 bytes × nonces ativos | 50 MB para 250k nonces | Redis EXPIRE garante GC automático |

### 5.4 Estimativa de carga × custos infra

| Cenário | Req/s sustentável | VPS necessária | Custo Hostinger/mês (renovado) | Custo por 1M req |
|---|---|---|---|---|
| 1 operador piloto | 50 | KVM 2 | R$ 90 | R$ 0,021 |
| 5 operadores médios | 500 | KVM 4 + KVM 4 (Redis) | R$ 240 | R$ 0,011 |
| 20 operadores | 2.000 | 2× KVM 8 + 1 KVM 4 (Redis) | R$ 600 | R$ 0,005 |
| 100 operadores | 10.000 | Cluster 5× KVM 8 + Redis cluster | R$ 1.800 | R$ 0,002 |

**Margem operacional:** mesmo no piloto inicial, custo per-request é < R$ 0,03. Take-rate de 5% sobre $0,005 (5.000 µL) já é R$ 0,012 por request — **margem positiva desde o primeiro operador**.

---

## 6. Observabilidade

### 6.1 Métricas que precisam estar expostas

Endpoint `GET /health` (já implementado) retorna estado básico. Para produção, expor Prometheus em `/metrics`:

| Métrica | Tipo | Labels | Uso |
|---|---|---|---|
| `x402_requests_total` | counter | `path, status, gated` | Volume + taxa de gating |
| `x402_402_total` | counter | `tier, trust_score_bucket` | Taxa de challenges emitidos |
| `x402_payments_total` | counter | `tier, operator_id` | Pagamentos verificados |
| `x402_payment_amount_micro_lamports` | histogram | `tier, operator_id` | Distribuição de tickets |
| `x402_verify_duration_seconds` | histogram | — | Latência de verify (deve ficar < 5 ms p95) |
| `x402_nonce_active` | gauge | — | Nonces ativos no momento |
| `x402_escrow_balance_micro_lamports` | gauge | `pubkey_hash` | Saldo por agente (top-N) |
| `x402_load` | gauge | — | Carga atual (0–1) |
| `x402_upstream_latency_seconds` | histogram | `upstream` | Latência ao upstream RPC |
| `x402_trust_score_distribution` | histogram | — | Distribuição de scores |

### 6.2 SLOs sugeridos (operador integrado)

| Indicador | Objetivo | Severidade ao violar |
|---|---|---|
| Disponibilidade `/rpc` (rolling 30d) | ≥ 99,9% | P1 |
| Latência verify p99 | < 10 ms | P2 |
| Taxa de erro 5xx | < 0,1% | P2 |
| Lag escrow → upstream | < 50 ms p95 | P3 |
| Drift saldo escrow vs ledger | 0 | P0 (incidente) |

### 6.3 Logs estruturados

Formato recomendado: JSON line. Campos mínimos:

```json
{
  "ts": "2026-05-04T10:23:45.123Z",
  "level": "info",
  "event": "payment_verified",
  "request_id": "01HXYZ...",
  "operator_id": "op_helius_main",
  "agent_pubkey": "BkZ...3a4",
  "amount_micro_lamports": 12500,
  "trust_score": 35,
  "load": 0.73,
  "duration_ms": 4.2
}
```

Eventos críticos a logar:
- `nonce_issued` — para trace de challenge.
- `payment_verified` — sucesso de pagamento.
- `payment_rejected` — com `reason` (signature_mismatch, nonce_used, insufficient_balance, hint_mismatch).
- `escrow_deposit_verified` — credit ledger.
- `upstream_error` — falha do RPC upstream.
- `qos_overload_received` — operator sinalizou overload (cooperative QoS).

### 6.4 Alertas

| Alerta | Condição | Ação |
|---|---|---|
| `ShieldDown` | `up{job="x402-shield"} == 0` por 1 min | P1 — page on-call |
| `HighRejectRate` | `rate(payment_rejected) / rate(payment_attempted) > 0.1` por 5 min | P2 — investigar (possível ataque) |
| `EscrowDriftDetected` | reconciliation diária encontra drift > 0 | P0 — congelar settlements |
| `UpstreamLatencyHigh` | `p95(x402_upstream_latency) > 500ms` por 10 min | P3 — verificar upstream |
| `TrustScoreSybil` | > 50 pubkeys novas com score crescente em 1h | P2 — revisar formula/decay |

---

## 7. Modelo de ameaças (resumo)

Detalhamento completo na seção 9 da [`rfc/x402-priority.md`](rfc/x402-priority.md). Resumo executivo:

| Ameaça | Vetor | Mitigação atual | Resíduo |
|---|---|---|---|
| **Replay de nonce** | Reenviar requisição assinada | Atomic consume via Redis Lua + TTL 30s | Aceitável |
| **Spoofing de Trust-Score** | Hint pubkey de outro agente | Nonce bound to hinted pubkey + signer check | Aceitável |
| **Replay de depósito on-chain** | Reusar tx_signature | Set `usedDepositSignatures` | Aceitável |
| **Comprometimento de chave do operador** | Roubo da pubkey de payment_destination | `PAYMENT_DESTINATION` é address, não secret. Sweep periódico para hardware wallet | Mitigado |
| **Comprometimento do shield (RCE)** | Vulnerabilidade no Node.js / dependência | Apache 2.0 + audit + container sem root + no-secrets-on-disk | Reduzido |
| **DoS por flood de challenges** | Bot dispara milhões de 402 sem retornar | Rate limit per-IP + nonce TTL agressivo + memória bounded | Aceitável |
| **DoS via espera de upstream** | Upstream lento bloqueia connections | `httpAgent.maxSockets` + timeout `Promise.race` | Reduzido |
| **Vazamento de escrow via race** | Concurrent retries com mesmo nonce | Lua script atomic check-and-debit | Eliminado |
| **Privilege escalation via misuse de `/escrow/deposit-trusted`** | Credit sem on-chain | Endpoint syntactically absent unless `ESCROW_TRUST_DEPOSITS=1` | Eliminado em prod |
| **Sybil attacks no Trust-Score** | Criar muitas pubkeys baratas | Cost-per-pubkey via base price floor + decay temporal | Parcial — em desenvolvimento |
| **Front-running de pagamento** | Tx do agente em mempool, atacante copia | Off-chain settlement + nonce bound | Eliminado |

### 7.1 Próximos hardenings

- **Container non-root** (O-008 do journal).
- **Secrets em Portainer/Docker secrets** vs. `.env` plaintext (O-007).
- **Auditoria formal pré-mainnet** (OtterSec ou Zellic) — gate antes de v1.0 final.
- **Bug bounty Immunefi** após auditoria — escopo: shield + SDK + splitter program (se já existir).

---

## 8. Tier de serviço — implementação técnica

Cada tier comercial implica configuração técnica diferente. Esta seção define o que cada tier expõe.

### 8.1 Tier **Starter** (R$ 499/mês)

**Audiência:** operadores pequenos/regionais, validadores BR, projetos próprios.

| Capability | Limite |
|---|---|
| Throughput suportado | até 50 req/s |
| Multi-região | não |
| Telemetria customizada | dashboard padrão |
| Trust-Score backend | shared (multi-tenant) |
| Settlement | invoice mensal (Padrão D) |
| SLA | best-effort |
| Suporte | email, 48h resposta |
| Atualizações | quinzenais via container update |

**Configuração técnica:**
- Container Docker compartilhado (multi-tenant via subdomínio).
- Redis compartilhado com namespace por operador.
- Painel web simples para configurar `PAYMENT_DESTINATION` + threshold.

### 8.2 Tier **Pro** (R$ 2.499/mês)

**Audiência:** operadores médios com multi-região, equipe técnica dedicada.

| Capability | Limite |
|---|---|
| Throughput suportado | até 500 req/s |
| Multi-região | até 3 regiões |
| Telemetria customizada | Prometheus scrape próprio |
| Trust-Score backend | dedicado (single-tenant) |
| Settlement | multi-destination tx (Padrão A) |
| SLA | 99,5% mensal |
| Suporte | Slack/Discord, 8h resposta |
| Atualizações | semanais com janela de manutenção agendada |

**Configuração técnica:**
- Container dedicado por operador.
- Redis dedicado (KVM 4 reservado).
- Webhook para integração com sistema de billing do operador.
- Acesso a `/metrics` Prometheus para grafana próprio.

### 8.3 Tier **Enterprise** (R$ 9.999/mês + custom)

**Audiência:** Helius/Triton/QuickNode-class.

| Capability | Limite |
|---|---|
| Throughput suportado | sem limite (escalável) |
| Multi-região | global, sem limite |
| Telemetria customizada | full stack acesso |
| Trust-Score backend | dedicado + customização de fórmula |
| Settlement | custom (multi-dest, splitter on-chain ou direto) |
| SLA | 99,95% mensal com créditos |
| Suporte | engenheiro dedicado, 1h resposta P1 |
| Atualizações | janela negociada, canary deploys |
| Auditoria customizada | acesso ao código + revisão conjunta |

**Configuração técnica:**
- Deploy on-premises ou em infra do cliente (suporte a air-gapped).
- Integração com identity provider corporativo.
- Customização de pricing curve.
- DR/BCP plan documentado.

### 8.4 Tier **Hosted/Managed** (revenue share 25–30%)

**Audiência:** operadores pequenos sem infra própria, novos entrantes.

Modelo: nós rodamos o shield + escrow + settlement. Operador apenas plugga endpoint upstream + `PAYMENT_DESTINATION`.

| Capability | Limite |
|---|---|
| Throughput suportado | até 200 req/s (compartilhado) |
| Multi-região | nossa edge layer |
| Telemetria | dashboard simplificado |
| Trust-Score backend | shared |
| Settlement | escrow + settlement diário (Padrão C) |
| SLA | 99,5% mensal |
| Suporte | email, 24h |

**Configuração técnica:**
- Multi-tenant no nosso ambiente (ver §3.3).
- Settlement automático diário às 02:00 UTC.
- Operador acessa painel para acompanhar volume + receita esperada.

---

## 9. Roadmap técnico por fase

### 9.1 Fase MVP (mês 1–6) — validação

**Objetivo:** 3 operadores integrados, métricas reais públicas.

| Item | Prazo | Status |
|---|---|---|
| Auditoria peer-review pública | M+3 | Planejado |
| Suporte cooperative QoS production-ready | M+3 | Spec pronto, falta integração 1 piloto |
| Settlement Padrão D (invoice) implementado | M+2 | A fazer |
| Trust-Score com decay temporal (O-010) | M+4 | Spec parcial |
| Migração escrow + reputation para Redis persistente (O-009) | M+2 | A fazer |
| Container non-root + secrets management (O-007, O-008) | M+3 | A fazer |
| CI smoke test em GitHub Actions (fechamento O-003) | M+1 | A fazer |
| Painel multi-tenant para tier Starter | M+5 | A fazer |

### 9.2 Fase Growth (mês 6–18) — escala

| Item | Prazo | Status |
|---|---|---|
| Settlement Padrão A (multi-destination tx) | M+8 | Spec a desenhar |
| RFC v1.1 com extensão multi-destination | M+9 | A fazer |
| Auditoria formal OtterSec/Zellic | M+10 | Funded por SF grant |
| Bug bounty Immunefi tier $50k+ | M+11 | Pós-auditoria |
| Federated Trust-Score (multi-operador) | M+12 | Spec parcial |
| Suporte Yellowstone gRPC | M+8 | A fazer |
| Multi-região managed offering | M+9 | Infra Hetzner/Latitude |
| Prometheus + Grafana templates público | M+7 | A fazer |

### 9.3 Fase Scale (mês 18+) — institucionalização

| Item | Prazo | Status |
|---|---|---|
| Settlement Padrão B (splitter on-chain) | M+18 | Programa Anchor a desenvolver |
| RFC v2.0 com nonce federation | M+20 | Discussão ecosystem |
| Multichain — Base/Arbitrum/Sui | M+24 | Avaliação |
| SDK Rust + Python | M+18 | Comunidade |
| Suporte oficial Solana Foundation | M+24 | Relacionamento contínuo |

---

## 10. Cross-references

### 10.1 Outros documentos

| Documento | Quando consultar |
|---|---|
| [`rfc/x402-priority.md`](rfc/x402-priority.md) | Wire protocol formal (headers, signing, atomic consume) |
| [`rfc/x402-qos-cooperative.md`](rfc/x402-qos-cooperative.md) | Cooperação shield ↔ operador upstream |
| [`ENGINEERING.md`](ENGINEERING.md) | Histórico de decisões técnicas (D-001..D-016) |
| [`QOS-COOPERATIVE-SPEC.md`](QOS-COOPERATIVE-SPEC.md) | Spec de header `X-Priority-Score` |
| [`JORNADA-NODE-OPERADOR.md`](JORNADA-NODE-OPERADOR.md) | Onboarding comercial do operador |
| [`DEPLOY.md`](DEPLOY.md) | Runbook de deploy via Docker + Traefik |
| [`DEPLOY-VPS-ADAPTADO.md`](DEPLOY-VPS-ADAPTADO.md) | Deploy adaptado para VPS Hostinger |
| [`ESTRATEGIA.md`](ESTRATEGIA.md) | Posicionamento estratégico, Plano A/B/C |
| [`ANALISE-MERCADO-VIABILIDADE-2026-05-04.md`](ANALISE-MERCADO-VIABILIDADE-2026-05-04.md) | Análise de mercado, viabilidade financeira, modelo de receita empilhado |
| [`JITO-COMPARATIVO-CAMADAS.md`](JITO-COMPARATIVO-CAMADAS.md) | Posicionamento de camada vs. infraestrutura adjacente |
| [`GLOSSARIO.md`](GLOSSARIO.md) | Termos técnicos e suas definições |

### 10.2 Código-fonte de referência

| Componente | Arquivo |
|---|---|
| Shield principal | [`index.js`](../index.js) |
| Cliente SDK TypeScript | [`x402-client-sdk.ts`](../x402-client-sdk.ts) |
| Storage layer (Redis Lua + memory) | [`lib/store.js`](../lib/store.js) |
| Detection (load + rate limit) | [`lib/detection.js`](../lib/detection.js) |
| Test smoke | [`test/smoke.js`](../test/smoke.js) |
| Test cooperative QoS | [`test/cooperative-qos.test.js`](../test/cooperative-qos.test.js) |
| Test atomic consume | [`test/atomic-consume.test.js`](../test/atomic-consume.test.js) |
| Demo single-request | [`demo.js`](../demo.js) |
| Bench multi-sample | [`bench.js`](../bench.js) |
| Trust-Score progression | [`examples/trust-progression.js`](../examples/trust-progression.js) |
| Cooperative QoS reference | [`examples/operator-qos-reference.js`](../examples/operator-qos-reference.js) |
| Verified deposit example | [`examples/deposit-with-tx.js`](../examples/deposit-with-tx.js) |
| Mainnet payment test | [`tools/pay-test-mainnet.js`](../tools/pay-test-mainnet.js) |

### 10.3 Endpoints públicos

| Endpoint | Propósito |
|---|---|
| `https://api.rpcpriority.com` | Shield mainnet (operador pubkey `CEH3dGLaYQmYGGwDpszfuBRfcUmBbLNinrSdVdi7k6zp`) |
| `https://api.rpcpriority.com/health` | Liveness + carga atual |
| `https://api.rpcpriority.com/info` | Metadados do gateway |
| `https://api.rpcpriority.com/reputation/<pubkey>` | Trust-Score de uma pubkey |
| `https://api.rpcpriority.com/escrow/balance/<pubkey>` | Saldo escrow de uma pubkey |

---

## Anexo — Checklist de integração de novo operador

Use este checklist ao integrar um novo operador (independente do tier).

### Fase 1 — Pré-integração

- [ ] Confirmação do tier comercial (Starter / Pro / Enterprise / Hosted).
- [ ] Wallet `PAYMENT_DESTINATION` provisionada pelo operador (preferencialmente hardware wallet).
- [ ] Endpoint upstream RPC do operador acessível (URL + qualquer auth necessária).
- [ ] Política de threshold de carga acordada (`THRESHOLD`, `MAX_RPS`, `BASE_PRICE`, `MAX_PRICE`).
- [ ] Acordo de revenue share assinado (% take-rate, frequência de settlement, padrão de settlement).
- [ ] Preferência de domain: shield no `<operador>.rpcpriority.com` ou subdominio próprio.

### Fase 2 — Deployment

- [ ] Provisão de VPS/container conforme tier (ver §5.2).
- [ ] Configuração `.env` com variáveis: `REAL_RPC_URL`, `PAYMENT_DESTINATION`, `RPC_LOAD_THRESHOLD`, `MAX_RPS`, `BASE_PRICE_MICRO_LAMPORTS`, `MAX_PRICE_MICRO_LAMPORTS`, `SOLANA_RPC_URL`.
- [ ] Redis provisionado (compartilhado tier Starter, dedicado tier Pro+).
- [ ] DNS + TLS (Cloudflare ou Traefik + Let's Encrypt).
- [ ] Smoke test ponta-a-ponta: depósito real on-chain + handshake + verificação saldo.

### Fase 3 — Observabilidade

- [ ] `/metrics` Prometheus configurado e scrapeado.
- [ ] Dashboard Grafana padrão importado.
- [ ] Alertas P0/P1 configurados (ShieldDown, EscrowDrift, HighRejectRate).
- [ ] Logs centralizados (Loki, Elasticsearch ou solução do operador).
- [ ] Acesso compartilhado ao dashboard com operador.

### Fase 4 — Validação comercial

- [ ] Tráfego shadow mode rodando por 7 dias (operador continua atendendo direto, shield observa).
- [ ] Métricas de baseline coletadas (RPS médio, distribuição de chamadas, p95).
- [ ] Política de gating ativada gradualmente (10% do tráfego → 25% → 50% → 100%).
- [ ] Primeiro pagamento real verificado e logado.
- [ ] Reconciliação ledger ↔ on-chain executada (deve ter drift zero).
- [ ] Settlement teste executado conforme padrão acordado.

### Fase 5 — Go-live

- [ ] Anúncio público (blog post + thread X) com case study técnico.
- [ ] Operator listado em página `https://rpcpriority.com/operators`.
- [ ] Acesso a `/info` retorna dados do operador.
- [ ] Onboarding documentado em runbook interno.
- [ ] Postmortem agendado para D+30 com revisão de incidents.

---

*Documento mantido pela equipe técnica do RPC Priority Protocol. Atualizar conforme decisões D-NNN forem registradas no [`ENGINEERING.md`](ENGINEERING.md). Sugestões via issue no GitHub upstream.*
