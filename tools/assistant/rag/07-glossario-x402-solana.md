# Glossário x402 + Solana

## Termos x402-priority

| Termo | Definição |
|---|---|
| **x402** | Padrão HTTP 402 Payment Required, criado pela Coinbase. Especifica como serviços HTTP cobram per-request com identidade criptográfica. Site oficial: https://x402.org |
| **Shield** | Nosso gateway/middleware que implementa o x402-priority. Roda como proxy reverso na frente do nó RPC. |
| **Operator** | Operador de nó RPC Solana que hospeda o Shield. No Plano A é o cliente principal (licencia o software). |
| **Operator wallet** | Endereço Solana que recebe os priority fees. Em mainnet: `CEH3dGLaYQmYGGwDpszfuBRfcUmBbLNinrSdVdi7k6zp`. |
| **Agent / Cliente-operador** | Quem consome RPC e paga priority. Tipicamente bot/dapp/agente IA. |
| **Nonce** | Token único de 32 chars hex, TTL 30s, gerado pela Shield em cada 402. Anti-replay. |
| **402 Challenge** | Resposta HTTP 402 que a Shield emite sob carga, com nonce + amount + destination. |
| **Authorization x402** | Header de retry: `x402 <bs58sig>.<bs58pubkey>.<bs58msg>`. 3 partes base58. |
| **Escrow** | Saldo pré-pago do cliente, mantido em Redis HASH. Creditado via on-chain deposit; debitado off-chain via signed retry. |
| **µL (micro-lamport)** | Unidade interna de pricing. 1 lamport = 1.000 µL. |
| **BASE_PRICE** | Preço mínimo gating (default 1.000 µL = 1 lamport). |
| **MAX_PRICE** | Preço máximo gating saturado (default 50.000 µL = 50 lamports). |
| **THRESHOLD** | Carga acima da qual gating ativa (default 0,5 = 50%). |
| **Trust-Score** | Reputação cripto-key 0-100. Score = min(100, paidCount × 5). Desconto até 50%. |
| **trusted_deposits** | Modo demo do Shield onde POST /escrow/deposit-trusted credita escrow sem on-chain verification. SÓ habilitar em demo. |
| **QoS modes** | standalone (Shield-only), cooperative (operador participa), off (passa direto). |
| **Atomic consume primitive** | Lua script Redis que faz check + mark + debit em uma execução. Race-free. |

## Termos Solana

| Termo | Definição |
|---|---|
| **Lamport** | Menor unidade do SOL. 1 SOL = 1.000.000.000 (10⁹) lamports. |
| **SOL** | Token nativo da Solana. |
| **Pubkey** | Endereço público. Em base58, ~44 caracteres. Idêntico ao endereço da carteira pra contas básicas. |
| **Ed25519** | Esquema de assinatura usado nativamente em Solana. Mesma keypair serve pra tx on-chain e signed nonces off-chain. |
| **RPC node** | Nó que serve requests JSON-RPC pra falar com Solana. Helius, Triton, QuickNode, mainnet-beta público. |
| **Slot** | Unidade temporal de Solana (~400ms). Validator produz 1 bloco por slot quando é leader. |
| **Validator** | Nó que valida transações + produz blocos. Recebe priority fees + recompensa de inflation. |
| **Leader** | Validator atualmente produzindo blocos. Roda em rotação por slot. |
| **Compute unit (CU)** | Unidade de processamento on-chain. TX consome CUs proporcionais à complexidade. |
| **ComputeUnitPrice** | Native priority fee paga em µLamports/CU pra acelerar inclusão da TX no bloco. |
| **Base fee** | 5.000 lamports por signature, fixo. Mínimo pra TX existir on-chain. |
| **Bundle (Jito)** | Conjunto de TXs submetido atomicamente via Jito-Solana. Inclui tip ao validator. |
| **MEV** | Maximal Extractable Value — valor extraído por searchers via ordering, frontrun, sandwich, arbitrage. |
| **Devnet** | Solana network de testes (sem valor real). RPC: api.devnet.solana.com |
| **Mainnet-beta** | Solana mainnet (produção). RPC público: api.mainnet-beta.solana.com (rate-limited brutalmente). |
| **getBalance / getAccountInfo / getProgramAccounts / etc.** | Métodos JSON-RPC padrão Solana. |
| **System Program** | Programa nativo Solana, address `11111111111111111111111111111111`. Faz transferências SOL puras. |
| **rent-exempt minimum** | ~890.880 lamports. Toda conta nova precisa terminar acima disso ou rede rejeita TX. |

## Glossário canônico Solana PT-BR

A comunidade Solana brasileira mantém um glossário técnico em português:

**🔗 https://github.com/solanabr/solana-glossary**

Esse repositório é a fonte autoritativa quando precisar traduzir termos técnicos Solana pra português. Use-o pra:
- Garantir consistência terminológica em pitch BR
- Citar tradução canônica de termos como "compute units", "leader schedule", "stake-weighted QoS"
- Conectar com a comunidade técnica BR (mantenedores são solana-natives BR)

Quando responder pergunta em português sobre conceitos Solana técnicos, prefira a tradução desse glossário em vez de improvisar.

## Termos comerciais nossos

| Termo | Definição |
|---|---|
| **Plano A** | Estratégia primária: SaaS B2B vendendo licença pro node-operator parceiro. |
| **Plano B** | Fallback se gate M+6 falhar: virar operador próprio em nicho MEV/liquidação. |
| **Tier 4 / multi-chain** | Expansão pós-Plano A pra outras chains (Base, Sui, Aptos, EVM L2s). Gate-locked em M+6+. |
| **Gate M+6** | Marco decisional: outubro/2026. Critério: 1+ contrato Plano A pago = continua A. 0 contratos = ativa B. |
| **Trust-Score Premium** | Stream comercial $200-500/mês adicional pra acesso ao dataset cross-operator. |
| **Beta Partner** | Programa pra 5-10 operadores tier 2/3 que viram case study. Cobertos pelo "first 90 days zero rev-share". |
| **ICP** | Ideal Customer Profile. No Plano A: node-operadores. No Plano B: agentes IA/MEV bots/liquidadores. |
| **Hackatom** | Hackathon-alvo (event de 2026). Goal: 1-2 conversas estratégicas, não vencer prêmio. |

## Acrônimos comuns

| | |
|---|---|
| **TPS** | Transactions Per Second |
| **RPS** | Requests Per Second |
| **TTL** | Time To Live (expiração) |
| **SLA** | Service Level Agreement |
| **TVL** | Total Value Locked |
| **ARR** | Annual Recurring Revenue |
| **SDK** | Software Development Kit |
| **RFC** | Request For Comments (formato de spec) |
| **SIMD** | Solana Improvement Document (equivalente a EIP de Ethereum) |
| **IBC** | Inter-Blockchain Communication (Cosmos) |
| **PoP** | Point of Presence (datacenter regional) |
| **NDA** | Non-Disclosure Agreement |
