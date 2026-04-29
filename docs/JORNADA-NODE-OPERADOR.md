# Jornada do Node-operador

> Documento de produto e go-to-market. Detalha o caminho do **operador de nó RPC Solana** que adota o RPC Priority Protocol para monetizar prioridade. Este é o **cliente principal do Plano A** ([`ESTRATEGIA.md`](./ESTRATEGIA.md)). Para a contraparte (end-user que paga priority fees), ver [`JORNADA-CLIENTE-OPERADOR.md`](./JORNADA-CLIENTE-OPERADOR.md).

---

## Definição

**Node-operador** = quem opera um nó RPC Solana (validator com RPC público, RPC dedicado B2B, ou nó in-house de protocolo) e quer monetizar prioridade durante congestionamento, sem reescrever sua infra.

Ele **instala nosso Shield como proxy reverso** na frente do nó RPC dele. O Shield faz o gating x402 (HTTP 402 + escrow + Trust-Score). Os priority fees vão **para a carteira dele**, não para a nossa. Nós cobramos pelo licenciamento do Shield + Trust-Score Premium + revenue share opcional.

## Personas reais

### Tier 1 — Operadores grandes ($10M+ ARR)
- **Helius** — líder em RPC Solana, ~50% do mercado dev
- **Triton One** — dedicated/bare-metal RPC, foco trading firms
- **QuickNode** — multi-chain, com presença grande em Solana
- **Alchemy** — multi-chain, recém-entrou em Solana

**Características:** já têm pricing API key + plano fixo, equipes grandes, processos lentos de procurement. Resistência alta a adicionar dependências.

### Tier 2/3 — Operadores médios e regionais ($100k–$10M ARR)
- **Quicknode regional** (mercados específicos)
- **Operadores brasileiros** (Yellow Capital, Solbeach, validators tier-100 com RPC público)
- **RPCs especializados** (operadores que servem segmento específico — DeFi only, NFT only)
- **Validators top 200–2000** que ofereçem RPC público como subproduto

**Características:** menos resistência a inovação, ciclo de venda mais curto, dor maior por não ter como Helius escala.

### Tier 4 — In-house de DAOs / protocolos
- **Drift, Pyth, Marinade, Solend** — operam RPC próprio para serviço próprio
- **Wallets** (Phantom, Solflare backend RPC)

**Características:** caso de uso específico, alta urgência durante eventos (liquidação em massa, oráculo update). Adoção mais técnica.

### Tier 5 — Self-hosted developer
- Indie dev rodando 1 validator em casa
- Estudante operando devnet RPC
- DAO pequena

**Características:** zero contract, alta volubilidade. Open source ideal pra eles.

## Quem priorizamos

Pela [`ESTRATEGIA.md`](./ESTRATEGIA.md):

1. **Tier 2/3 primeiro** — menos resistência, ciclo curto, dor maior
2. **Tier 4 (in-house DAOs)** — específico, alta urgência
3. **Tier 1 (Helius/Triton/Jito)** depois de 2-3 referências consolidadas — selo definitivo, ciclo longo
4. **Tier 5** — open source pega de graça

## Por que ele adotaria

### O problema que ele tem hoje

Operador de RPC tem 4 modos de defesa contra abuso, **todos ruins**:

| Defesa atual | Problema |
|---|---|
| **Rate limit por IP** | Quebra com cliente moderno (Lambda, container, agente IA que rotaciona infra) |
| **API key** | Friction de cadastro; sem precificar prioridade real |
| **Bloquear país/ASN** | Falsos positivos altíssimos; clientes legítimos derrubados |
| **Aceitar o spam** | Custo operacional alto, latência ruim pra todo mundo |

**Nenhuma dessas vira receita.** O abuso é só prejuízo.

### O que o Shield resolve

| Antes | Depois |
|---|---|
| Spam é prejuízo | **Spam é receita** (atacante paga pra atacar) |
| Cliente IP-rotacional é DoS-able | Cliente identificado por chave criptográfica — IP irrelevante |
| Cliente fiel paga igual ao novato | **Trust-Score** automaticamente desconta cliente fiel |
| Pricing fixo | Pricing **respira com a demanda** — folga, passa de graça |
| Custo de defesa = OpEx | **Defesa que paga a conta** |

