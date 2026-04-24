# Pitch Slides PT — RPC Priority Protocol

> 7 slides para reunião com investidor ou parceiro brasileiro. Derivado de [`BENEFICIOS.md`](./BENEFICIOS.md). Cada `## Slide N` é um slide — pode virar PPT/Keynote depois, ou projetar direto como documento.

---

## Slide 1 — Capa

> # RPC Priority Protocol
>
> *"Não é um erro — é uma negociação econômica automatizada."*
>
> A camada de prioridade paga para a economia de agentes na Solana.

**Time:** Flávio Furtado (CEO) · João Romeiro (CTO) · Felipe Cardoso (DPO)
**Rodando vivo:** `https://x402.assistent.top` — código em `github.com/flavioparah/x402-priority-protocol`

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

---

## Slide 4 — Quem ganha o quê

|    | **Operador de nó RPC** | **Desenvolvedor de agentes IA** |
|---|---|---|
| **Receita** | Spam vira receita recorrente | Paga só sob carga — folga é grátis |
| **Operação** | Nada de caçar atacante manualmente | Troca de infra sem perder prioridade |
| **Fidelidade** | Cliente fiel ganha desconto automático | Até 50% off via Trust-Score |
| **Integração** | 5 min de deploy (proxy reverso) | Drop-in em `@solana/web3.js` |

---

## Slide 5 — Prova de funcionamento

**Não são projeções. São medições.**

- **8,7 ms** de overhead do protocolo (p95). Meta do pitch era < 50 ms. **Batemos por 6×.**
- **26% de economia média** em 22 requisições consecutivas, com o Trust-Score saindo de 0 → 100 de reputação. Demo pública reproduzível.
- **HTTPS válido + cert Let's Encrypt** em `https://x402.assistent.top`. Qualquer juiz, investidor ou operador pode auditar agora.

```
curl -X POST https://x402.assistent.top/rpc \
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
- **Concorrência está na camada de cima.** MCPay e Latinum — ambos vencedores recentes do Colosseum com prêmios de ~US$ 25k — cobram **pelo serviço** (camada de aplicação MCP). **Nós cobramos pelo acesso à rede** (camada de protocolo RPC). Raio de impacto incomparavelmente maior.

**TAM:** se 1% das requisições RPC mensais virar prioridade paga a 1 lamport, estamos falando de milhões de dólares/ano circulando pela camada que intermedia.

---

## Slide 7 — Time e pedido

**Flávio Furtado** — CEO · produto e go-to-market
**João Romeiro** — CTO · arquitetura e engenharia
**Felipe Cardoso** — DPO · blockchain e segurança

> Construído para o Colosseum Frontier Hackathon (abril–maio 2026). MVP **shippado e público**. Semana 2 (Trust-Score) já **embarcada adiantada**. Semana 3 (open-source do spec + rede de parceiros operadores) em andamento.

**O que pedimos:**

- **Investidor:** conversar sobre rodada de pré-seed. O tamanho é função do piloto com o primeiro operador parceiro.
- **Operador parceiro:** 30 dias de piloto num nó de produção. Split da receita a combinar.
- **Colosseum:** considerar categoria de *Public Goods* — o spec x402 que a gente consolida vira infra pública do ecossistema Solana.

**Contato:** `rpcpriority.com` · Flávio@rpcpriority.com

---

## Notas de produção (para quem vai apresentar)

- **Tempo-alvo:** 5-7 minutos para a apresentação, 3-5 para Q&A.
- **Slides mais fortes:** 3 (solução) e 5 (prova). Esses dois precisam "pegar".
- **Antes do Slide 5:** abra o terminal ou um celular e rode o `curl` ao vivo. O 402 real na tela vale mais que qualquer slide.
- **Se for investidor sem background cripto:** pare no Slide 2 e desenhe a rodovia num papel antes de seguir. Dedique mais tempo à analogia, menos ao protocolo.
- **Se for operador ou CTO:** pule rápido pelo Slide 3 e passe mais tempo no 4 e 5 (os números).
