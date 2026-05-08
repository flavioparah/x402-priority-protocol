# Talking Points PT — RPC Priority Protocol

> Frases curtas para entrevistas, podcasts, gravação de vídeo ou conversa de corredor. Uma ideia por bullet. Derivado de [`BENEFICIOS.md`](./BENEFICIOS.md).

## Em uma frase

- "Transformamos spam em receita para o operador de RPC e em acesso prioritário pro agente pagador."

## O problema

- "Spam em RPC é o novo DDoS — e hoje é só custo pro operador."
- "IP rate-limit pune quem troca de infra. Agente moderno roda em Lambda, container, serverless — bloquear por endereço é bloquear o cliente."
- "API key resolve? Só pra quem assina plano fixo. Agentes pagam por requisição, não por mensalidade."

## A solução em três batidas

- "A gente fez o atacante virar cliente involuntário do operador."
- "Zero API key. Zero whitelist. Chave cripto como identidade."
- "Preço que respira com a carga: folgado é grátis, cheio é tarifado."

## A prova

- "Cliente fiel paga 50% menos, automaticamente. Chamamos de Trust-Score."
- "8,7 milissegundos de overhead. A meta era 50. Batemos por seis vezes."
- "26,1% de economia média, medida em 22 requisições consecutivas. Demo reproduzível."
- "**43 de 43 testes passando.** Sybil, fraud, churn, atomic Lua, cooperative QoS spec compliance."
- "**Três deploys ao vivo**: mainnet, devnet e demo de trust-score. Cert Let's Encrypt válido. Curl testa em 10 segundos."
- "**Primeira implementação x402 em mainnet Solana.** Não é POC."

## O diferencial

- "MCPay e Latinum cobram pela aplicação. A gente cobra pelo acesso à rede."
- "Raio de impacto: toda IA que fala com Solana passa por um nó RPC. A gente fica no caminho de todo mundo."
- "Código é commodity, dado é moat. Spec aberto, server aberto, SDK aberto. Trust-Score backend fechado."
- "Autoramos três RFCs: x402-priority, x402-trust-score, x402-qos-cooperative. Quem define o spec controla compatibilidade."

## A defesa contra concorrência

- "'Jito faz isso em 6 meses?' Código, sim. **Rede neutra de operadores, não.** Jito é concorrente direto de Helius e Triton — eles não compartilham dado de cliente com Jito. Mesmo se Jito shippar, vira Jito Score, fechado. Mercado de broker neutro continua aberto."
- "Paralelo: Visa nunca virou banco. Plaid nunca virou fintech. Vivem da neutralidade. É exatamente onde a gente joga."

## O mercado

- "x402 é padrão da Coinbase, de 2024. Janela curta pra quem chega primeiro."
- "Helius, Triton e Jito já monetizam prioridade com planos fixos. Falta a versão pay-per-request — é o que a gente faz."
- "Bilhões de requisições RPC por mês no ecossistema. 1% virando priorizada já dá milhões por ano em volume."
- "EIP-1559 da Ethereum já queimou US$ 11 bilhões em base fee. Mercado de prioridade não é hipótese — é realidade comprovada."

## Pra fechar

- "**Nove semanas, do zero ao mainnet.** MVP, Trust-Score, três RFCs, QoS dual-track, Redis multi-instance, atomic Lua, detection v1, três deploys, pacote de outreach pra 15 operadores."
- "Próximos 90 dias: gate comprimido — 3 operadores integrados em M+3. Senão, ativa Plano B (operador próprio nicho)."
- "Pré-seed aberta: US$ 150-300k pra fechar os 3 primeiros contratos. Operadores parceiros: 30 dias de piloto, revenue share 70/30, sem fixed fee."
