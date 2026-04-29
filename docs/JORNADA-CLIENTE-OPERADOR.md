# Jornada do Cliente-operador

> Documento de produto. Detalha o caminho do **end-user** que consome RPC Solana e paga priority fees através do Shield. Para a estratégia de a quem vendemos primariamente, ver [`ESTRATEGIA.md`](./ESTRATEGIA.md).

---

## Definição

**Cliente-operador** = quem opera um agente, dapp, bot ou serviço que consome RPC Solana e paga priority fees pra ter acesso garantido durante congestionamento.

Importante: pelo Plano A da estratégia, **o cliente-operador NÃO paga diretamente pra nós** — paga ao node-operador (parceiro/cliente nosso) que opera um Shield licenciado. Pelo Plano B (fallback / configuração atual em produção), paga direto pra nossa carteira-operadora.

## Personas reais

| Quem | Dor sem RPC Priority | Volume típico |
|---|---|---|
| **Bot de arbitragem MEV** | Tx perdida vale $50–$5k/oportunidade | 10–100 RPS, picos de 500 |
| **Frontend de DEX** (Jupiter, Raydium) | UX ruim em congestionamento → churn | 1–50 RPS sustained |
| **Agente IA autônomo** | Falha silenciosa quando RPC engasga; agente não tem checkout humano | 1–20 RPS |
| **Bot de mint NFT** | Disputa de slot em drop → perde mint | Burst 100+ RPS, depois zero |
| **Liquidador DeFi** | Janela de liquidação perdida = dívida ruim | 10–50 RPS |
| **Wallet provider (backend)** | Lag visível pros usuários finais | 50–500 RPS |
| **Indexador / oracle** | Poll de alta freq cai sob carga | 50–200 RPS sustained |

Regra prática: **se UMA oportunidade perdida custa mais de 1 ano de priority fees, vale a pena.** O break-even é tipicamente absurdamente baixo.

## A jornada — 6 fases

### Fase 1 — Discovery (5 min)

Encontra via:
- Outreach do node-operador parceiro ("seu RPC agora tem priority access")
- Solana Foundation listing
- Repo público / SDK no npm
- Pitch direto (Hackatom, conferências)
- Cold email pra MEV searchers, DEX, mint bots

Ação dele: abre `https://app.rpcpriority.com/explorer` ou `/info` do shield do node-operador. Vê metadados, prova que é mainnet real.

**Sinais de qualificação**: já apanha do RPC público, já considerou Helius/Triton ($50–200/mês fixos), tem >1k req/dia.

### Fase 2 — Avaliação (15–30 min)

Quer confirmar 3 coisas:

| Pergunta | Onde checar |
|---|---|
| "É real ou demo?" | `GET /info` retorna mainnet, operator pubkey real, base/max prices |
| "Quanto vou gastar?" | Multiplica seu volume típico × preço médio. Tipicamente $0,001–$1/dia |
| "Funciona end-to-end?" | Roda `pay-test-mainnet.js` ou abre `app.rpcpriority.com/try` |

**Decisão GO/NO-GO em ~30 min.** Compara contra:
- RPC público gratuito Solana: vence em volume zero
- Helius free tier (50k req/mês): vence em volume baixíssimo
- Helius Developer ($49/mês): vence se volume >1M req/mês PREVISÍVEL e sem prioridade real
- **RPC Priority ganha** quando há cargas SPIKE (não constantes) e cada falha custa muito

### Fase 3 — Onboarding (1 hora)

#### 3a. Setup de wallet (15 min)

Recomendado: **wallet dedicada à operação**, separada da treasury pessoal.
- Solflare/Backpack/Phantom geram fresca
- Privkey em vault (1Password, AWS Secrets Manager, hardware wallet)
- **NÃO** reusa a wallet pessoal — separação de blast radius

#### 3b. Funding inicial (5 min)

Calcula budget:
```
volume diário × preço médio = custo/dia
1k req/dia × 25k µL = 0,000025 SOL ≈ $0,004/dia
10k req/dia → $0,04/dia
100k req/dia → $0,40/dia
1M req/dia → $4/dia ≈ $120/mês
```

Mesmo a 1M req/dia: trivial. Deposita 30 dias com folga: tipicamente **0,01–0,1 SOL ($1,70–$17)**.

```javascript
// Transferência on-chain (uma vez)
const tx = new Transaction().add(SystemProgram.transfer({
  fromPubkey: myWallet.publicKey,
  toPubkey: new PublicKey('<operator_pubkey>'),
  lamports: 1_000_000  // 0,001 SOL = 30 dias a 30k req/dia
}));
const sig = await sendAndConfirmTransaction(conn, tx, [myWallet]);

// Crédito na escrow do Shield
await fetch('https://api.<host>/escrow/deposit', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ tx_signature: sig })
});
// → { credited: 1_000_000_000, balance: 1_000_000_000 } µL
```

#### 3c. Integração no código (30 min)

Substitui a Connection existente por wrapper x402:

```javascript
// ANTES
const conn = new Connection('https://api.mainnet-beta.solana.com');

// DEPOIS — drop-in
import { x402Connection } from '@rpcpriority/sdk';
const conn = x402Connection({
  gateway: 'https://api.<host>/rpc',
  agentKeypair: myAgentKeypair,
  maxBudgetMicroLamports: 50000  // teto por request
});
// resto do código não muda
```

