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

## Próximo passo

- **Se você é investidor:** toda IA que conversa com Solana vai passar por esta camada. Somos a primeira implementação com deploy público, certificado válido e medições reais. Conversar sobre uma rodada.
- **Se você opera um nó:** 5 minutos de deploy transformam seu nó num ativo que se defende e paga por si. Conversar sobre um piloto.
- **Se você constrói agentes:** troque `new Connection(...)` por `new X402Provider(...)` e seu agente passa na frente da fila. Código aberto, sem fee para experimentar.

---

**Time:** Flávio Furtado (CEO) — Flávio@rpcpriority.com | João Romeiro (CTO) | Felipe Cardoso (DPO)
**Projeto:** submissão Colosseum Frontier Hackathon, abril-maio 2026.
