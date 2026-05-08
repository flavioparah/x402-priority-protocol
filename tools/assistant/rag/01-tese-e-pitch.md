# Tese e pitch — RPC Priority Protocol

## Em uma frase
Camada plugável para RPCs Solana existentes: cobramos pelo pico, não pelo plano. Per-request priority com Trust-Score recompensando cliente fiel — feito pra agentes que vão multiplicar tráfego 100× nos próximos 12-24 meses.

## O problema (versão correta — agêntica, não anti-spam)
Solana mainnet hoje aguenta 60-80k TPS. Congestionamento severo NÃO é dor real pra usuário humano. **A dor está no futuro agêntico:**

- Agentes IA autônomos vão multiplicar chamadas RPC 100× nos próximos 12-24 meses
- Modelos de cobrança atuais (API key + plano fixo da Helius/Triton) **quebram com agente**:
  - Agente roda em infra elástica (Lambda, container, k8s) — IP rotaciona por execução
  - Agente tem wallet, não cartão de crédito — não assina contrato mensal
  - Agente escala horizontalmente — N réplicas paralelas
  - Agente precisa pagar por uso, não por subscription

Hoje não existe primitiva nativa de prioridade pra essa camada agêntica que seja plugável em qualquer operador RPC. **Nós somos essa camada, não um substituto do RPC.**

## A solução
Camada de prioridade paga em SOL via padrão x402 (HTTP 402 Payment Required, Coinbase). Entra como proxy reverso na frente da infraestrutura RPC existente. Funciona em 5 passos:

1. Cliente faz POST em `/rpc` com body JSON-RPC normal
2. Sob carga, gateway retorna `HTTP 402` com nonce + amount + destination
3. Cliente assina o nonce com Ed25519 (mesma keypair Solana)
4. Retry com `Authorization: x402 <sig>.<pubkey>.<msg>`
5. Gateway verifica, debita escrow off-chain, encaminha pro RPC, devolve resposta

**Resultado**: cliente nunca bloqueado por IP, paga só quando congestiona, identidade criptográfica zero-friction.

## Posicionamento contra comparáveis

- **Ankr**: valida RPC provider/agregador. Não somos outro agregador; somos middleware de enforcement/monetização que um operador ou agregador poderia adotar.
- **x402.vip**: valida x402 aplicado a RPC. Nosso diferencial precisa ser operador-grade: escrow verificado, anti-replay, Redis state, QoS, Trust-Score, anti-flood e audit log.
- **Frase canônica**: "One push away from any Solana RPC because this is not a new RPC network; it is a drop-in x402 enforcement layer for existing RPC operators."

## Quem ganha o quê

| Operador de nó RPC (Helius, Triton, validators tier 2/3) | Desenvolvedor de agente (bot, indexer, DEX backend) |
|---|---|
| Spam que era prejuízo vira receita recorrente | Acesso garantido sem API key e sem whitelist de IP |
| Sem precisar caçar atacante manualmente | Troca de infra (Lambda, container) sem perder prioridade |
| Cliente fiel ganha desconto automático (Trust-Score) | Paga só quando precisa — sob carga baixa, passa de graça |
| 5 minutos de deploy — proxy reverso, não reescrita | Drop-in no @solana/web3.js — troca só o construtor |

## Prova de funcionamento (medida, não projetada)

- **Overhead do protocolo**: 8,7 ms p95 (handshake completo 402+retry)
- **Stress test em mainnet** (1.000 paid requests, 5 wallets simultâneas): p50=378ms, p95=639ms, p99=701ms
- **Trust-Score progression**: 0→100 em 21 pagamentos confirmados (matemática do spec, exata)
- **Persistência Redis confirmada**: counters sobreviveram restart de container
- **43/43 testes passando**: detection signals, atomic Lua, cooperative QoS spec
- **6 deploys ao vivo** com cert Let's Encrypt:
  - api.rpcpriority.com / mainnet.rpcpriority.com — Shield mainnet (operator: CEH3dGLaYQmYGGwDpszfuBRfcUmBbLNinrSdVdi7k6zp)
  - devnet.rpcpriority.com — devnet
  - demo.rpcpriority.com — Trust-Score demo
  - app.rpcpriority.com — dashboard interativo
  - rpcpriority.com — landing institucional

## Custos reais (medidos em mainnet)

| Operação | Custo USD |
|---|---|
| 1 priority request (preço médio com Trust-Score 100) | $0,000007 |
| Stress test 1.000 paid requests | $0,032 |
| Onboarding completo de 1 agente (30 dias de uso típico) | $0,17 |
| Setup multi-agent (50 wallets × funding mainnet com rent-exempt) | ~$3,80 |

## Tese de moat (por que somos defensáveis)

1. **Trust-Score cross-operador é o moat real** — efeito de rede tipo Metcalfe sobre dados comportamentais. Cada operador integrado aumenta valor pros outros. Concorrente novo começa com 0 histórico.
2. **Autoridade de spec** via 3 RFCs publicados (x402-priority, x402-trust-score, x402-qos-cooperative). Quem define o padrão controla compatibilidade futura.
3. **Velocidade**: 9 semanas do zero ao mainnet validado.
4. **Anti-sybil/fraud detection cross-operator** com 5 sinais formalizados.

Código sozinho não defende — o spec é público por design. Mas dataset acumulado + relacionamentos com operadores + autoria do RFC defendem.
