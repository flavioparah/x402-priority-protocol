# Hermes — Assistente Oficial do RPC Priority Protocol

Kit completo pra rodar um assistente de IA que responde perguntas de juízes de hackathon, investidores, parceiros operadores e devs curiosos sobre o projeto. Construído pra rodar na plataforma [`geragentes`](../../../geragentes/) (FastAPI + RAG + LLM).

## Quem é o Hermes

- **Nome**: Hermes
- **Função**: defensor técnico-comercial do RPC Priority Protocol
- **Idioma padrão**: português brasileiro
- **Tom**: técnico, direto, confiante mas honesto. Cita números reais, admite limitações
- **Refusal**: nunca inventa métricas; escala pra `flavio@rpcpriority.com` em decisões estratégicas

## Estrutura do kit

```
tools/assistant/
├── README.md                    ← este arquivo (visão geral)
├── INSTALL.md                   ← passos pra instalar no geragentes
├── SYSTEM_PROMPT.md             ← prompt mestre (1.500 linhas)
├── prompt_sections.json         ← versão estruturada (geragentes)
├── canned_responses.json        ← FAQ com 30 perguntas pré-aprovadas
└── rag/                         ← knowledge base (9 arquivos curados)
    ├── 01-tese-e-pitch.md
    ├── 02-arquitetura-tecnica.md
    ├── 03-precos-e-economia.md
    ├── 04-objecoes-defesa.md
    ├── 05-jornadas.md
    ├── 06-rfcs-resumo.md
    ├── 07-glossario-x402-solana.md
    ├── 08-comparacao-competitiva.md
    └── 09-referencias-links.md
```

## Coverage

O kit cobre as seguintes áreas com profundidade verificada:

| Área | Onde está | Profundidade |
|---|---|---|
| Tese e pitch | `rag/01-tese-e-pitch.md` + canned `produto.tese` | Completa (com reposicionamento agêntico-first) |
| Arquitetura técnica | `rag/02-arquitetura-tecnica.md` | Stack, fluxo, persistência, endpoints |
| Preços e economia | `rag/03-precos-e-economia.md` | Curva, Trust-Score, capital, comparativo |
| Objeções defensivas | `rag/04-objecoes-defesa.md` | 15 objeções top com respostas pré-aprovadas |
| Jornadas operacionais | `rag/05-jornadas.md` | Cliente-operador + node-operador |
| RFCs autorados | `rag/06-rfcs-resumo.md` | x402-priority, trust-score, qos-cooperative |
| Glossário | `rag/07-glossario-x402-solana.md` | Termos x402 + Solana + nossos + glossário PT-BR canônico (solanabr) |
| Comparativo concorrencial | `rag/08-comparacao-competitiva.md` | vs Helius/Triton/Jito/native fees/Stellar Oxide |
| URLs e referências | `rag/09-referencias-links.md` | Endpoints ao vivo, repo, RFCs, contato |

**Tamanho total**: ~3.500 linhas de conteúdo curado em PT-BR.

## Top 30 perguntas previstas (em `canned_responses.json`)

1. O que é (tese em uma frase)
2. Por que existe / qual problema
3. Como funciona / fluxo
4. Como deposito (escrow)
5. Trust-Score como funciona
6. Quanto custa
7. Métricas (latência)
8. Está em produção?
9. Modelo de negócio
10. Cliente alvo
11. vs Helius
12. vs Jito
13. vs native priority fees
14. vs Stellar Oxide Gateway
15. Moat / diferencial
16. RFCs / spec
17. Time
18. Investimento / equity (escala)
19. Token? (não)
20. Repo aberto? (privado, NDA)
21. SDK / biblioteca
22. Quero testar
23. Anti-sybil / fraud
24. Parceria / licenciar
25. Multi-chain (gate-locked)
26. Trial grátis? (não)
27. Infraestrutura / VPS
28. Glossário / termos
29. Hackathon
30. Contato

## Princípios de comportamento (memorizados no prompt)

1. **Honestidade > completude.** Não sabe? Diz "não tenho esse dado" e direciona pra fundador ou live API.
2. **Números reais sempre.** Métricas vêm dos materiais ingeridos, nunca inventadas.
3. **Source-of-truth chain**: live API > RFCs > ESTRATEGIA > docs > inferência marcada
4. **Escalation pra humano** em: cap table, valuation, contratos, roadmap pós-M+6, privkeys, SLA futuro
5. **Sem marketing-speak vazio.** Tom direto, técnico, confiante.
6. **Reposicionamento agêntico-first.** Não vendemos pra dor de hoje, vendemos pra dor de amanhã.

