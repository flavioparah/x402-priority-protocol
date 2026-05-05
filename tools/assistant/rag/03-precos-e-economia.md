# Preços, custos e economia

## Curva de pricing dinâmico

Configuração atual em produção (mainnet):
- BASE_PRICE: 1.000 µL (= 1 lamport)
- MAX_PRICE: 50.000 µL (= 50 lamports)
- THRESHOLD: 0,5 (gating ativa quando load > 50%)

Fórmula:
```
ratio = clamp(0, 1, (load - threshold) / (1 - threshold))
amount = round(BASE + ratio × (MAX - BASE))
```

| Load | Preço (sem desconto) |
|---|---|
| ≤ 0,5 (livre) | 0 (passa de graça) |
| 0,6 | 10.800 µL |
| 0,75 | 25.500 µL |
| 0,9 | 40.200 µL |
| 1,0 (saturado) | 50.000 µL |

## Trust-Score discount

Algoritmo: `score = min(100, paidCount × 5)` — 5 pontos por pagamento confirmado, satura em 100 após 20 pagamentos.

Discount: `priceDiscount = score / 200` → 0% (score 0) até 50% (score 100).

| Score | Pagamentos | Desconto | Preço a 0,9 load |
|---|---|---|---|
| 0 | 0 | 0% | 40.200 µL |
| 25 | 5 | 12,5% | 35.175 µL |
| 50 | 10 | 25% | 30.150 µL |
| 75 | 15 | 37,5% | 25.125 µL |
| 100 | 20+ | 50% | 20.100 µL |

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
| 1.000 µL (BASE) | 0,000000001 | $0,00000008 |
| 20.100 µL (preço com Trust 100 a load 0,9) | 0,0000000201 | $0,0000017 |
| 50.000 µL (MAX) | 0,00000005 | $0,0000042 |
| 1 milhão µL | 0,000001 | $0,000083 |
| 1 bilhão µL | 0,001 | $0,083 |
| 10 bilhões µL | 0,01 | $0,83 |

## Capital necessário (vários cenários)

### Pra ter 10 bilhões de µL na escrow

10 bi µL ÷ 1.000 µL/lamport = 10M lamports = **0,01 SOL ≈ $0,83 USD**

Esse capital cobre, com Trust-Score 100:

| Load | Custo/req | Requests cobertos |
|---|---|---|
| 0,6 | 5.400 µL | ~1.852.000 |
| 0,75 | 12.750 µL | ~785.000 |
| 0,9 | 20.100 µL | ~498.000 |
| 1,0 | 25.000 µL | ~400.000 |

**Pior caso: 400 mil requests prioritários com $0,83 USD.**

### Cenários práticos

| Volume diário esperado | Custo/dia (carga média) | Custo/mês |
|---|---|---|
| 1.000 req/dia | 25.000 µL = 25k lamports | $0,002/dia → $0,06/mês |
| 10.000 req/dia | $0,02/dia | $0,60/mês |
| 100.000 req/dia | $0,20/dia | $6/mês |
| 1.000.000 req/dia | $2/dia | $60/mês |

**Mesmo a 1M req/dia ($60/mês) é mais barato que qualquer plano fixo da Helius (mínimo $49/mês mas com features limitadas).**

## Stress test real (validação 2026-04-30)

End-to-end em mainnet:
- 5 wallets ephemerais criadas via 2-step funding (treasury → agent → operator)
- 1.000 paid requests disparados (200 por agente)
- 555 sucessos / 445 caíram em 429 do upstream Solana público
- Trust-Score progression: 0 → 100 em 21 pagamentos confirmados (matemática exata)
- Sustained throughput: 3,9 RPS (bottleneck era upstream, não nosso shield)
- Latência: p50=378ms, p95=639ms, p99=701ms
- **Custo total real: $0,39 USD** (incluindo tx fees + rent-exempt buffer + escrow funding)

## Economics pro NODE-OPERADOR (Plano A)

Receita esperada de licenciar Shield (cliente principal):

| Tier de cliente | Licença mensal | Volume típico | Revenue share 5% (bonus) |
|---|---|---|---|
| Starter (validator pequeno) | $500 | <10M req/mês | + ~$5-50/mês |
| Growth (RPC tier 2/3) | $1.500 | 10-100M req/mês | + $50-500/mês |
| Scale (RPC tier 1 médio) | $3.000 | 100M-1B req/mês | + $500-5k/mês |
| Enterprise (Helius-tier) | $5.000+ custom | >1B req/mês | + $5k-50k/mês |

Trust-Score Premium adicional: $200-500/mês (acesso ao dataset cross-operator).

## Comparação concorrencial

| Provider | Custo recorrente | Prioridade dinâmica? | Cliente fiel desconto? |
|---|---|---|---|
| RPC público Solana | grátis | rate-limited brutal | n/a |
| Helius Developer | $49/mês fixo | não, limites por plano | não |
| Helius Business | $499/mês fixo | não | não |
| Triton One | $200-2000/mês | não | não |
| QuickNode | $49-999/mês | não | não |
| **RPC Priority (nós)** | **$0-60/mês típico** | **sim, curva linear** | **sim, até 50% off** |

Vantagem competitiva: o ÚNICO que cobra **só pelo pico**. Em 99% do tempo (carga baixa), passa grátis. Os outros cobram 100% do tempo independente de carga.
