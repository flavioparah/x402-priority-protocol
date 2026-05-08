---
title: "Analise de Pricing e Estudo de Viabilidade"
subtitle: "RPC Priority Protocol / x402 Shield"
date: "2026-05-05"
lang: pt-BR
---

# Analise de Pricing e Estudo de Viabilidade

## 1. Configuracao atual em producao (mainnet)

| Parametro | Valor | Equivalente USD ($83/SOL) |
|---|---:|---:|
| `BASE_PRICE` | 1.000 uL = 1 lamport | $0,000000083 |
| `MAX_PRICE` | 50.000 uL = 50 lamports | $0,0000042 |
| `THRESHOLD` | 0,5 (50% de carga) | n/a |
| Pricing curve | Linear entre `BASE` e `MAX` | n/a |
| Trust-Score discount | 0% -> 50% apos 20 pagamentos | ate 50% off |

## 2. O que cada cliente paga hoje, em volume real

Assumindo carga de 0,75 e Trust-Score 100.

| Volume diario do cliente | Custo medio / req | USD / dia | USD / mes |
|---:|---:|---:|---:|
| 1.000 req | 12.750 uL = 12,75 lamports | $0,001 | $0,03 |
| 10.000 req | 12,75 lamports | $0,011 | $0,32 |
| 100.000 req | 12,75 lamports | $0,11 | $3,17 |
| 1.000.000 req | 12,75 lamports | $1,06 | $31,71 |
| 10.000.000 req | 12,75 lamports | $10,57 | $317 |

Comparacao de mercado usada no estudo:

| Provedor | Plano / faixa | Observacao |
|---|---:|---|
| Helius Developer | $49/mes fixo | plano mensal |
| Helius Business | $499/mes fixo | plano mensal |
| Triton | $200-2000/mes | faixa estimada |

Ponto-chave: mesmo um cliente fazendo 1M req/dia paga apenas cerca de $32/mes com a configuracao atual. O preco fica abaixo de praticamente todos os planos fixos e ainda tem a vantagem de pagar zero em carga baixa.

## 3. O problema escondido na configuracao atual

A receita por cliente e muito baixa. Do lado do operador de no, a conta fica assim:

| Cliente do operador | Volume tipico | Receita gerada para operador | 5% rev share |
|---|---:|---:|---:|
| Indexer pequeno | 100k req/dia | $3/mes | $0,15/mes |
| Bot trading medio | 1M req/dia | $32/mes | $1,60/mes |
| MEV searcher | 5M req/dia | $159/mes | $7,93/mes |
| Wallet provider | 50M req/dia | $1.587/mes | $79/mes |

Conclusao critica: com `BASE/MAX` atuais (1k/50k uL), apenas clientes com volume massivo geram revenue share interessante. Para os demais, o modelo parece caridade para cliente e tende a produzir baixo incentivo para o operador.

## 4. Tabela comparativa: cinco cenarios de pricing

| Cenario | `BASE_PRICE` | `MAX_PRICE` | Multiplicador | Custo cliente 1M req/dia | Receita operador 1M req/dia |
|---|---:|---:|---:|---:|---:|
| A - Atual (subprice) | 1.000 uL | 50.000 uL | 1x | $32/mes | $32/mes |
| B - 5x | 5.000 uL | 250.000 uL | 5x | $159/mes | $159/mes |
| C - 10x | 10.000 uL | 500.000 uL | 10x | $317/mes | $317/mes |
| D - 20x | 20.000 uL | 1.000.000 uL | 20x | $635/mes | $635/mes |
| E - Tiered dinamico | 0 | 200.000 uL | curva mais ingreme | $254/mes | $254/mes |

### Custo por request com Trust-Score 100 e carga 0,9

| Cenario | uL / req | Lamports | USD a $83/SOL |
|---|---:|---:|---:|
| A - Atual | 20.100 | 20,1 | $0,0000017 |
| B - 5x | 100.500 | 100,5 | $0,0000083 |
| C - 10x | 201.000 | 201 | $0,000017 |
| D - 20x | 402.000 | 402 | $0,0000334 |
| E - Tiered | 80.400 | 80,4 | $0,0000067 |

Observacao importante: mesmo no cenario D, um request custa cerca de $0,0000334, ainda muito baixo em termos absolutos quando comparado ao custo de uma transacao on-chain.

## 5. Analise de viabilidade por persona

### Persona 1 - Indexer pequeno

Premissa: 100k req/dia, lucro $0/mes, opera no breakeven.

| Cenario | Custo / mes | Viavel? |
|---|---:|---|
| A - Atual | $3,17 | Sim, trivial |
| B - 5x | $15,87 | Sim, trivial |
| C - 10x | $31,75 | Sim, aceitavel |
| D - 20x | $63,50 | Comeca a ser sentido |
| E - Tiered | $25,40 | Sim, aceitavel |

### Persona 2 - Bot de arbitragem

Premissa: 1M req/dia, lucro $5k-50k/mes.

| Cenario | Custo / mes | % do lucro | Viavel? |
|---|---:|---:|---|
| A - Atual | $31,71 | 0,06% | Trivial demais |
| B - 5x | $158,55 | 0,3% | Trivial |
| C - 10x | $317,10 | 0,6% | Aceitavel |
| D - 20x | $634,20 | 1,3% | Aceitavel |
| E - Tiered | $253,68 | 0,5% | Aceitavel |

### Persona 3 - MEV searcher

Premissa: 10M req/dia, lucro $50k-500k/mes.

| Cenario | Custo / mes | % do lucro | Viavel? |
|---|---:|---:|---|
| A - Atual | $317 | 0,06% | Quase gratis |
| B - 5x | $1.586 | 0,3% | Trivial |
| C - 10x | $3.171 | 0,6% | Aceitavel |
| D - 20x | $6.342 | 1,3% | Aceitavel como premium |
| E - Tiered | $2.537 | 0,5% | Aceitavel |