### Métricas concretas que ele ganha

- **Receita nova**: 1–50 lamports/request prioritário × 10–50% do tráfego em pico = receita escala com volume sem aumentar sua infra
- **Redução de churn de cliente fiel**: Trust-Score automático aplica desconto até 50% — cliente recorrente economiza, fica mais
- **Redução de OpEx defensivo**: para de caçar atacante manualmente
- **SKU novo de venda**: "RPC pago por requisição com prioridade" — fora da matriz de planos fixos atual

## A jornada — 6 fases

### Fase 1 — Discovery (1–2 semanas)

Encontra via:
- **Outreach direto nosso** (cold email, LinkedIn, calls com fundadores) — Tier 2/3 prioritário
- **Solana Foundation listing** / Solana Discord
- **Indicação de outro operador** parceiro (referral)
- **Repo público** + RFC nos canais técnicos
- **Pitch em conferência** (Breakpoint, Hackatom)

Ação dele: lê o `BENEFICIOS.md`, abre o repo no GitHub, vê o `architecture.svg`. Se for engenheiro, vai direto pro `index.js` ler como o gating funciona.

**Sinais de qualificação:**
- Tem >100 clientes ativos no RPC dele
- Já se queixou publicamente de abuso/DoS no Twitter ou Discord
- Tem time técnico próprio (consegue avaliar código em <2h)
- Já procurou solução (procurou "Solana RPC abuse" / "Solana RPC priority pricing")

### Fase 2 — Avaliação técnica (3–10 dias)

Ele quer responder 5 perguntas técnicas:

| Pergunta | Onde checar |
|---|---|
| "Quebra meus clientes existentes?" | Demo: shield em modo "passive" (sem 402) — tráfego flui idêntico |
| "Roda no Linux que eu tenho?" | Dockerfile + docker-compose — single binary Node.js |
| "Quão difícil é instalar?" | Doc DEPLOY.md — 5 min em produção típica |
| "Latência adicionada é aceitável?" | Benchmark: 8,7 ms p95 medido. Aceito por <50 ms cliente típico |
| "Posso testar em homologação?" | Devnet shield já existe; ele aponta seu RPC dev pra cá |

**Avaliação comercial paralela:**
- Modelo de receita (ver seção abaixo)
- Conflitos com seus contratos atuais (clientes fixos, SLAs)
- Suporte (24/7? Brasil? Slack compartilhado?)

**Decisão GO/NO-GO em ~2 semanas.** Comparações:
- **Construir do zero** in-house: 6+ meses de eng, sem Trust-Score cross-operador
- **Fork de algo open-source** existente: ninguém implementou x402 + Trust-Score em produção até agora
- **Continuar como está** (status quo): aceita que abuso é prejuízo

### Fase 3 — Piloto (30 dias)

Esse é o **momento mais crítico** comercialmente. Estratégia: **revenue share zero-fixo nos primeiros 90 dias** — operador só paga se nós fizermos ele ganhar.

#### 3a. Setup técnico (1 dia)

```bash
git clone https://github.com/<our-org>/rpc-priority-protocol-server
cd rpc-priority-protocol-server
cp .env.example .env
# Edita: PAYMENT_DESTINATION=<wallet do operador>
#        REAL_RPC_URL=<RPC interno do operador>
#        BASE_PRICE, MAX_PRICE, RPC_LOAD_THRESHOLD
docker compose up -d
```

Aponta domínio dele pra Shield via Traefik/nginx. Tráfego começa a fluir.

#### 3b. Onboarding dos clientes dele (gradual)

Estratégia recomendada:
1. **Semana 1**: Shield em modo passivo (sem 402) — só observa
2. **Semana 2**: Habilita 402 em horário de baixa carga (noite/madrugada)
3. **Semana 3**: 402 habilitado 100%, mas threshold alto (0.9) — só pico mesmo
4. **Semana 4**: threshold ajustado pra economia (0.5–0.75) — equilíbrio entre receita e UX

Cliente dele vê:
- Tráfego idêntico em carga baixa
- Em pico: 402 challenge → integra SDK x402 → paga → continua

Operador comunica via newsletter / blog post: "Agora você pode pagar priority fees em vez de subir plano".

#### 3c. Métricas que ele observa

