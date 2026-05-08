# Pitch Slides PT — RPC Priority Protocol

> 7 slides para reunião com investidor ou parceiro brasileiro. Derivado de [`BENEFICIOS.md`](./BENEFICIOS.md). Cada `## Slide N` é um slide — pode virar PPT/Keynote depois, ou projetar direto como documento.

---

## Slide 1 — Capa

> # RPC Priority Protocol
>
> *"Não é um erro — é uma negociação econômica automatizada."*
>
> A camada plugável de prioridade paga para RPCs Solana existentes.

**Time:** Flávio Furtado (CEO) · João Romeiro (CTO) · Felipe Cardoso (DPO)
**Rodando vivo:** três deploys públicos com cert válido —
- `https://x402-mainnet.rpcpriority.com` (mainnet, depósitos verificados on-chain)
- `https://x402-devnet.rpcpriority.com` (devnet, depósitos verificados on-chain)
- `https://x402.rpcpriority.com` (demo de trust-score progressivo)

Código em `github.com/flavioparah/x402-priority-protocol`

---

## Slide 2 — O problema

**Nós RPC da Solana sofrem spam todos os dias.**

- A defesa atual é **bloquear por IP** — ruim para agentes legítimos que rotacionam infra (Lambda, containers, serverless).
- DDoS é **puro custo** para o operador: não dá pra cobrar, não dá pra monetizar.
- Operadores sérios (Helius, Triton, Jito) resolvem isso com **API keys e planos fixos** — modelo que não cabe num agente de IA moderno.

> *Imagine uma rodovia pública que engarrafa todo dia. Hoje a defesa é bloquear placa por placa. Prejudica o motorista legítimo e não gera receita pro pedágio.*

---

## Slide 3 — A solução, em três linhas

**Não bloqueamos. Pedimos pagamento sob carga.**

1. **Identidade em vez de endereço.** Chave criptográfica (como uma carteira digital) substitui o IP. Agente troca de servidor sem perder o lugar.
2. **Preço que respira com a demanda.** Folgado: passa de graça. Cheio: cobra quem quer prioridade. Sem bloqueio binário.
3. **Defesa que paga a conta.** Atacante que quer derrubar o nó passa a pagar o operador por cada tentativa.

O trilho é o **x402** — padrão HTTP aberto da Coinbase, 2024-2025. A implementação é nossa.

**Não substitui RPCs.** Entra como proxy reverso na frente do RPC que o operador já roda.

---

## Slide 4 — Quem ganha o quê

|    | **Operador de nó RPC** | **Desenvolvedor de agentes IA** |
|---|---|---|
| **Receita** | Spam vira receita recorrente | Paga só sob carga — folga é grátis |
| **Operação** | Nada de caçar atacante manualmente | Troca de infra sem perder prioridade |
| **Fidelidade** | Cliente fiel ganha desconto automático | Até 50% off via Trust-Score |
| **Integração** | Deploy plugável (proxy reverso, sem trocar o RPC) | Drop-in em `@solana/web3.js` |

---

## Slide 5 — Prova de funcionamento

**Não são projeções. São medições. 9 semanas, do zero ao mainnet.**

- **8,7 ms** de overhead do protocolo (p95). Meta do pitch era < 50 ms. **Batemos por 6×.**
- **26,1% de economia média** em 22 requisições consecutivas, com o Trust-Score saindo de 0 → 100. Demo pública reproduzível.
- **43 de 43 testes passando** — detection signals, atomic Lua sob Redis, conformidade de spec cooperative QoS.
- **3 deploys ao vivo** com cert Let's Encrypt válido:
  - `x402-mainnet.rpcpriority.com` — **primeira implementação x402 em mainnet**
  - `x402-devnet.rpcpriority.com` — devnet, depósitos verificados on-chain
  - `x402.rpcpriority.com` — demo de trust-score progressivo
- **3 RFCs abertos** que a gente autora: x402-priority, x402-trust-score, x402-qos-cooperative.

