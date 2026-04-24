# RPC Priority Protocol — benefícios em uma página

> **x402** — padrão aberto de pagamento HTTP (Coinbase). Não é nosso: é o "trilho" que usamos.
> **RPC Priority Protocol** — nosso produto. Usa o trilho x402 para oferecer prioridade paga em nós Solana.
> **Nó RPC** — o servidor que responde quando um app ou bot fala com a blockchain Solana. Toda IA que conversa com Solana passa por um.

---

## Em uma frase

**Transformamos o spam que trava a rede Solana em receita para o operador e em acesso prioritário para o agente pagador.**

## O problema, em uma analogia

Imagine uma rodovia pública que fica engarrafada todo dia. A defesa de hoje é bloquear placa por placa: ruim para o motorista legítimo que troca de carro (Lambda, container, serverless), e ruim para o operador do pedágio, que só tem prejuízo com o congestionamento. Nós instalamos uma **faixa expressa tarifada**: quem quer prioridade paga, o operador ganha, e a rodovia inteira flui melhor.

## O que o produto faz, em três linhas

1. **Identidade em vez de endereço.** O agente se identifica por uma chave criptográfica (como uma carteira digital), não pelo IP da máquina. Troca de servidor à vontade sem perder o lugar na fila.
2. **Preço que respira com a demanda.** Folgado, passa de graça. Cheio, cobra de quem quer prioridade. Sem bloqueio binário.
3. **Defesa que paga a conta.** Quem quer atacar, paga. A defesa contra spam vira receita para o operador do nó.

## Quem ganha o quê

| **Operador de nó RPC** (Helius, Triton, Jito, nó próprio) | **Desenvolvedor de agentes IA** |
|---|---|
| Spam que era prejuízo vira receita recorrente | Acesso garantido sem API key e sem whitelist de IP |
| Sem precisar caçar atacante manualmente | Troca de infra (Lambda, container) sem perder prioridade |
| Cliente fiel ganha desconto automático (Trust-Score) | Paga só quando precisa — sob carga baixa, passa de graça |
| 5 minutos de deploy — é um proxy reverso, não uma reescrita | Drop-in no `@solana/web3.js` — troca só o construtor |

## Prova de funcionamento (números medidos, não projetados)

- **Overhead do protocolo: 8,7 ms (p95)** sobre uma chamada normal. Meta do nosso próprio pitch era < 50 ms — batemos por 6×.
- **Economia real para cliente fiel: até 50%** de desconto automático via Trust-Score. Medido em produção contra o domínio público: 22 requisições, **26% de economia média** conforme a reputação acumulou.
- **Rodando vivo na internet:** `https://x402.assistent.top` — HTTPS válido, certificado Let's Encrypt, auditável por qualquer pessoa. Código aberto em `github.com/flavioparah/x402-priority-protocol`.

## Mercado e momento

Toda aplicação de IA que fala com Solana passa por um nó RPC. Helius, Triton e Jito — os três principais operadores do ecossistema — já monetizam prioridade, mas através de **planos fixos e API keys**, que não funcionam para agentes modernos que rotacionam infra a cada execução. O RPC Priority Protocol abre um canal **pagável por requisição, sem contrato, sem cadastro** — compatível com qualquer agente de IA de hoje.

Timing:
- **x402 é protocolo novo** (Coinbase publicou em 2024–2025). Janela curta para quem chega primeiro.
- **Solana vive boom de agentes IA** — MCP, DeFi automatizada, bots de arbitragem estão multiplicando o tráfego RPC.
- **Concorrentes recentes do Colosseum** (MCPay e Latinum, ambos vencedores com prêmios de ~US$ 25k) cobram **pela aplicação**. Nós cobramos **pelo acesso à rede**. Raio de impacto muito maior: toda aplicação Solana, não só as que expõem MCP.

## Como nos encaixamos: TAM em uma linha

Bilhões de requisições RPC por mês no ecossistema Solana (Helius sozinho reporta tráfego na casa de bilhões). Se 1% dessas requisições virar prioridade paga a 1 lamport cada, o volume priorizado é de ordem de milhões de dólares/ano — e a camada que intermedia isso cobra uma fração de cada passagem. Somos a primeira implementação com deploy público e medições reais.