Ou flow manual: 1ª request → 402 → assina nonce com Ed25519 → reenvia com `Authorization: x402 ...`.

### Fase 4 — Operações em produção (contínuo)

Tráfego flui. Em carga baixa (load < 0,5), **passa de graça** (sem 402). Em pico, paga 1–50 lamports/request. Cliente nem percebe quando está pagando.

**Monitoramento típico:**

```bash
# Saldo escrow (alerta < 7 dias de runway)
curl https://api.<host>/escrow/balance/<my_pubkey>

# Reputação (Trust-Score acumulando)
curl https://api.<host>/reputation/<my_pubkey>

# Stats globais (transparência)
curl https://api.<host>/stats/leaderboard
```

**Alertas que ele configura:**

| Alerta | Threshold | Ação |
|---|---|---|
| Escrow < 7 dias | balance < runway × 7 | Top-up automático ou notificação |
| Custo médio > previsto | preço_médio > 30k µL | Investigar carga upstream |
| Latência total > 100 ms | p95 latência | Ticket pra suporte |

### Fase 5 — Otimização (semana 2–4)

Aprende a economizar:
- **Cache local** de getBalance/getAccountInfo (TTL 1–3 s) reduz volume drasticamente
- **Batch JSON-RPC** — múltiplas chamadas em uma única assinatura
- **Sobe Trust-Score** — após 20 pagamentos, paga 50% a menos. **Não troca de wallet** entre testes/prod
- **Roda agente em região próxima da VPS do node-operador** (Latam pra reduzir latência)

### Fase 6 — Escala / Saída

Cliente vira recorrente quando:
- Faz parte da arquitetura (RPC tier 1, fallback pra Helius gratuito em emergência)
- Treasury automatizada com top-up via cron
- SLA interno baseado em métricas observadas (latência p95, taxa de sucesso)

Saída tipicamente:
- Volume cresceu pra ponto de rodar próprio nó Solana ($500–1500/mês) — **continua usando RPC Priority como failover**
- Empresa fechou (raro)

## Comparação concorrencial

| Provider | Preço | Modelo | Quando ganha |
|---|---|---|---|
| **RPC público Solana** | grátis | rate-limited brutalmente | hobby, dev local |
| **Helius Developer** | $49/mês | 25M req/mês fixo | volume previsível constante |
| **Helius Business** | $499/mês | 100M req/mês + features | dapps maduras com >100k MAU |
| **Triton One** | $200–2000/mês | dedicated infra | trading firms latency-critical |
| **QuickNode** | $49–999/mês | similar Helius | enterprise multi-chain |
| **RPC Priority** | **$0,001–1/dia** | pay-per-request com Trust-Score | **spikes irregulares**, agentes IA, MEV searchers, mint bots |

**Vantagem competitiva única**: o ÚNICO modelo onde paga **só pelo que congestiona**. Em 99% do tempo (carga baixa), passa grátis. Os outros cobram 100% do tempo independente de carga.

## Tempo total da jornada

| Fase | Tempo | Custo |
|---|---|---|
| Discovery | 5 min | 0 |
| Avaliação | 15–30 min | 0 |
| Onboarding (wallet+funding+integração) | 1h | $1,70 (deposit mínimo) |
| Operação (1º mês) | passivo | ~$1–5/mês típico |
| Otimização | 2–4h ao longo do mês 1 | (economiza dinheiro) |

**Da descoberta à 1ª request paga em produção: < 2 horas.** Sem contrato, sem onboarding humano, sem ticket de suporte. **x402 é checkout pra agentes.**

## Friction points conhecidos

1. **SDK npm não publicado** — hoje copia-cola dos `examples/`. Tarefa: publicar `@rpcpriority/sdk`.
2. **Documentação fragmentada** — `docs.rpcpriority.com` placeholder. Tarefa: Mintlify ou GitBook.
3. **Falta dashboard de billing** — operador vê saldo via JSON. Tarefa: portal `app.rpcpriority.com/billing`.
4. **Sem alerta automático de baixo saldo** — operador faz seu próprio. Tarefa: webhook quando escrow < threshold.
5. **Trust-Score reseta se trocar wallet** — incentivo perverso. Considerar reputation transferable via attestation.
6. **getProgramAccounts bloqueado upstream** — limita demos. Tarefa: contratar Helius/Triton como upstream privado.

## Relação comercial

### No Plano A (a quem vendemos)

Cliente-operador **não tem relação direta com a x402 Priority** — paga ao node-operador parceiro que opera o Shield licenciado. Da nossa parte:
- Ele é **usuário** dos endpoints
- Sua reputação Trust-Score é centralizada conosco — ele se beneficia entre operadores
- Não há contrato, billing, suporte direto da nossa parte

### No Plano B (fallback ou configuração atual)

Cliente-operador paga **direto pra carteira-operadora** que rodamos (`CEH3dGLa…k6zp` em mainnet). Receita 100% nossa.
- Sem contrato
- Self-onboarding via SDK
- Suporte best-effort via GitHub issues / docs

## Ver também

- [`ESTRATEGIA.md`](./ESTRATEGIA.md) — posicionamento completo Plano A vs B
- [`JORNADA-NODE-OPERADOR.md`](./JORNADA-NODE-OPERADOR.md) — o outro lado da relação
- [`BENEFICIOS.md`](./BENEFICIOS.md) — pitch de uma página
- `tools/pay-test-mainnet.js` — exercita esta jornada end-to-end
