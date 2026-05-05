# INSTALL — instruções pra criar o assistente Hermes no geragentes

## Contexto

`geragentes` (em `c:/projetos/geragentes`) é a plataforma SaaS que vamos usar pra hospedar o assistente Hermes. Ela:

- Backend FastAPI Python rodando em `https://api.geragentes.assistent.top`
- Banco PostgreSQL (assistentes em tabela `assistants`)
- LLM: OpenAI GPT-4o-mini default ou Anthropic Claude
- RAG: lê arquivos do diretório `data/<assistant_id>/`
- Integração WhatsApp via EvolutionAPI (opcional)
- Admin API protegida via `ADMIN_API_KEY`

## Arquivos deste kit

```
tools/assistant/
├── README.md                    ← visão geral
├── INSTALL.md                   ← este arquivo
├── SYSTEM_PROMPT.md             ← prompt mestre (texto livre)
├── prompt_sections.json         ← versão estruturada (geragentes)
├── canned_responses.json        ← FAQ top-30
└── rag/                         ← knowledge base pra ingerir
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

## Passos de instalação

### Passo 1 — Criar assistente no geragentes via admin API

```bash
# Variáveis necessárias
GERAGENTES_URL="https://api.geragentes.assistent.top"
ADMIN_KEY="<ADMIN_API_KEY do .env do geragentes>"

# System prompt: pode usar SYSTEM_PROMPT.md inteiro (texto livre)
# OU prompt_sections.json (estruturado, geragentes regenera system_prompt automático)

curl -X POST "$GERAGENTES_URL/admin/assistants" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "name": "Hermes",
  "company_name": "RPC Priority Protocol",
  "company_slug": "rpc-priority",
  "client_name": "João Romeiro",
  "client_email": "flavio@rpcpriority.com",
  "whatsapp_cliente": "+55XXXXXXXXXXX",
  "system_prompt": "<colar conteúdo de SYSTEM_PROMPT.md aqui>",
  "prompt_sections": <colar conteúdo de prompt_sections.json aqui>,
  "canned_responses": <colar conteúdo de canned_responses.json aqui>,
  "trial_days": 365
}
EOF
```

**Response esperado**: 200 OK com o `assistant_id` UUID. **Anote esse ID** — vai usar nos próximos passos.

### Passo 2 — Subir RAG content

Os 9 arquivos MD em `tools/assistant/rag/` precisam ir pro diretório `data/<assistant_id>/` do geragentes:

```bash
# Localmente (ou via scp pra VPS de produção)
ASSISTANT_ID="<uuid retornado no passo 1>"

