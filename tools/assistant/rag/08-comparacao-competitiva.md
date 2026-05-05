# Comparação competitiva — quem é nós, quem não é

## Tabela executiva

| Provider/Solução | O que faz | Camada | Cobre reads? | Reputation discount? | Status hoje |
|---|---|---|---|---|---|
| **RPC Priority (nós)** | Priority gating per-request via x402 | RPC access | ✅ Sim | ✅ até 50% off | Mainnet validado |
| **Helius** | RPC dedicado + plano fixo | RPC node | ✅ Mas plano fixo | ❌ | Líder mercado |
| **Triton One** | RPC dedicated bare-metal | RPC node | ✅ | ❌ | Tier 1 player |
| **QuickNode** | Multi-chain RPC managed | RPC node | ✅ | ❌ | Multi-chain |
| **Alchemy** | Multi-chain RPC SaaS | RPC node | ✅ | ❌ | Recém-Solana |
| **mainnet-beta público** | RPC grátis Solana Foundation | RPC node | ✅ Mas rate-limited | ❌ | Frágil, 429 fácil |
| **Jito Bundles** | TX bundle landing on-chain | Validator/leader | ❌ | ❌ | Líder MEV |
| **Native priority fees** | ComputeUnitPrice on-chain | Consensus | ❌ | ❌ | Built-in Solana |
| **Stellar Oxide Gateway** | x402 pra APIs HTTP genéricas | Application | n/a (não-RPC) | ❌ "roadmap" | Stellar testnet |

## Detalhe — quem é nós vs cada um

### vs Helius / Triton / QuickNode / Alchemy (RPC dedicated)

**Eles são nosso CLIENTE PRINCIPAL no Plano A**, não competidores frontais. Estratégia: licenciam nosso Shield pra adicionar SKU "priority pago" sem ter que construir.

Por que toparão:
- Plano fixo deles não escala pra agente
- Construir Shield internamente: 6+ meses, sem Trust-Score cross-op
- 90 dias zero rev-share elimina risco financeiro
- Trust-Score Premium ($200-500/mês) é receita recorrente nova pra eles

Risco: implementação interna. Mitigação: spec authority + cross-operator dataset = moat real.

### vs Jito (validator/leader layer)

**Camadas diferentes — não competimos, complementamos.**

| | Jito | Nós |
|---|---|---|
| O que prioriza | Inclusão de TX no bloco | Acesso ao RPC pra ler/escrever |
| Quando se aplica | Só na hora de mandar TX | TODA chamada RPC (read+write) |
| % do tráfego de agente coberto | 5-20% (só TX de saída) | 100% |
| Cobrança | Priority on-chain + Jito tip | Off-chain pay-per-request |
| Identidade | Anônima | Crypto-key + Trust-Score |
| Latência adicional | ~400ms (slot-bound) | 8,7ms p95 |

Cliente MEV usa AMBOS. Cliente read-heavy (indexer, oracle, monitor, wallet backend) usa só nós — Jito não toca.

### vs Native priority fees (ComputeUnitPrice)

**Camadas diferentes.** Native paga inclusão de TX no bloco. Nós pagamos acesso ao RPC pra falar.

| | Native | Nós |
|---|---|---|
| Cobre reads? | ❌ Não | ✅ Sim |
| Cobre writes? | ✅ TX inclusion | ✅ RPC submission |
| Identidade | Anônima | Crypto-key + Trust-Score |
| Pricing | Leilão opaco | Curva linear transparente |
| Cliente fiel | Sem desconto | Até 50% off |

Cliente paga AMBOS, em ordem temporal: nós (acesso RPC) → native (inclusão bloco) → Jito (bundle landing, opcional).

### vs Stellar Oxide Gateway (DoraHacks 42469)

Outra equipe construindo x402 gateway, mas em **Stellar e pra APIs HTTP genéricas** — não RPC Solana.

| | Stellar Oxide Gateway | Nós |
|---|---|---|
| Network alvo | Stellar (testnet) | Solana mainnet (validado) |
| Escopo | API HTTP genérica (AI, datasets, processing) | RPC Solana específico |
| Pricing | Per-request sempre ($0,01-0,03) | Híbrido (livre se carga baixa) |
| Settlement | On-chain a cada request | Off-chain via escrow pré-paga |
| Trust-Score | "roadmap, not built" | Implementado, validado, RFC |
| QoS spec | Não tem | RFC formalizado |
| Anti-sybil | Não | 5 sinais formalizados |
| Validação | Testnet | Mainnet, 1.000+ paid requests |

**Validação de tese cross-team, não competição.** Reforça que x402 é o trilho correto. Possível parceria de spec cross-chain no futuro.

### vs RPC público mainnet-beta (Solana Foundation)

Não-competidor. Eles dão grátis com rate limit brutal — 429 com facilidade. Confirmamos isso no nosso stress test (445/1000 paid requests caíram em 429).

Argumento de venda pro operador: "RPC público dá 429 nos teus clientes. Você roda nosso Shield + RPC dedicado e vende priority como SKU."

## Por tipo de workload — quem ganha

| Workload | RPS | TX on-chain? | Vencedor primário | Empilhar com |
|---|---|---|---|---|
| Indexer / Oracle | Alto | Não | **Nós** (Jito não aplica) | n/a |
| Wallet backend | Alto | Trivial | **Nós** | n/a |
| Agente IA monitoring | Alto | Esporádico | **Nós** | Native priority opcional |
| Bot de liquidação | Alto | Frequente | **Nós** (read priority crítico) | Native + Jito tip |
| Arbitragem multi-leg | Médio | Frequente atômica | Jito (bundle atomicity) | Nós no monitoring |
| MEV searcher HFT | Médio | Muito frequente | **Jito** (latency-critical) | Nós no read |
| Frontrun / sandwich | Baixo (read) | Muito frequente | **Jito** (mempool visibility) | Nós no read |
| Trader 1 TX/semana crítica | Baixo | Raro | Jito tip simples | n/a |

**8 workloads, vencemos 4, eles vencem 3, 1 é AND. Por VOLUME total de tráfego agêntico, nossos 4 representam 80-90%.**

## Onde NÃO competimos (honestidade)

- **HFT pure** com latência <1ms: usem Jito + co-location bare-metal
- **Bundle atomicity** (multi-tx all-or-none): só Jito
- **Mempool visibility / searcher relationships**: só Jito tem
- **Validator-side ordering**: não somos validator
- **Cliente que faz 1 TX/mês crítica**: Jito tip simples é melhor que setup escrow

Reconhecer essas zonas constrói credibilidade. Pitch sem honestidade competitiva queima credibilidade.