## Dependências externas

### Plataforma
- [`geragentes`](../../../geragentes/) — FastAPI + PostgreSQL + Redis + LLM (OpenAI default ou Anthropic)
- VPS kvm4 onde geragentes-api está deployado em `https://api.geragentes.assistent.top`

### LLM provider
- **Default recomendado**: OpenAI GPT-4o-mini (custo baixo, qualidade alta)
- **Alternativa**: Anthropic Claude (melhor em respeitar idioma quando pergunta em PT-BR)
- Configuração via env `LLM_PROVIDER` no geragentes

### Glossário externo (citado em respostas)
- **Solana glossary PT-BR (canônico)**: https://github.com/solanabr/solana-glossary
- Hermes referencia esse repo quando precisa traduzir termos técnicos Solana

## Quick start (3 comandos)

```bash
# 1. Criar assistente (substitui ADMIN_KEY)
curl -X POST https://api.geragentes.assistent.top/admin/assistants \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d @<(jq -n \
    --arg sp "$(cat SYSTEM_PROMPT.md)" \
    --argjson ps "$(cat prompt_sections.json)" \
    --argjson cr "$(cat canned_responses.json)" \
    '{
      name: "Hermes",
      company_name: "RPC Priority Protocol",
      company_slug: "rpc-priority",
      client_name: "João Romeiro",
      client_email: "flavio@rpcpriority.com",
      whatsapp_cliente: "+5500000000000",
      system_prompt: $sp,
      prompt_sections: $ps,
      canned_responses: $cr.responses,
      trial_days: 365
    }')

# 2. Subir RAG content (substitui ASSISTANT_ID retornado acima)
scp tools/assistant/rag/*.md kvm4:/root/geragentes/data/$ASSISTANT_ID/

# 3. Reload RAG
curl -X POST https://api.geragentes.assistent.top/admin/assistants/$ASSISTANT_ID/rag/reload \
  -H "X-Admin-Key: $ADMIN_KEY"
```

Detalhes em [`INSTALL.md`](./INSTALL.md).

## Manutenção contínua

| Frequência | Ação | Arquivo afetado |
|---|---|---|
| Toda mudança técnica significativa | Atualizar | `rag/02-arquitetura-tecnica.md` |
| Toda mudança de pricing/economia | Atualizar | `rag/03-precos-e-economia.md` |
| Nova objeção que apareceu | Adicionar | `rag/04-objecoes-defesa.md` |
| Nova validação em mainnet | Atualizar números | `rag/01-tese-e-pitch.md` |
| Após gate M+6 | Re-escrever estratégia | `rag/01` + `rag/05` |
| Mensal | Auditar `canned_responses.json` | adicionar perguntas frequentes |

## Quando NÃO usar

- Perguntas pessoais sobre o time (Hermes não tem essa informação)
- Negociação de contrato (sempre escala)
- Cálculos de equity/valuation (escala)
- Promessas de feature/SLA futuro (escala)
- Privkeys, seeds, secrets (refuse + warning)

Pra essas situações, o assistente responde com a frase padrão:
> *"Pra essa decisão, melhor falar diretamente com o time. flavio@rpcpriority.com — quer que eu prepare um resumo do que você precisa?"*

## Roadmap do próprio assistente

| Versão | Quando | O que muda |
|---|---|---|
| v1.0 (atual) | 2026-05-04 | Lançamento — coverage de pitch + objeções + arquitetura |
| v1.1 | Pós-hackatom | Adicionar perguntas reais que apareceram no evento |
| v1.2 | Pós-1º contrato Plano A | Adicionar case study real (com aprovação do operador parceiro) |
| v2.0 | Gate M+6 | Reposicionar conforme rota tomada (Plano A scale ou Plano B) |

## Métricas de sucesso esperadas

- ✅ Responde corretamente top-30 perguntas previstas
- ✅ Não inventa nenhuma métrica
- ✅ Escala 5-15% das conversas pra humano (taxa saudável)
- ✅ Latência <3s por resposta
- ✅ Cobre PT-BR + EN + ES (auto-detect idioma)

## Contato pra issues do assistente

- Mantenedor: flavio@rpcpriority.com
- Issues do projeto principal: github.com/flavioparah/x402-priority-protocol/issues (privado)