```bash
# Receita acumulada (volta da carteira dele)
# (consulta direta no Solana Explorer ou via Shield API)
curl https://shield.<operator-domain>/stats/recent

# Clientes pagantes únicos
curl https://shield.<operator-domain>/stats/leaderboard

# Distribuição de cobrança (carga × preço × hits)
curl https://shield.<operator-domain>/stats/qos
```

### Fase 4 — Negociação comercial (após piloto)

Após 30 dias de piloto, ele tem dados concretos. Negociação típica:

| Variável | Range típico |
|---|---|
| **Receita capturada** durante piloto | $50–$5.000/mês (varia muito por tier) |
| **Clientes pagantes** | 5–500 (tier 2/3 típico) |
| **Latência adicional** medida | 5–15 ms p95 |
| **Reclamações de clientes** | 0–3 (geralmente sobre falta de doc, não sobre o conceito) |

Negociação dos termos comerciais (próxima seção).

### Fase 5 — Operação contínua (mês 2+)

Pós-go-live:
- **Suporte de 1ª linha**: equipe dele responde dúvidas de seus clientes (eles são os customers dele)
- **Suporte de 2ª linha**: nós, via Slack compartilhado / email
- **Updates do Shield**: ele faz `git pull && docker compose up -d` — semanal/mensal
- **Pricing tuning**: ele ajusta BASE/MAX_PRICE conforme observa elasticidade dos clientes dele
- **Trust-Score Premium**: opcionalmente assina pra ter dados cross-operador (alguém que pagou no Helius vê o histórico ao chegar nele)

### Fase 6 — Expansão / Saída

**Expansão típica:**
- Adiciona Shield em devnet (é grátis pra ele, vira diferencial)
- Adiciona Shield em multi-region (LatAm, EU)
- Vira referência → leva referrals pra outros operadores

**Saída:**
- Operador foi adquirido (ex: Helius compra um Tier 2) — geralmente o adquirente mantém Shield
- Operador faliu (raro)
- Decidiu construir solução própria — possível, mas perde Trust-Score cross-operador (nosso moat)

## Modelo comercial — opções de receita

Conforme [`ESTRATEGIA.md`](./ESTRATEGIA.md), 3 streams complementares:

### Stream 1 — Licença SaaS por instância

| Tier | Volume mensal | Preço |
|---|---|---|
| **Starter** | < 10M req/mês | US$ 500/mês |
| **Growth** | 10M–100M req/mês | US$ 1.500/mês |
| **Scale** | 100M–1B req/mês | US$ 3.000/mês |
| **Enterprise** | >1B req/mês | US$ 5.000+/mês (custom) |

Inclui:
- Licença de uso comercial do Shield (BUSL-1.1 → comercial requer license)
- Suporte por email / Slack compartilhado
- Updates regulares
- 1 ambiente de homologação grátis (devnet)

### Stream 2 — Revenue share opcional

**Alternativa ou complemento à licença:** **5% de cada 402 cobrado pelo operador.**

Como funciona:
- Shield reporta a receita capturada via endpoint protegido (`/stats/billing`)
- Cobrança mensal automática (ou settlement on-chain via fee_routing param futuro)
- Disponível em tiers premium ou substituindo licença em early-stage

**Vantagem pro operador:** zero risco. Só paga se nós fizermos ele ganhar.
**Vantagem pra nós:** alinhamento total — quanto mais ele lucra, mais nós lucramos.

### Stream 3 — Trust-Score Premium

**US$ 200–500/mês adicional por operador** para:
- Acesso ao dataset cross-operador (`crossOpScore`, `loyaltyScore`, `sybilRisk`, `fraudAlert`)
- Webhook de fraude em tempo real (ex: pubkey vista em 5 operadores em 1h = sybil alert)
- API de attestation (operadores trocam reputação assinada)
- Dashboard agregado entre operadores

Esse é **o moat principal** ([`ESTRATEGIA.md`](./ESTRATEGIA.md) §4): não é replicável sem ter sido o broker neutro durante o período. Cada operador novo aumenta o valor pros outros (efeito de rede Metcalfe-like).

### Termo "first 90 days free"

Pra reduzir resistência inicial, oferecer:
- **Primeiros 90 dias**: 0% revenue share, 0% licença. Só paga Trust-Score Premium se quiser.
- **Após 90 dias**: ativa o tier negociado.