```
curl -X POST https://x402-mainnet.rpcpriority.com/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'
HTTP/1.1 402 Payment Required
X-X402-Amount: 40200
X-X402-Trust-Score: 0
```

---

## Slide 6 — Mercado e momento

**Timing é tudo.**

- **x402 é novíssimo.** Coinbase publicou o padrão em 2024-25. Janela curta para quem chega primeiro.
- **Solana vive boom de agentes IA.** MCP, DeFi automatizada, bots de arbitragem multiplicando o tráfego RPC. Helius sozinho reporta bilhões de requisições/mês.
- **Concorrência está na camada de cima.** MCPay e Latinum — ambos vencedores recentes do Colosseum com prêmios de ~US$ 25k — cobram **pelo serviço** (camada de aplicação MCP). Nós aplicamos prioridade e enforcement no acesso ao RPC existente. Raio de impacto incomparavelmente maior.
- **Comparáveis validam a categoria.** Ankr prova que RPC routing/agregação é mercado real; x402.vip prova que x402 para RPC está emergindo. Nosso foco é operador-grade: QoS, Trust-Score, escrow, anti-flood e auditoria.

**TAM:** se 1% das requisições RPC mensais virar prioridade paga a 1 lamport, estamos falando de milhões de dólares/ano circulando pela camada que intermedia.

**Precedente comprovado:** EIP-1559 da Ethereum, que introduziu pagamento por prioridade em 2021, **já queimou mais de US$ 11 bilhões em base fee**. Mercado de prioridade não é hipótese — é realidade. A gente aplica o mesmo princípio um andar acima, na camada de RPC, em vez de blockspace.

---

## Slide 7 — Time e pedido

**Flávio Furtado** — CEO · produto e go-to-market
**João Romeiro** — CTO · arquitetura e engenharia
**Felipe Cardoso** — DPO · blockchain e segurança

> Construído para o Colosseum Frontier Hackathon (abril–maio 2026). **9 semanas de execução, todo o roadmap inicial shippado:**
> MVP · Trust-Score (26,1% economia medida) · 3 RFCs abertos · QoS dual-track · Redis multi-instance · atomic consume Lua · detection v1 (sybil/fraud/churn) · 3 deploys ao vivo · pacote de outreach pra 15 operadores tier 2/3.

**Próximos 90 dias (gate comprimido pós-consultor):**
- **M+1** — outreach intensivo + pitch video publicado
- **M+2** — 2 pilotos fechados em revenue-share (sem fixed fee nos primeiros 90 dias)
- **M+3** — gate: 3+ operadores integrados → segue Plano A com pré-seed; senão, ativa Plano B (operador próprio nicho)

**O que pedimos:**

- **Investidor:** rodada pré-seed de **US$ 150-300k** pra fechar 3 contratos com operadores parceiros nos próximos 90 dias.
- **Operador parceiro:** 30 dias de piloto num nó de produção. Revenue share 70/30 a favor do operador, sem licença fixa.
- **Colosseum:** considerar categoria de *Public Goods* — os 3 specs x402 que a gente autora viram infra pública para operadores RPC do ecossistema Solana.

**Contato:** `rpcpriority.com` · Flávio@rpcpriority.com

---

## Notas de produção (para quem vai apresentar)

- **Tempo-alvo:** 5-7 minutos para a apresentação, 3-5 para Q&A.
- **Slides mais fortes:** 3 (solução) e 5 (prova). Esses dois precisam "pegar".
- **Antes do Slide 5:** abra o terminal ou um celular e rode o `curl` ao vivo. O 402 real na tela vale mais que qualquer slide.
- **Se for investidor sem background cripto:** pare no Slide 2 e desenhe a rodovia num papel antes de seguir. Dedique mais tempo à analogia, menos ao protocolo.
- **Se for operador ou CTO:** pule rápido pelo Slide 3 e passe mais tempo no 4 e 5 (os números).