# Local (dev)
mkdir -p c:/projetos/geragentes/data/$ASSISTANT_ID
cp c:/projetos/x402/tools/assistant/rag/*.md c:/projetos/geragentes/data/$ASSISTANT_ID/

# OU produção via SSH
scp c:/projetos/x402/tools/assistant/rag/*.md kvm4:/root/geragentes/data/$ASSISTANT_ID/
```

### Passo 3 — Recarregar RAG no geragentes

O sistema RAG do geragentes (`src/services/rag_system.py`) lê o diretório no boot do assistente. Forçar reload:

```bash
# Via admin API (se houver endpoint reload)
curl -X POST "$GERAGENTES_URL/admin/assistants/$ASSISTANT_ID/rag/reload" \
  -H "X-Admin-Key: $ADMIN_KEY"

# OU restart do container do geragentes
ssh kvm4 "docker restart geragentes-api"
```

### Passo 4 — Testar via API direta

```bash
# Endpoint de chat (depende da API do geragentes)
curl -X POST "$GERAGENTES_URL/assistants/$ASSISTANT_ID/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "O que é o RPC Priority Protocol?",
    "user_id": "test-user-001"
  }'
```

Resposta esperada: explicação concisa em PT-BR começando com "RPC Priority Protocol é uma camada de prioridade paga..."

### Passo 5 — (Opcional) Conectar WhatsApp

Se quiser que o assistente responda via WhatsApp:

```bash
# Criar instância EvolutionAPI
curl -X POST "$GERAGENTES_URL/admin/assistants/$ASSISTANT_ID/whatsapp/connect" \
  -H "X-Admin-Key: $ADMIN_KEY"
```

Aí escaneia QR code com WhatsApp Web e o assistente vai responder mensagens recebidas no número conectado.

### Passo 6 — Embedar no site (opcional)

Se quiser widget de chat no `app.rpcpriority.com`:

```html
<script src="https://api.geragentes.assistent.top/embed/<assistant_id>.js" async></script>
```

(Verificar com geragentes se esse endpoint existe; se não, dá pra criar um simples iframe.)

## Validação pós-deploy

Teste essas perguntas e confira respostas:

| Pergunta | Resposta esperada conter |
|---|---|
| "O que é o RPC Priority Protocol?" | "camada de prioridade paga", "x402", "Solana", "per-request" |
| "Quanto custa por request?" | "20.100 µL", "$0,000007", "Trust-Score 50% off" |
| "Vocês competem com Helius?" | "Não", "cliente principal Plano A", "licenciam nosso Shield" |
| "E o Jito?" | "Camadas diferentes", "ordena TXs", "RPC vs validator", "complementam" |
| "Como integrar?" | "POST /rpc", "Authorization: x402", "Ed25519", "https://api.rpcpriority.com" |
| "Vocês têm token?" | "Não", "SaaS B2B" |
| "Posso ver demo?" | "https://app.rpcpriority.com/try" |

Se uma dessas falhar, o RAG não está sendo retrieved corretamente. Debug:
- Confirmar arquivos em `data/<assistant_id>/`
- Confirmar `system_prompt` foi salvo no banco
- Logs do geragentes-api: `docker logs geragentes-api --tail 100`

## Ajustes pós-instalação

Quando atualizar conteúdo:

```bash
# 1. Editar arquivo MD em tools/assistant/rag/
# 2. Copiar pra geragentes
cp c:/projetos/x402/tools/assistant/rag/<file>.md c:/projetos/geragentes/data/$ASSISTANT_ID/

# 3. Reload
curl -X POST .../rag/reload
```

Quando atualizar `system_prompt` ou `canned_responses`:

```bash
curl -X PUT "$GERAGENTES_URL/admin/assistants/$ASSISTANT_ID" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "system_prompt": "<novo conteúdo>",
    "canned_responses": [...],
    "prompt_sections": {...}
  }'
```

(O geragentes mantém histórico de versões via tabela `prompt_versions` — rollback é possível.)

## Troubleshooting

### Assistente responde genericamente, não cita nossos números
- Confirmar RAG ingeriu os arquivos: `docker exec geragentes-api ls /app/data/<assistant_id>/`
- Forçar reload do RAG
- Verificar logs: `docker logs geragentes-api --tail 200 | grep -i rag`

### Assistente inventa métricas
- O system prompt JÁ proíbe isso explicitamente. Se ainda acontece, investigar:
- Modelo está sendo usado? (GPT-4o-mini ≠ GPT-3.5-turbo)
- Temperature: ajustar pra 0.2 ou abaixo (precisão > criatividade)

### Assistente responde em inglês quando pergunta é em português
- Verificar `LLM_PROVIDER` env do geragentes (OpenAI vs Anthropic — Claude tende a respeitar idioma melhor)
- Reforçar no system prompt: "Idioma padrão: PT-BR. Responder no idioma da pergunta."

### Custo OpenAI alto
- Mudar modelo pra `gpt-4o-mini` (default já é esse, mas confirmar)
- Reduzir context window: limitar RAG retrieval a top-3 chunks em vez de top-10
- Cache de respostas comuns (se geragentes suportar)

## Cronograma de manutenção

| Frequência | Ação |
|---|---|
| Toda mudança no produto | Atualizar arquivo MD relevante em `rag/` + push pra geragentes |
| Mensal | Revisar `canned_responses.json` (perguntas novas que apareceram) |
| Trimestral | Auditar logs de conversas pra encontrar falhas/inventos |
| Pós-gate M+6 | Re-escrever `01-tese-e-pitch.md` se reposicionamento |

## Métricas de sucesso

| Métrica | Target |
|---|---|
| Taxa de resposta correta (FAQ top-30) | >95% |
| Taxa de invenção de métricas | 0% |
| Latência média de resposta | <3s |
| Conversas que escalam pra `flavio@rpcpriority.com` | 5-15% (taxa saudável; trair mais = assistente está respondendo coisas que não devia) |
