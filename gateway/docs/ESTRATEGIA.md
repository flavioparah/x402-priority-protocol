# Estratégia — RPC Priority Protocol

> **Documento interno.** Visão estratégica para discussão com consultor do Colosseum e alinhamento entre fundadores. Não é material de pitch — para investidor/parceiro, ver [`BENEFICIOS.md`](./BENEFICIOS.md).
>
> Última atualização: 2026-04-25.

---

## TL;DR

- **Onde sentamos:** camada de RPC, *antes* do validador. Não competimos com Jito, MEV ou priority fees nativas — operamos uma camada acima, onde toda aplicação Solana passa.
- **Plano A:** **SaaS B2B para operadores de nó** (Helius/Triton/Jito + tier 2/3) com Trust-Score centralizado como moat. Janela de 6 meses para primeiro contrato.
- **Plano B:** **Operador próprio focado em nicho** (arbitradores, liquidadores, NFT snipers). Ativado se Plano A não fechar contrato até M+6.
- **Moat defensível:** Trust-Score cross-operador (efeito de rede em dados) + autoridade no spec x402 + relacionamentos com operadores. Código sozinho não defende — é open source por design.

---

## 1. Onde sentamos no stack (correção de uma confusão comum)

| Camada | O que faz | Quem está lá | Modelo de cobrança | **Nós?** |
|---|---|---|---|---|
| **Aplicação** | MCP servers, dApps, bots | MCPay, Latinum, Jupiter, Phantom | Por serviço | Não |
| **RPC** ← | Servir reads/writes pra app falar com a chain | Helius, Triton, Jito-RPC, nós próprios | API key + plano fixo | **Sim** |
| **Validator/Leader** | Ordering on-chain, inclusão de tx no bloco | Validadores, Jito-Bundles, searchers | Priority fees, MEV | Não |

**Por que isso importa:** quem só lê título do projeto assume que somos concorrente de Jito/MEV. Não somos. Eles trabalham *dentro* do bloco. Nós trabalhamos *na conversa que monta o bloco*. Mercados diferentes, clientes diferentes.

**Implicação:** priority fees nativas da Solana **não nos canibalizam** — elas servem transações; 80%+ do tráfego RPC são reads (`getSlot`, `getAccountInfo`, `getProgramAccounts`) que não pagam priority fee e onde a saturação realmente dói.

---

## 2. Plano A — SaaS B2B para operadores de nó

### O que é
Licenciamos o RPC Priority Protocol (server + Trust-Score backend) para operadores de nó existentes. O operador instala em 5 minutos como proxy reverso, mantém sua infra atual, e ganha um novo SKU: "RPC pago por requisição com prioridade".

### Modelo de receita
- **Licença SaaS:** US$ 500–5.000/mês por operador (tiered por volume)
- **Revenue share:** 5% de cada 402 cobrado pelo operador (alternativa ao SaaS, ou somado em tiers premium)
- **Trust-Score Premium:** US$ 200–500/mês por operador para acesso a dados cross-operador (dados do agente em outros operadores)

### Cliente alvo (em ordem)
1. **Tier 2/3 operadores** (Quicknode, Alchemy regional, operadores brasileiros) — menos resistência, ciclo de venda mais curto, dor maior por não ter como Helius escala
2. **Helius/Triton/Jito** — só depois de 2-3 referências consolidadas. Ciclo longo, mas selo definitivo
3. **Operadores in-house de DAOs/projetos** (Drift, Pyth, Marinade) — caso de uso específico, alta urgência

### Sequência (próximos 90 dias)
- **M+1:** open-source do spec (não do código todo) com tag v0.1. Consolida autoridade.
- **M+2:** primeiro piloto com operador parceiro brasileiro (split de receita 70/30 a favor do operador, sem licença fixa nos primeiros 90 dias).
- **M+3:** caso de uso documentado (latência medida + receita capturada) → começar outreach a tier 2.
- **M+6:** **gate de decisão**. Se nenhum contrato pago fechado, ativar Plano B.