Reduz risco a zero pro operador. Ele só paga se nós fizermos ele ganhar.

## Comparação concorrencial

| Solução | Como ele monetiza prioridade hoje? |
|---|---|
| **Helius** | Plano Business ($499/mês) — 100M req/mês fixo, sem priority dinâmico |
| **Triton** | Custom enterprise — geralmente $2k–10k/mês com SLA, sem dinâmico |
| **QuickNode** | Plano Build ($299/mês) — também fixo |
| **Alchemy** | Plano Growth ($300/mês+) — fixo |
| **Validator solo** | Não monetiza. RPC público é cortesia/perda |
| **Com RPC Priority** | **Receita por request prioritário** — escala automaticamente com demanda, sem aumentar plano |

Vantagem competitiva única: **somos a ÚNICA solução onde o operador captura receita do PICO** sem precisar projetar capacidade pra pico. Os planos fixos forçam o operador a comprar mais infra "pra caso precisar". O Shield faz a infra existente cobrar mais quando precisar.

## Risco principal: fork do código

**Operador faz fork do nosso código e nos corta.** Risco real porque BUSL-1.1 dá brecha em interpretação.

**Mitigação técnica:** Trust-Score centralizado continua nosso. Cada operador que tenta operar sem nós perde:
- Acesso ao dataset cross-operador
- API de attestation
- Webhook de fraude
- Que é o que permite o **desconto automático de cliente fiel** — feature mais valiosa pro cliente final

Operador que fork sem licença oferece um produto **inferior** (sem Trust-Score cross-operador). Cliente final percebe.

**Mitigação comercial:** primeiro contrato é estratégico, não financeiro. Damos rev-share zero pelos 90 dias, mas garantimos lock-in via:
- Integração no billing dele
- Brand co-marketing
- Slack compartilhado
- Roadmap input

## Friction points conhecidos

1. **Operador médio não tem Solana wallet pra receber priority fees** — precisamos onboardar wallet treasury setup junto. Tarefa: doc operacional dedicado.
2. **Compliance/contábil** — receita em SOL volátil, contabilidade fiscal complica. Tarefa: integrar com Lulla / serviço de off-ramp automático.
3. **Suporte multi-tenant** — quando temos 10 operadores, suporte ad-hoc não escala. Tarefa: portal de tickets dedicado.
4. **Concorrência futura** — Helius/Triton podem implementar isso internamente. Tarefa: ganhar 2-3 referências consolidadas antes deles olharem pro problema.

## Tempo total da jornada

| Fase | Tempo |
|---|---|
| Discovery | 1–2 semanas |
| Avaliação técnica | 3–10 dias |
| Piloto | 30 dias |
| Negociação comercial | 1–2 semanas |
| Onboarding produção | 1 mês |
| Operação contínua | infinito (queremos LTV alto) |

**Ciclo completo discovery → contrato pago: ~3 meses no Tier 2/3, 6+ meses no Tier 1.**

## Sequência de execução (próximos 90 dias)

Conforme [`ESTRATEGIA.md`](./ESTRATEGIA.md):

- **M+1**: open-source do spec (não do código todo) com tag v0.1. Consolida autoridade.
- **M+2**: primeiro piloto com operador parceiro brasileiro (split 70/30 a favor do operador, sem licença fixa).
- **M+3**: caso de uso documentado (latência medida + receita capturada) → começar outreach a tier 2.
- **M+6**: gate de decisão. Se nenhum contrato pago fechado, ativar Plano B (operador próprio em nicho).

## Ver também

- [`ESTRATEGIA.md`](./ESTRATEGIA.md) — Plano A vs B + análise de moat
- [`JORNADA-CLIENTE-OPERADOR.md`](./JORNADA-CLIENTE-OPERADOR.md) — quem usa o RPC do node-operador
- [`BENEFICIOS.md`](./BENEFICIOS.md) — pitch de uma página
- [`outreach/OPERATOR-PITCH.md`](./outreach/OPERATOR-PITCH.md) — script de cold outreach
- [`outreach/OPERATORS-LIST.md`](./outreach/OPERATORS-LIST.md) — lista mapeada de tier 2/3 BR + LatAm + EU
