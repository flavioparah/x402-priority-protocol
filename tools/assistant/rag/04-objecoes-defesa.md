# Objeções comuns e respostas defensivas

## OBJ-01: "Solana mainnet hoje aguenta 60-80k TPS, então congestão não é problema"

**Resposta:**
Você está tecnicamente correto sobre o presente. Mas:

1. **Não vendemos pra dor de hoje, vendemos pra dor de amanhã.** Quando agentes IA multiplicarem RPC calls 100× nos próximos 12-24 meses, modelo API key + plano fixo da Helius/Triton **quebra com agente** (rotação de IP, sem cartão, sem contrato mensal).

2. **Mesmo hoje, RPC público dá 429 com facilidade** — confirmamos no nosso stress test mainnet (445 de 1.000 paid requests caíram em 429 do upstream `api.mainnet-beta.solana.com`). RPC privado custa $50-2000/mês fixo. Nosso modelo é per-request, alinhado com uso real.

3. **Read priority é zona cega de TODO mundo.** Native fees pagam TX inclusion, Jito paga bundle landing — nenhum dos dois toca leitura. Pra agente que faz 80-95% reads, nada cobre. **Nós cobrimos.**

## OBJ-02: "Helius/Triton/QuickNode já fazem priority"

**Resposta:**
Eles vendem **plano fixo + API key**. Funciona pra usuário humano com cartão de crédito e contrato mensal. **Quebra pra agente:**

- Agente roda em Lambda/container → IP muda por execução, API key é por IP/conta, não por wallet
- Agente não tem cartão de crédito → não consegue assinar plano
- Agente paga em SOL nativo → nosso modelo é per-request via x402, sem subscription

Nossa estratégia **não é competir frontalmente**, é **vender PRA eles licenciarem nosso Shield** como camada agêntica. Nosso cliente principal é o node-operador, não o cliente final.

## OBJ-03: "E o Jito?"

**Resposta:**
Camadas diferentes — não competimos.

| | Jito (validator/leader) | Nós (RPC) |
|---|---|---|
| O que prioriza | Inclusão de TX no bloco | Acesso ao RPC pra ler/escrever |
| Cobre reads? | ❌ Não | ✅ Sim (80-95% do tráfego agêntico) |
| Cobre writes? | ✅ Bundle landing on-chain | ✅ Acesso pra ENVIAR a TX |
| Custo | Native priority + Jito tip | 1-50 lamports off-chain |

**Os dois empilham.** Cliente MEV usa AMBOS: nós pra read priority + monitoring + simulation; Jito pra TX bundle landing. Se cliente faz só reads (indexer, oracle, monitor), nós somos a única solução — Jito é irrelevante pra ele.

## OBJ-04: "Native priority fees do Solana já não resolve isso?"

**Resposta:**
Não toca o nosso problema.

- Native priority fee = `setComputeUnitPrice` instruction, paga PRA TX SER INCLUÍDA no bloco. Funciona só pra writes.
- 80-95% do tráfego de agente é read (`getAccountInfo`, `getProgramAccounts`, `getSignaturesForAddress`...). Reads NÃO tocam native priority fees.
- Mesmo pra writes, native fee é leilão opaco e não tem reputation discount. Nós temos Trust-Score que recompensa cliente fiel automaticamente.

Cliente paga AMBOS, em ordem: nosso priority pra acessar o RPC → native priority pra TX entrar no bloco → Jito tip se quiser bundle.

## OBJ-05: "Vocês são competidores de Helius, vão ser esmagados"

**Resposta:**
Não somos competidores diretos. Operamos UMA CAMADA ACIMA da Helius. Helius é nosso **cliente alvo no Plano A** — eles licenciam nosso Shield como diferencial.

Por que eles topariam? Porque:
- Modelo deles (plano fixo) está obsoleto pra agente
- Construir nosso Shield internamente custa 6+ meses de eng
- Trust-Score cross-operador NÃO É REPLICÁVEL sem ser broker neutro
- 90 dias zero rev-share elimina risco financeiro deles

Caso eles ignorem: **Plano B** (operador próprio nicho MEV, $1-10k/mês por cliente).

## OBJ-06: "Helius pode implementar isso internamente"

**Resposta:**
Tecnicamente sim. Defesa:

1. **Velocidade**: 9 semanas do zero ao mainnet validado. Eles teriam 6-12 meses + opportunity cost.
2. **Trust-Score cross-operador é o moat real**: efeito de rede tipo Metcalfe. Sem ser broker neutro de N operadores, não dá pra calcular `crossOpScore`, `loyaltyScore`, `sybilRisk` cross-operator. Operador único = score zerado.
3. **Autoridade de spec**: 3 RFCs publicados (x402-priority, trust-score, qos-cooperative). Quem define o padrão controla compatibilidade futura.
4. **Tração**: 1.000+ paid requests em mainnet, leaderboard público. Eles teriam que reconstruir histórico do zero.

## OBJ-07: "Repo está fechado, como avalio o código?"

**Resposta:**
Privado por enquanto pra preservar IP até validação de mercado. Acesso mediante NDA — juízes/parceiros recebem convite por email. Os 3 RFCs em `docs/rfc/` (x402-priority, x402-trust-score, x402-qos-cooperative) são públicos sob CC BY 4.0 — autoridade de spec é parte do moat.

Reference implementation virará open-source sob BUSL-1.1 quando atingirmos 2-3 contratos pagos como prova social. Cronograma: pós-M+6 com gate validado.