### Risco principal e mitigação
- **Operadores fazem fork do código e nos cortam.** Mitigante: **Trust-Score centralizado** continua nosso. Cada operador que tenta operar sem nós perde acesso aos dados cross-operador, que é o que permite o desconto de cliente fiel automático.
- **Ciclo de venda B2B muito longo.** Mitigante: começar com revenue share zero-fixo nos 90 primeiros dias — operador só paga se nós fizermos ele ganhar.

---

## 3. Plano B — Operador próprio focado em nicho

### O que é
Se Plano A não fechar contrato até M+6, viramos nós mesmos um operador de nó RPC, **mas focado em um único segmento de altíssimo valor**: arbitradores DeFi, liquidadores e bots de MEV que já pagam US$ 10k+/mês por latência previsível.

### Por que faz sentido como fallback
- **Cliente já existe e já paga.** Não precisamos criar mercado.
- **Capital reduzido vs. Opção 1 ampla:** ao invés de competir com Helius em volume genérico, atendemos 50–200 clientes pagantes em um único caso de uso.
- **Validação imediata da tese sem depender de terceiros.** Roda com nossa própria infra, nosso próprio Trust-Score, nossas regras.
- **Caminho de volta para Plano A:** uma vez com receita comprovada, qualquer operador escuta — viramos referência em vez de ofertante.

### Modelo de receita
- US$ 1.000–10.000/mês por cliente (tier por volume + SLA garantido)
- Cobrança híbrida: assinatura fixa + 402 sob carga

### Custo inicial estimado
- 2 RPC nodes Solana mainnet bare-metal: ~US$ 3-5k/mês
- 1 SRE meio-período: ~US$ 4k/mês
- Suporte 24/7 inicial via founders: zero
- **Break-even ~10 clientes pagantes** a US$ 1k/mês cada

### Risco principal e mitigação
- **Helius/Triton têm escala que não temos.** Mitigante: focar em SLA garantido com penalidade — o que eles não vendem hoje. Nicho de bots paga premium por garantia, não por volume.

---

## 4. Análise de barreiras à cópia (moats) — 6 camadas

| Ativo | É o moat? | Quão difícil de copiar | Por quê |
|---|---|---|---|
| **Código do server** | ❌ Não | Trivial | Open-source por design. x402 é spec pública. |
| **SDK cliente** | 🟡 Parcial | Médio | Switching cost mínimo. Drop-in `@solana/web3.js`. |
| **Trust-Score centralizado** | ✅ **Sim — o principal** | **Muito alto** | Efeito de rede em dados. Cada operador que entra aumenta valor para os outros. Novo entrante começa com zero histórico. |
| **Autoridade no spec x402-priority** | ✅ Sim | Alto | Quem define o RFC controla compatibilidade. Padrão é precedente, não código. |
| **Relacionamentos com operadores** | ✅ Sim (Plano A) | Alto | Contratos B2B criam switching cost real (integração, contabilidade, suporte). |
| **Marca / reconhecimento** | 🟡 Parcial | Médio | Frágil sem case study. Forte com 2-3 referências de peso. |
| **Operacional (rodar RPC)** | ❌ Não (Plano B) | Médio | Helius/Triton fazem isso 10× melhor que jamais faremos. |

### As 6 camadas do moat técnico (detalhamento)

#### Camada 1 — Dataset bruto

A cada evento de pagamento, gravamos: `{pubkey, operator_id, timestamp, amount_lamports, rpc_method, load_at_request, score_before, ip_country, signature, on_chain_tx}`.

**Volume estimado:** se 1% das req/mês da Solana virarem 402, são ~10M de eventos/mês = **120 GB de dataset comportamental em 12 meses**, não replicável sem ter sido o broker neutro durante o período.

#### Camada 2 — Aggregates não-replicáveis sem visão cross-operador