### Persona 4 - Wallet provider backend

Premissa: 50M req/dia, gross margin alto.

| Cenario | Custo / mes | Viavel? |
|---|---:|---|
| A - Atual | $1.587 | Atrativo, mas margem baixa |
| B - 5x | $7.927 | Aceitavel |
| C - 10x | $15.853 | Aceitavel |
| D - 20x | $31.706 | Comeca a doer; negociar custom |
| E - Tiered | $12.682 | Sweet spot |

## 6. Recomendacao: Cenario B ou Cenario E

### Por que nao ficar no Cenario A

- Operador nao tende a aceitar 5% de revenue share quando o cliente medio gera apenas $32/mes; a comissao de $1,60/mes nao paga a complexidade de integracao.
- Trust-Score Premium de $200-500/mes nao fecha a matematica se o cliente gera so $32/mes em usage.
- Preco baixo demais pode gerar sinal negativo de mercado: se e barato demais, parece demo, nao infraestrutura critica.

### Por que Cenario B e o minimo viavel

| Aspecto | Detalhe |
|---|---|
| Cliente 1M req/dia | $159/mes |
| Operador 5% rev share | $7,93/mes por cliente medio |
| Custo absoluto | $0,0000083 por request |
| Trust-Score discount | Mantem ate 50% off para cliente fiel |

### Por que Cenario E e a opcao mais sofisticada

`BASE_PRICE=0` e `MAX_PRICE=200.000 uL`.

| Carga | Cenario E |
|---:|---:|
| <= 0,5 | Gratis |
| 0,75 | 80.400 uL |
| 0,9 | 160.800 uL |
| 1,0 | 200.000 uL |

Vantagem narrativa: "Voce paga zero na maior parte do tempo. So cobra quando a rede engasga de verdade." O modelo fica alinhado com a tese de cobrar pelo pico, nao por plano fixo.

## 7. Proposta concreta: pricing por operador

Em vez de uma configuracao global, deixar cada operador parceiro escolher dentro de bandas.

| Tier do operador | BASE recomendado | MAX recomendado | Use case |
|---|---:|---:|---|
| Hobbyist / dev | 1.000 uL | 50.000 uL | Adocao, ainda sem receita |
| Tier 2/3 BR/LatAm | 5.000 uL | 250.000 uL | Sweet spot Plano A |
| Tier 1 | 10.000 uL | 500.000 uL | Volume gigante, margem por escala |
| Premium MEV | 20.000 uL | 1.000.000 uL | SLA garantido |
| Custom enterprise | Negociado | Negociado | Acima de 100M req/mes |

## 8. Mudanca recomendada agora

Subir defaults de producao para o Cenario B (5x):

```env
BASE_PRICE=5000
MAX_PRICE=250000
```

Justificativas:

- Nao impacta materialmente o cliente final em termos absolutos.
- Operadores passam a ver revenue share menos simbolico.
- Trust-Score Premium passa a ter matematica mais defensavel.
- A narrativa de prioridade real fica mais honesta.
- E reversivel por variaveis de ambiente.

Comandos sugeridos:

```bash
ssh kvm4
cd /root/x402
$EDITOR .env
# BASE_PRICE=1000  -> BASE_PRICE=5000
# MAX_PRICE=50000  -> MAX_PRICE=250000
docker compose -f docker-compose.mainnet.yml up -d --force-recreate x402-shield-mainnet
```

O dashboard `/info` deve refletir a alteracao imediatamente apos o restart do container.

## 9. Nao-objetivos

- Nao cobrar minimum mensal fixo do cliente final; isso viola a tese "pague pelo pico".
- Nao criar plano starter free; tende a atrair farmers, nao early adopters.
- Nao ir alem de 20x sem case study.
- Nao complicar com pricing por metodo RPC antes de adocao real.

## 10. Decisao pendente

| Opcao | Risco | ROI |
|---|---|---|
| Manter atual (1x) | Baixo atrito com cliente, alto churn de operador | Quase zero |
| Subir para B (5x) | Medio; alguns clientes podem reclamar | 5x receita imediata |
| Subir para C (10x) | Maior | Paridade mais proxima de RPC pago |
| Adotar E (tiered) | Medio | Narrativa forte, receita similar a B |

Recomendacao direta do estudo: Cenario B agora. Cenario E em segunda iteracao, quando houver pelo menos um contrato real para validar elasticidade-preco.

## Anexo: consideracoes estrategicas

O estudo acerta ao identificar que o preco atual e baixo demais para sustentar uma tese de revenue share. A configuracao atual prova o mecanismo, mas nao prova negocio.

O ponto mais sensivel e o split. Um revenue share de 5% provavelmente significa 5% para o RPC Priority e 95% para o operador. Isso pode facilitar a venda inicial, mas gera captura pequena demais para sustentar a empresa se nao houver volume muito alto.

Uma estrutura mais defensavel:

| Modelo | Split sugerido | Quando usar |
|---|---:|---|
| Operador traz cliente e infra | 10-15% RPC Priority / 85-90% operador | Licenciamento leve |
| RPC Priority traz cliente | 30% RPC Priority / 70% operador | Canal comercial proprio |
| Marketplace gerenciado | 50% / 50% | Billing, suporte, risco e demanda sob responsabilidade do RPC Priority |
| Enterprise | Minimo mensal + usage | Maior previsibilidade |

Recomendacao estrategica: aprovar B como default operacional, manter configuracao por bandas para operadores e evitar 5% puro como modelo de negocio permanente.
