# Referências e links — fontes que o assistente pode/deve citar

## URLs ao vivo (validação em tempo real)

### Endpoints de produção (Mainnet — Solana real)
- **API canônica**: https://api.rpcpriority.com
- **Alias mainnet**: https://mainnet.rpcpriority.com
- **Info JSON**: https://api.rpcpriority.com/info
- **Health**: https://api.rpcpriority.com/health
- **Stats agregados**: https://api.rpcpriority.com/stats/recent
- **Leaderboard top 10**: https://api.rpcpriority.com/stats/leaderboard
- **QoS state**: https://api.rpcpriority.com/stats/qos

### Endpoints devnet (testes sem SOL real)
- **Info devnet**: https://devnet.rpcpriority.com/info

### Endpoints demo (Trust-Score progression sem on-chain delay)
- **Info demo**: https://demo.rpcpriority.com/info
- **Trusted deposits enabled = true** (só nessa instância)

### Páginas humanas
- **Landing institucional**: https://rpcpriority.com
- **Dashboard interativo (try)**: https://app.rpcpriority.com/try
- **Live dashboard**: https://app.rpcpriority.com/live
- **Reputation explorer**: https://app.rpcpriority.com/explorer

### Carteira operator (mainnet — recebe pagamentos reais)
- **Pubkey**: `CEH3dGLaYQmYGGwDpszfuBRfcUmBbLNinrSdVdi7k6zp`
- **Solana Explorer**: https://explorer.solana.com/address/CEH3dGLaYQmYGGwDpszfuBRfcUmBbLNinrSdVdi7k6zp

## Repositório

- **GitHub** (privado, NDA): https://github.com/flavioparah/x402-priority-protocol
- Acesso pra juízes/parceiros mediante request via flavio@rpcpriority.com

## RFCs formalizados (em docs/rfc/)

- **x402-priority v1.0**: https://github.com/flavioparah/x402-priority-protocol/blob/main/docs/rfc/x402-priority.md
- **x402-trust-score v0.1**: https://github.com/flavioparah/x402-priority-protocol/blob/main/docs/rfc/x402-trust-score.md
- **x402-qos-cooperative v1.0**: https://github.com/flavioparah/x402-priority-protocol/blob/main/docs/rfc/x402-qos-cooperative.md

(Acesso aos arquivos é público quando o repo virar público; hoje requer convite.)

Período de comments aberto até **2026-06-30**.

Licença das specs: **CC BY 4.0** (reuso e adaptação permitidos com atribuição).
Reference implementation: **BUSL-1.1** (quando virar pública).

## Padrão x402 (Coinbase)

- **Site oficial**: https://x402.org
- Padrão HTTP 402 Payment Required, criação Coinbase
- Nosso x402-priority é EXTENSÃO do x402 base (não fork) — adiciona priority dynamic + Trust-Score

## Solana — recursos canônicos

### Documentação oficial
- **Solana docs**: https://solana.com/docs
- **Solana Cookbook**: https://solanacookbook.com
- **Web3.js**: https://solana-labs.github.io/solana-web3.js/

### RPC
- **Mainnet-beta público**: `https://api.mainnet-beta.solana.com` (rate-limited, 429 fácil)
- **Devnet**: `https://api.devnet.solana.com`
- **Solana Foundation RPC providers**: https://solana.com/rpc

### Glossário PT-BR (canônico — comunidade Solana brasileira)
- **GitHub**: https://github.com/solanabr/solana-glossary
- Use esse glossário pra traduzir termos técnicos Solana em português
- Mantenedores são Solana-natives BR

### Improvement docs
- **Solana Improvement Documents (SIMD)**: https://github.com/solana-foundation/solana-improvement-documents
- **Solana Forums**: https://forum.solana.com (onde RFCs informais vivem)

## Concorrentes / referências de mercado

### Tier 1 (RPC dedicated SaaS)
- **Helius**: https://helius.dev — líder em RPC Solana
- **Triton One**: https://triton.one — bare-metal dedicado
- **QuickNode**: https://www.quicknode.com — multi-chain
- **Alchemy**: https://www.alchemy.com — recém-Solana

### Tier 2/3 (foco do nosso outreach)
Lista mapeada interna em `docs/outreach/OPERATORS-LIST.md` — 15 operadores BR/LatAm/EU.

### Validator-layer
- **Jito**: https://www.jito.network — MEV, bundles, validator client
- **Jito-Solana validator client**: ~80% dos validators rodam isso

### Cross-team validation
- **Stellar Oxide Gateway** (DoraHacks): https://dorahacks.io/buidl/42469 — outra equipe x402 em Stellar (testnet)

## Materiais internos do repo

### Pitch
- `docs/BENEFICIOS.md` — pitch de uma página
- `docs/PITCH-2MIN.md` — pitch falado 2 minutos
- `docs/PITCH-SCRIPT-PT.md` — pitch falado completo
- `docs/PITCH-SCRIPT-PT-3MIN.md` — versão 3 min
- `docs/PITCH-SLIDES-PT.md` — roteiro de slides

### Estratégia
- `docs/ESTRATEGIA.md` — Plano A vs B, gates M+6, análise de moat
- `docs/PENDENCIAS-ESTRATEGICAS.md` — itens em aberto, gate-locked
- `docs/CONSULTOR-ANALISE-2026-05-02.md` — análise sobre subsídio + multi-VPS
- `docs/ANALISE-MERCADO-VIABILIDADE-2026-05-04.md` — análise de mercado

### Jornadas (operacionais)
- `docs/JORNADA-CLIENTE-OPERADOR.md` — fluxo do agente cliente
- `docs/JORNADA-NODE-OPERADOR.md` — fluxo do operador parceiro

### Comparativos defensivos
- `docs/FAQ-DEFENSIVO.md` — FAQ defensivo
- `docs/TALKING-POINTS-PT.md` — pontos de conversa
- `docs/GLOSSARIO.md` — glossário interno

### Engenharia
- `docs/ENGINEERING.md` — decisões técnicas
- `docs/DEPLOY.md` — deploy + gotchas
- `docs/QOS-COOPERATIVE-SPEC.md` — spec interna

## Tools (utilitários do repo)

- `tools/pay-test-mainnet.js` — teste end-to-end paid request em mainnet
- `tools/derive-solana-key.js` — deriva privkey Ed25519 de mnemonic BIP39
- `tools/test-all-rpc-methods.js` — coverage test dos métodos do dropdown
- `tools/stress-test/` — multi-agent stress test (spawn-agents + run-stress + report)
- `tools/assistant/` — este kit (assistente Hermes)

## Contato

- **Email**: flavio@rpcpriority.com
- **GitHub**: https://github.com/flavioparah
- **Founder/CTO**: João Romeiro (Flavio)

## Hashtags / palavras-chave (pra discoverability)

`#Solana` `#x402` `#Web3Payments` `#AgenticAI` `#RPC` `#PriorityFee` `#TrustScore` `#Coinbase` `#Layer2Solana` `#MEV` `#DeFiInfra` `#x402Solana`