| Métrica | Operador único calcula sozinho? |
|---|---|
| `score(pubkey)` | ✅ Sim (não é o moat) |
| `crossOpScore = log₂(operadores_distintos) × paidCount` | ❌ Só nós |
| `loyaltyScore(pubkey, op) = paidCount[op] / totalPaidCount` | ❌ Só nós |
| `churnPattern(pubkey)` | ❌ Só nós |
| `sybilRisk(pubkey)` (mesmo pubkey em N operadores em janela curta) | ❌ Só nós |
| `fraudAlert(pubkey)` (spam multi-operador em 24h) | ❌ Só nós |

#### Camada 3 — Math do efeito de rede (Metcalfe-like)

- Nossa rede com N operadores: **valor total ∝ N²**
- Concorrente (Jito) com 1 operador (próprio): **valor ∝ 1²**
- Em N=5, vantagem relativa = **25×**
- Helius/Triton **não vão** entregar dados de cliente pra Jito (concorrente direto). Jito fica preso em N=1.

#### Camada 4 — Switching cost de operador integrado

- Cada operador investiu meses em integração SDK + treino de suporte + montagem contábil
- Sair custa **tanto quanto entrou**
- Ainda perde acesso ao histórico de Trust-Score que ajudou a construir

#### Camada 5 — Standard authority (RFC)

- Autores do *x402-priority subprotocol* RFC controlam evolução
- Concorrente que implementar precisa pedir interop ou fragmentar ecossistema (politicamente caro)
- Como Coinbase com x402, ou Anthropic com MCP

#### Camada 6 — Riscos do moat (honesto)

| Risco | Probabilidade | Mitigação |
|---|---|---|
| 2+ operadores grandes saem simultaneamente | Baixa | Contratos anuais com penalidade |
| Regulação força data localization | Média | Multi-region + dados anonimizados |
| Concorrente faz M&A pra forçar switch | Baixa-Média | Acquisition-protection (Plano C) |
| Hack do DB Trust-Score | Baixa | Audit logs + dados anonimizados |
| RPC vira commodity total | Baixa-Média | Pivot para fraud-detection-as-a-service |

### Paralelos no mundo real (todos extremamente defensáveis)

| Empresa | Camada | "Operadores" | "Clientes" |
|---|---|---|---|
| **Visa** | Pagamentos | Bancos | Lojistas |
| **Plaid** | Open banking | Bancos | Apps fintech |
| **Equifax** | Crédito | Credores | Tomadores |
| **DTCC** | Settlement | Corretoras | Clientes finais |
| **Nós** | RPC priority | Operadores Solana | Agentes IA |

Característica comum: infraestrutura "feia", não excitante pra leigo, **extremamente defensável**. Visa nunca virou banco; Plaid nunca virou fintech. Vivem da **neutralidade**.

**Insight central:** **código é commodity, dados são moat.** Devemos abrir o spec e o server (gera adoção), mas guardar o **Trust-Score backend** centralizado. É o único pedaço onde temos vantagem composta com o tempo.

**Defesa secundária:** ser o autor do RFC. Como Coinbase com x402 (que abriu mas controla a evolução), nós somos os autores do *x402-priority subprotocol* — qualquer concorrente que tentar implementar tem que pedir interop a nós.

---

## 5. Decisão sobre o que abrir e o que fechar

| Componente | Estado | Justificativa |
|---|---|---|
| Spec x402-priority (RFC + esquema de challenge/response) | **Abrir 100%** | Maximiza adoção. Quanto mais aplicações implementam, maior nosso TAM. |
| Server (proxy reverso, validação de assinatura, escrow) | **Abrir 100%** | Reduz fricção de adoção dos operadores. Sem moat aqui de qualquer forma. |
| SDK cliente (`X402Provider`) | **Abrir 100%** | Idem. Drop-in compatibility é nossa arma de adoção. |
| **Trust-Score backend (database + algoritmo + API cross-operador)** | **Fechar** | Único moat composto. Operadores integram, não copiam. |
| Dashboards / analytics para operadores | **Fechar** | SaaS premium. |