## Modelos de negócio — comparativo de risco, receita e investimento

Para cada caminho de monetização há um perfil diferente de risco, potencial de receita e capital necessário para começar.

| # | Modelo | Risco | Receita potencial | Investimento inicial |
|---|--------|:-----:|:-----------------:|:--------------------:|
| 1 | **Nós somos o operador** — operar nós RPC próprios e cobrar agentes diretamente (B2C) | 🔴 Alto | 🟢 Muito alta | 🔴 Alto |
| 2 | **SaaS para operadores** — licenciar o software para Helius, Triton, Jito (B2B) | 🟡 Médio | 🟢 Alta | 🟡 Médio |
| 3 | **Agregador / broker neutro** — rotear agentes entre múltiplos nós habilitados | 🔴 Alto | 🟡 Média | 🟡 Médio |
| 4 | **Open protocol + serviços profissionais** — spec público + monetizar via consulting | 🟢 Baixo | 🟡 Baixa–Média | 🟢 Baixo |
| 5 | **Gestor de reputação** — Trust-Score-as-a-Service cross-operador | 🟡 Médio | 🟢 Média–Alta | 🟡 Médio |

**Detalhamento:**

**Opção 1 — Nós somos o operador (B2C direto)**
Capital intensivo (hardware Solana-grade custa dezenas de milhares de dólares) e competição direta com players já estabelecidos (Helius levantou US$ 25M). Requer equipe de SRE, SLA 24/7 e suporte. Em contrapartida, a margem é total — 100% da receita por requisição vai direto ao operador, sem intermediário.

**Opção 2 — SaaS para operadores (B2B licenciado)**
O melhor equilíbrio risco/retorno para o estágio atual. Sem infra própria: o operador traz os servidores, nós trazemos o protocolo. Receita via licença recorrente ou revenue share (ex.: 5% de cada 402 cobrado). O risco principal é o ciclo de venda B2B mais longo e a possibilidade de operadores forkearem o código open-source. Mitigante: manter o Trust-Score centralizado como moat.

**Opção 3 — Agregador / broker neutro**
Problema chicken-and-egg clássico: precisa de operadores dispostos a participar *e* de agentes dispostos a usar, ao mesmo tempo. Adiciona uma camada de latência no roteamento. Margens de broker são historicamente finas. Volume muito alto pode compensar, mas demanda capital para chegar lá.

**Opção 4 — Open protocol + serviços profissionais**
Menor risco financeiro imediato — o custo principal é o tempo de desenvolvimento já investido. A abertura do spec constrói credibilidade e atrai o ecossistema (exatamente o que o Colosseum valoriza). O lado fraco: consulting não escala; sem receita recorrente previsível. Funciona bem como *estratégia de entrada* antes de monetizar via Opção 2.

**Opção 5 — Gestor de reputação (Trust-Score-as-a-Service)**
Modelo de SaaS de alta margem com efeito de rede: quanto mais operadores aderirem, mais valioso o score de cada agente. Os dados cross-operador formam um *data moat* difícil de replicar. O risco principal é o mercado ainda não existir — requer educação e adoção simultânea de múltiplos operadores para destravar valor.

**Sequência recomendada:** Opção 4 primeiro (abre o protocolo, ganha credibilidade no ecossistema, custo quase zero) → Opção 2 em seguida (monetiza operadores com licença SaaS) → Opção 5 como segunda linha de receita recorrente assim que houver dois ou mais operadores no ar.

---

## Próximo passo

- **Se você é investidor:** toda IA que conversa com Solana vai passar por esta camada. Somos a primeira implementação com deploy público, certificado válido e medições reais. Conversar sobre uma rodada.
- **Se você opera um nó:** 5 minutos de deploy transformam seu nó num ativo que se defende e paga por si. Conversar sobre um piloto.
- **Se você constrói agentes:** troque `new Connection(...)` por `new X402Provider(...)` e seu agente passa na frente da fila. Código aberto, sem fee para experimentar.

---

**Time:** Flávio Furtado (CEO) — Flávio@rpcpriority.com | João Romeiro (CTO) | Felipe Cardoso (DPO)
**Projeto:** submissão Colosseum Frontier Hackathon, abril-maio 2026.