## OBJ-08: "Vocês têm token? ICO? Airdrop?"

**Resposta:**
Não. Negócio é SaaS B2B (licença pra node-operadores) + revenue share opcional (5%) + Trust-Score Premium ($200-500/mês). Eventual token só faria sentido se Trust-Score broker virar federation descentralizada — anos de distância, não está no roadmap atual. **Foco é receita real recorrente, não especulação.**

## OBJ-09: "Multi-chain? Outras redes?"

**Resposta:**
Tier 4 (multi-chain) está no roadmap mas **gate-locked em M+6+** — só ataca se Plano A Solana validar com 1+ contrato. Razão: foco diluído mata startup nessa fase.

Quando ativar, ordem provável:
1. **Base** (EVM, Coinbase backing AgentKit, x402 nativo) — primeira EVM
2. Outras EVM L2s: Arbitrum, Optimism, Polygon, BSC (mesmo binary, conf por chain)
3. **Sui + Aptos** (Move, Ed25519 — reusa código Solana)
4. Cross-chain Trust-Score (intra-VM, depois cross-VM)

Análise completa: `docs/PENDENCIAS-ESTRATEGICAS.md`.

## OBJ-10: "Preciso de SOL pra testar — barreira de entrada"

**Resposta:**
ICP nosso (agentes IA, MEV bots, indexadores, backends de wallet) **já tem SOL por definição** — opera em Solana. Quem não tem provavelmente não é nosso cliente direto.

Custos reais:
- Onboarding completo de 1 agente (30 dias): $0,17 USD
- Stress test 1.000 paid requests: $0,032 USD
- 1 priority request: $0,000007 USD

Quem não topa pagar centavos não é early adopter — é farmer. Subsídio escalado a custos imprevisíveis viola tese central.

Modelo de risco zero EXISTE: **primeiros 90 dias zero rev-share** pro node-operator parceiro (ele assume custos, nós só ganhamos quando ele ganha).

Onramp fiat (USDC via MoonPay/Transak) está no roadmap pós-Plano A validado. Não é pré-requisito.

## OBJ-11: "Latência adicional (8,7ms p95) é alta pra MEV"

**Resposta:**
Para HFT puro (microsegundos), você tem razão — Jito + co-location é melhor. **Não somos pra HFT.**

8,7ms p95 é overhead do handshake (402 + signed retry). Comparado a:
- Slot Solana: 400ms (47× nosso overhead)
- Bundle landing Jito: 50-200ms (5-25× nosso overhead)
- Priority fee leilão típico: variável, ~slot inteiro

Pra workload agêntico típico (monitoring, simulação, indexing, liquidação não-HFT), 8,7ms é desprezível. **Pra HFT pure: usem Jito + dedicated RPC.**

## OBJ-12: "Vocês dependem do RPC público mainnet-beta — frágil"

**Resposta:**
Hoje sim. Por design — somos camada de proxy/priority, não validator. Em produção real:

- Operador parceiro (Plano A) usa SEU PRÓPRIO RPC node como upstream — nós só somos middleware
- Pro nosso shield demo (api.rpcpriority.com), upstream é configurável: `REAL_RPC_URL` env var. Trocar pra Helius/Triton paid: 1 linha de config + restart.

A dependência é **opt-in** do operador. Stress test em mainnet bateu nesse limite (445/1000 requests caíram em 429 do público) — isso é argumento DE VENDA pro operador: "nosso Shield + seu RPC dedicado = sem 429."

## OBJ-13: "Stellar Oxide Gateway está fazendo a mesma coisa"

**Resposta:**
Outra equipe construindo x402 gateway, mas em **Stellar e pra APIs HTTP genéricas** (não RPC Solana). Mesmo padrão arquitetural, escopo e chain diferentes.

| | Stellar Oxide Gateway | Nós |
|---|---|---|
| Chain | Stellar (testnet) | Solana mainnet |
| Escopo | APIs genéricas | RPC específico |
| Pricing | Per-request sempre | Híbrido (free se carga baixa) |
| Trust-Score | "roadmap, not built" | Implementado, validado em mainnet |
| RFC | Não tem spec próprio | 3 RFCs publicados |
| Validação | Testnet | Mainnet com 1.000+ paid requests reais |

**Validação de tese, não competição direta.** Reforça que x402 é o trilho correto pra serviços machine-to-machine. Possível parceria de spec no futuro (autoria conjunta cross-chain).

## OBJ-14: "9 semanas é pouco — produto imaturo"

**Resposta:**
9 semanas concentradas, com:
- Mainnet validado end-to-end
- 1.000+ paid requests reais
- Persistência Redis com restart-recovery testado
- Atomic-consume primitive (Lua) com 43/43 testes passando
- 3 RFCs formalizados em produção pública
- 5 sinais de detection de fraude/sybil implementados
- Multi-agent stress test (50 wallets paralelas)

**Maturidade técnica > maturidade calendário.** Comparação: stripe levou ~12 meses pra ter equivalent breadth na fase early. Nós estamos em escala de validação técnica, não escala de mercado — esses são gates separados.

## OBJ-15: "Time pequeno"

**Resposta:**
Founder-led tech. Modelo correto pra essa fase: alta velocidade de execução, baixo overhead. Per `ESTRATEGIA.md`, expansão de time só após gate M+6 validado (1+ contrato Plano A). Antes disso, mais people = mais distração, não mais output.