---

## 6. Sequência tática — próximos 90 dias (timeline COMPRIMIDO)

> **Mudança pós-consultor (2026-04-25):** consultor do Colosseum apontou risco de Jito construir produto similar em 6 meses. Resposta: **comprimir gate de M+6 → M+3**. Lock-in com 3+ operadores antes que qualquer concorrente decida competir muda o cálculo deles de "construir" para "comprar". Detalhes da defesa em [`FAQ-DEFENSIVO.md` A.8](./FAQ-DEFENSIVO.md).

```
M+0  ████████████████████████████  Hoje (2026-04-25)
M+1  ━━ Spec v0.1 publicado + RFC em processo (autoridade no padrão)
     ━━ Pitch video gravado e publicado
     ━━ Outreach a 15 operadores tier 2/3 (BR + LATAM + Europa) ← 3× o número anterior
     ━━ Devnet companion deployment ao vivo (x402-devnet.rpcpriority.com)
M+2  ━━ 2+ pilotos fechados (revenue share 70/30, sem fixed fee, 90 dias)
     ━━ Trust-Score backend isolado em serviço próprio
     ━━ Case study #1 publicado (latência + receita do primeiro piloto)
M+3  ━━ GATE COMPRIMIDO: 3+ operadores integrados?
       ├── SIM  → Plano A continua, levantar pré-seed (US$ 150-300k)
       │           Outreach formal a Helius/Triton/Jito com case study consolidado
       └── NÃO  → Ativar Plano B (operador próprio nicho)
M+6  ━━ Marco secundário: 5+ operadores OU primeiro contrato pago de tier 1
M+12 ━━ MRR US$ 50-200k OU pivô material (Plano C)
```

**Por que M+3 e não M+6:**
- Cada mês sem operador integrado = mês a mais de exposição a Jito/Helius decidirem competir
- Trust-Score com 3+ operadores cria efeito de rede mensurável (saímos de N=1 para N²=9 em valor relativo)
- Switching cost de operador integrado começa a se acumular — quanto mais cedo, melhor
- 3 operadores em piloto = ativo de aquisição da ordem de US$ 5-30M (Plano C)

---

## 7. FAQ Defensivo

O FAQ completo (~25 perguntas detalhadas, cobrindo mercado, tecnologia, negócio, time e cenários de risco) está em [`FAQ-DEFENSIVO.md`](./FAQ-DEFENSIVO.md). Para a reunião com consultor, levar impresso. Algumas das perguntas mais críticas:

- A.1 Por que vocês e não Helius constrói isso?
- A.2 O que impede Helius de copiar em 3 meses?
- A.3 Vocês competem com Jito ou MEV?
- A.4 Se a Solana adicionar RPC priority na infra, vocês morrem?
- B.1 Como funciona o Trust-Score tecnicamente?
- B.5 E se o operador receber pagamento e não dar prioridade?
- C.6 E se vocês falharem em fechar o primeiro contrato em 6 meses?
- E.2 Em que ponto vocês desistem?

Termos técnicos usados em respostas estão definidos em [`GLOSSARIO.md`](./GLOSSARIO.md). Roteiro do pitch falado está em [`PITCH-SCRIPT-PT.md`](./PITCH-SCRIPT-PT.md).

---

## 8. Sinais que Plano A está funcionando (M+3 a M+6)

✅ **Bons sinais:**
- 2+ operadores tier 2 em piloto ativo
- Pelo menos 1 operador pediu Trust-Score Premium (diferenciação cross-operador)
- Métrica de retenção do agente no operador piloto > 60%
- Reunião agendada com 1 dos top 3 (Helius/Triton/Jito)

