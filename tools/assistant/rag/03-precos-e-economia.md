# Preços, custos e economia

## Curva de pricing dinâmico

Configuração atual em produção (mainnet) — **Cenário 20×**:
- BASE_PRICE: 20.000 µL (= 20 lamports)
- MAX_PRICE: 1.000.000 µL (= 1.000 lamports)
- THRESHOLD: 0,5 (gating ativa quando load > 50%)

Fórmula:
```
ratio = clamp(0, 1, (load - threshold) / (1 - threshold))
amount = round(BASE + ratio × (MAX - BASE))
```

| Load | Preço (sem desconto) |
|---|---|
| ≤ 0,5 (livre) | 0 (passa de graça) |
| 0,6 | 216.000 µL |
| 0,75 | 510.000 µL |
| 0,9 | 804.000 µL |
| 1,0 (saturado) | 1.000.000 µL |

## Trust-Score discount

Algoritmo: `score = min(100, paidCount × 5)` — 5 pontos por pagamento confirmado, satura em 100 após 20 pagamentos.

Discount: `priceDiscount = score / 200` → 0% (score 0) até 50% (score 100).

| Score | Pagamentos | Desconto | Preço a 0,9 load |
|---|---|---|---|
| 0 | 0 | 0% | 804.000 µL |
| 25 | 5 | 12,5% | 703.500 µL |
| 50 | 10 | 25% | 603.000 µL |
| 75 | 15 | 37,5% | 502.500 µL |
| 100 | 20+ | 50% | 402.000 µL |

Floor: nunca paga menos que BASE_PRICE.

## Conversões de unidade

```
1 lamport       = 1.000 µL (micro-lamports)
1 SOL           = 1.000.000.000 lamports = 10¹² µL (1 trilhão)
1 µL            = 0,000000000001 SOL
```

A USD $83/SOL (preço de 2026-05):

| Quantidade | Em SOL | Em USD |
|---|---|---|
| 20.000 µL (BASE) | 0,00000002 | $0,00000166 |
| 402.000 µL (preço com Trust 100 a load 0,9) | 0,000000402 | $0,0000334 |
| 1.000.000 µL (MAX) | 0,000001 | $0,000083 |
| 1 milhão µL | 0,000001 | $0,000083 |
| 1 bilhão µL | 0,001 | $0,083 |
| 10 bilhões µL | 0,01 | $0,83 |

## Capital necessário (vários cenários)

### Pra ter 10 bilhões de µL na escrow

10 bi µL ÷ 1.000 µL/lamport = 10M lamports = **0,01 SOL ≈ $0,83 USD**

Esse capital cobre, com Trust-Score 100:

| Load | Custo/req | Requests cobertos |
|---|---|---|
| 0,6 | 108.000 µL | ~92.600 |
| 0,75 | 255.000 µL | ~39.200 |
| 0,9 | 402.000 µL | ~24.875 |
| 1,0 | 500.000 µL | ~20.000 |

**Pior caso: 20 mil requests prioritários com $0,83 USD.**

### Cenários práticos

Cliente com Trust-Score 100 — **carga constante 0,75** (worst case, raramente real):

| Volume diário esperado | Custo/dia | Custo/mês |
|---|---|---|
| 1.000 req/dia | $0,021/dia | $0,64/mês |
| 10.000 req/dia | $0,21/dia | $6,35/mês |
| 100.000 req/dia | $2,12/dia | $63,5/mês |
| 1.000.000 req/dia | $21,17/dia | **$635/mês** |
| 10.000.000 req/dia | $211,68/dia | **$6.350/mês** |

### Cenários efetivos (realistas, considerando 15% do tempo gated)

| Volume diário | Custo/mês efetivo (15% gating) | vs Helius Business ($499) |
|---|---|---|
| 100.000 req/dia | **$10/mês** | 50× mais barato |
| **1.000.000 req/dia** | **$95/mês** | **5× mais barato** |
| 10.000.000 req/dia | **$953/mês** | 2× mais caro (mas acima do Business tier) |

**Sweet spot do mercado**: 1-5M req/dia. Helius Developer ($49) é insuficiente, Helius Business ($499) é overkill — **RPC Priority a $95-475/mês cabe aqui exatamente**.

## Stress test real (validação 2026-04-30, valida o mecanismo)

End-to-end em mainnet — **com pricing antigo (Cenário A 1×)**:
- 5 wallets ephemerais criadas via 2-step funding (treasury → agent → operator)
- 1.000 paid requests disparados (200 por agente)
- 555 sucessos / 445 caíram em 429 do upstream Solana público
- Trust-Score progression: 0 → 100 em 21 pagamentos confirmados (matemática exata)
- Sustained throughput: 3,9 RPS (bottleneck era upstream, não nosso shield)
- Latência: p50=378ms, p95=639ms, p99=701ms
- Custo total real: $0,39 USD

**Com Cenário 20× atual, mesmo teste custaria ~$7,80 USD** — ainda trivial pra validação.

## Economics pro NODE-OPERADOR

Receita esperada com **Cenário 20×** + revenue share **70/30 a favor do operador**:

| Tier de cliente | Volume típico | Receita bruta/mês | Operador (70%) | RPC Priority (30%) |
|---|---|---|---|---|
| Indexer | 100k req/dia (3M req/mês) | ~$10/mês | $7/mês | $3/mês |
| Bot trading | 1M req/dia (30M req/mês) | ~$95/mês | $67/mês | $29/mês |
| MEV searcher | 10M req/dia (300M req/mês) | ~$953/mês | $667/mês | $286/mês |
| Wallet provider | 50M req/dia (1,5B req/mês) | ~$4.760/mês | $3.332/mês | $1.428/mês |

**Sem 70/30 split (modelo atual)**: RPC Priority captura 100% do volume monetizado.

## Comparação concorrencial

| Provider | Custo recorrente | Prioridade dinâmica? | Cliente fiel desconto? |
|---|---|---|---|
| RPC público Solana | grátis | rate-limited brutal | n/a |
| Helius Developer | $49/mês fixo | não, limites por plano | não |
| Helius Business | $499/mês fixo | não | não |
| Triton One | $200-2000/mês | não | não |
| QuickNode | $49-999/mês | não | não |
| **RPC Priority (nós)** | **$10-1.000/mês típico** | **sim, curva linear** | **sim, até 50% off** |

Vantagem competitiva: o ÚNICO que cobra **só pelo pico**. Em ~85% do tempo (carga baixa), passa grátis. Os outros cobram 100% do tempo independente de carga.
