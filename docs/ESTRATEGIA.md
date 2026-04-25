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

## 4. Análise de barreiras à cópia (moats)

| Ativo | É o moat? | Quão difícil de copiar | Por quê |
|---|---|---|---|
| **Código do server** | ❌ Não | Trivial | Open-source por design. x402 é spec pública. |
| **SDK cliente** | 🟡 Parcial | Médio | Switching cost mínimo. Drop-in `@solana/web3.js`. |
| **Trust-Score centralizado** | ✅ **Sim — o principal** | **Muito alto** | Efeito de rede em dados. Cada operador que entra aumenta valor para os outros. Novo entrante começa com zero histórico. |
| **Autoridade no spec x402-priority** | ✅ Sim | Alto | Quem define o RFC controla compatibilidade. Padrão é precedente, não código. |
| **Relacionamentos com operadores** | ✅ Sim (Plano A) | Alto | Contratos B2B criam switching cost real (integração, contabilidade, suporte). |
| **Marca / reconhecimento** | 🟡 Parcial | Médio | Frágil sem case study. Forte com 2-3 referências de peso. |
| **Operacional (rodar RPC)** | ❌ Não (Plano B) | Médio | Helius/Triton fazem isso 10× melhor que jamais faremos. |

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

## 6. Sequência tática — próximos 90 dias

```
M+0  ████████████████████████████  Hoje (2026-04-25)
M+1  ━━ Spec v0.1 publicado + RFC em processo
     ━━ Pitch video gravado e publicado
     ━━ Outreach a 5 operadores tier 2/3 (BR + LATAM)
M+2  ━━ Primeiro piloto fechado (revenue share 70/30, sem fixed fee)
     ━━ Trust-Score backend isolado em service próprio
M+3  ━━ Case study publicado (latência + receita do piloto)
     ━━ Outreach formal a Helius/Triton/Jito
M+6  ━━ GATE: contrato pago fechado?
       ├── SIM  → Plano A continua, levantar pré-seed
       └── NÃO  → Ativar Plano B, virar operador próprio em nicho
```

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
| **João (CTO)** | Spec, Trust-Score backend, qualidade técnica das integrações |
| **Felipe (DPO)** | Compliance, legal de contratos B2B, governança do RFC aberto |

**Decisão crítica em consenso:** ativação do Plano B é decisão dos três fundadores em M+6. Não é decisão unilateral.

---

**Próxima revisão deste documento:** M+1 (após primeiro outreach completo) ou no caso de mudança material no contexto (concorrente lança produto similar, Solana publica RFC nativo, Colosseum classifica em finalistas).