❌ **Sinais de virada para Plano B:**
- Zero contratos pagos após 5+ outreaches a tier 2
- Operadores piloto desinstalam após 30 dias
- Helius ou Triton anunciam produto similar nativo
- Solana foundation publica RFC de RPC priority on-chain

---

## 9. Time e ownership da estratégia

| Pessoa | Responsabilidade primária |
|---|---|
| **Flávio (CEO)** | Outreach a operadores, fechamento de pilotos, fundraising |
| **João (CTO)** | Spec, Trust-Score backend, qualidade técnica das integrações, autor + maintainer dos RFCs x402-priority + x402-trust-score + x402-qos-cooperative |
| **Felipe (DPO)** | Compliance, legal de contratos B2B, governança do RFC aberto |

**Decisão crítica em consenso:** ativação do Plano B é decisão dos três fundadores em M+3 (gate comprimido). Ativação do Plano C (aquisição) é decisão dos três fundadores a qualquer momento.

---

## 10. Sinais de aceleração (modo sprint imediato)

Três cenários ativam **modo sprint** — todos os recursos canalizados para fechar operadores rapidamente, sem se preocupar com receita imediata:

| Sinal | O que faz | Resposta |
|---|---|---|
| **Jito anuncia produto similar** | Janela de oportunidade fecha | Acelerar pra 5 operadores em 60 dias, contatar Jito sobre acquisition |
| **Helius adquire concorrente** ou levanta nova rodada com tese parecida | Eles podem comprar nosso espaço | Outreach intensivo a Triton/Jito pra fechar antes |
| **Solana Foundation publica RFC nativo de RPC priority** | Comoditização ameaça | Posicionar como implementação de referência + pivot de Trust-Score para reputation oracle |

---

## 11. Plano C — Saída via aquisição

> **Quando ativamos:** se Jito ou Helius anunciar produto similar com tração visível em qualquer momento até M+12, ou se MRR ficar abaixo de US$ 30k mesmo com 3+ operadores em M+9.
>
> **Por que faz sentido:** o moat não depende de Jito/Helius **não construírem**. O moat depende de termos **3+ operadores integrados antes de qualquer concorrente decidir competir**. Nesse ponto, o cálculo deles muda de "construir" para "comprar".

### Valor de aquisição estimado por estágio

| Estado | Valor estimado | Argumento |
|---|---|---|
| 0 operadores integrados | US$ 0 (eles constroem) | Sem ativo defensável |
| 1-2 operadores integrados | US$ 1-3M (acquihire) | Time + spec, mas sem rede |
| **3-5 operadores integrados + Trust-Score data** | **US$ 5-30M (estratégica)** | Rede neutra com efeito de rede + dataset cross-op |
| 5+ operadores + RFC autoria | US$ 30-100M (infra crítica) | Padrão de fato + relacionamentos B2B |

### Compradores prováveis e fit estratégico

| Comprador | Por que comprariam | Probabilidade |
|---|---|---|
| **Jito Labs** | Adicionar camada de RPC priority ao stack (eles têm bundles + ShredStream + RPC). Trust-Score complementa o que eles já fazem com searchers. | Alta se decidirem entrar nesse mercado |
| **Helius** | Eliminar disrupção do modelo de plano fixo, absorver o "broker neutro" antes que vire concorrente. | Média — eles preferem comprar feature antes que feature comprometa pricing |
| **Triton** | Reativo à movimentação de Helius/Jito. Ângulo defensivo. | Média |
| **Coinbase / Base** | x402 é deles. Comprar o player que está validando a tese deles na Solana é defensível. | Baixa-Média (não focam em Solana hoje) |
| **a16z crypto / Multicoin (acqui-bridge)** | Bundle com outra investida. | Baixa |

### Ações para preservar valor de aquisição

1. **Contratos exclusivos com operadores** — não dual-license. Operador escolhe nós ou outro.
2. **Dataset proprietário** — Trust-Score backend totalmente fechado, audit logs internos.
3. **Marca registrada** — `RPC Priority Protocol` como trademark, domínio `rpcpriority.com` com proteção de marca.
4. **Time travado em vesting + contratos B2B** — comprador valoriza retenção de equipe + clientes ativos.
5. **Documentação operacional limpa** — diligência rápida = aquisição rápida = valor maior.

### Divisão dos founders em cenário de aquisição

- Vesting de 4 anos com 1 ano de cliff (já em vigor)
- Em caso de aquisição antes de M+24, **acceleration de 50% do remaining vesting** — padrão Silicon Valley
- Decisão de aceitar oferta requer consenso dos 3 fundadores (mesmo que valor "alto")

---

**Próxima revisão deste documento:** M+1 (após primeiro outreach completo) ou no caso de mudança material no contexto (concorrente lança produto similar, Solana publica RFC nativo, Colosseum classifica em finalistas).

---

## 12. Tier expansion — de "RPC priority middleware" para "trust layer for AI agents"

> **Princípio de framing:** expandir a narrativa conforme a execução confirma a tese, não vender o Tier 4 hoje.

### Tiers em uma tabela

| Tier | Capacidade | Audiência VC | Ticket pitch |
|---|---|---|---|
| 1 (hoje) | Single-operator pricing discount | Pré-seed | US$ 150-300k |
| 2 (M+6) | Cross-operator reputation, sybil/fraud signals | Seed expansão | US$ 1-3M |
| 3 (M+12-24) | Trust-Score-as-a-Service (lending, insurance, marketplace) | Series A | US$ 5-15M |
| 4 (M+24+) | Universal AI agent passport cross-chain | Series B+ | US$ 25-50M+ |

### Diagrama das camadas

```text
Tier 4  Universal AI agent passport cross-chain
   |
Tier 3  Trust-Score-as-a-Service
   |
Tier 2  Cross-operator reputation oracle
   |
Tier 1  Single-operator pricing discount
```

### Pitch evolution

- **Tier 1, pré-seed:** vendemos o desconto por prioridade e a redução de spam no RPC.
- **Tier 2, seed expansão:** vendemos reputação cross-operator, antifraude e sinais de sybil.
- **Tier 3, Series A:** vendemos score de agente para lending, insurance e marketplace.
- **Tier 4, Series B+:** vendemos identidade e reputação portátil cross-chain.

### Leitura estratégica

O produto já começou em Tier 1 porque é onde o cliente paga mais rápido e onde a dor é concreta. A visão, porém, é maior: a mesma infraestrutura vira a camada de confiança da economia de agentes IA na Solana e, depois, fora dela. O erro seria vender Tier 4 antes de provar Tier 1, 2 e 3 com dados.

---

## 13. QoS dual-track — standalone production + cooperative spec

### Path A: standalone

- Fila de prioridade + dispatcher rate-limited dentro do shield.
- Implementação interna, sem dependência de adoção externa.
- Ship em aproximadamente 2 semanas.
- Deploy nos 3 shields de produção.

### Path B: cooperative

- RFC spec + interface flag-based pronta para integrar com o stack do operador parceiro.
- Spec ready-to-ship.
- Operador parceiro integra em 2-3 dias quando aceitar piloto.

### Por que os dois

- Path A evita dependência de terceiros e valida valor em produção.
- Path B acelera negociação do Plano A porque reduz atrito de integração.
- Os dois juntos criam prova técnica e prova comercial ao mesmo tempo.

### Sequência de execução

- **Semana 1-2:** Path A em produção.
- **Semana 3:** Path B com spec, switch e reference implementation.

### Conexão com Redis

O passo natural de evolução é sair da fila em memória para `ZADD` em Redis Sorted Set quando a migração exigir coordenação mais forte entre múltiplos workers ou instâncias. Isso mantém a semântica de prioridade sem reescrever a política de despacho.
