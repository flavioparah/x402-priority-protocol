# Pendências estratégicas — RPC Priority Protocol

> Lista canônica de itens que estão fora do "produto pronto" mas movem a tese pra frente. Cada item tem: contexto, critério de pronto, esforço estimado, dependências, e o gate decisional (quando atacar). Atualizada em 2026-04-30.

Para o porquê dessa priorização, ver [`ESTRATEGIA.md`](./ESTRATEGIA.md). Para o feedback do consultor que originou parte dessa lista, ver "histórico" no fim deste documento.

---

## Sequência sugerida (por ordem de impacto pré-hackatom)

| # | Item | Esforço | Bloqueia? | Quando | Status |
|---|---|---|---|---|---|
| 1 | Reposicionar pitch agêntico-first | ~2h | Hackatom | **Esta semana** | ⏳ pendente |
| 2 | Persistência de contadores Redis | ~2-3h | Volume real (>10 ops/dia) | Antes do 1º cliente pago | ✅ **feito** (commit `9daf1a4`) |
| 3 | Outreach tier 2/3 BR/LatAm | dias × 5 | Plano A (M+3) | Próximas 2 semanas | ⏳ pendente |
| 4 | RFC público x402-priority | ~1 semana | Autoridade de spec | M+1 | ✅ **draft pronto** (commit `9b18f13` em `docs/rfc/`) — falta publicar nos fóruns |
| 5 | Aproveitar hackatom estrategicamente | dia do evento | M+6 contracts | Dia do evento | ⏳ pendente |
| 6 (NOVO) | **Multi-agent stress test em mainnet** | ~3h | Validação produção | Antes do hackatom | ✅ **feito** (commit `b949aa7`) — 1.000 paid requests, 5 wallets novas registradas em api.rpcpriority.com |

---

## 1. Reposicionar pitch agêntico-first

### Contexto
Consultor (em call hoje, 2026-04-29) corrigiu nossa narrativa. Pitch atual em `BENEFICIOS.md`, `PITCH-SCRIPT-PT.md`, etc. usa frase "spam que trava a rede vira receita" — descrição do problema **HOJE**.

Consultor argumentou: esse problema **não é tão real hoje**. Solana faz 60k TPS, JIT/native priority fees já resolvem priorização pra usuário humano/retail. Robusto não dá rate limit. **A dor está no FUTURO agêntico**, não no presente.

Reposicionar: não vendemos "anti-spam de hoje", vendemos "primitiva nativa de prioridade pra o swarm de agentes que vem".

### Critério de pronto
- [ ] `BENEFICIOS.md` reposicionado: headline "the priority primitive for agentic Solana", tabela "Quem ganha" reescrita pra agentes (não dev de agente IA genérico)
- [ ] `PITCH-SCRIPT-PT.md` reescrito com opening "RPC é o ponto obrigatório" → "agentes multiplicam chamadas" → "modelo atual quebra" → "pricing nativo agêntico"
- [ ] `PITCH-SLIDES-PT.md` slide 1: Problem hoje vs Problem em 2-3 anos. Slide 2: por que API key não escala pra agente
- [ ] `FAQ-DEFENSIVO.md` adiciona pergunta *"E os planos da Helius/Triton, não resolvem isso?"* — resposta: pra usuário humano sim, pra agente não

### Esforço estimado
~2h de redação concentrada. Baixo risco, alto ROI.

### Dependências
Nenhuma. Pode atacar agora.

### Gate decisional
**Atacar antes do hackatom.** Sem reposicionamento, pitch soa datado pra juiz técnico que conhece JIT/Helius.

### Não-objetivos
- Não reescrever a `compare.html` (revertida — foi UX, não copy)
- Não mexer nos docs `JORNADA-*` ainda (atualizam depois do pitch consolidado)

---

## 2. Persistência de contadores Redis ✅ CONCLUÍDO (commit `9daf1a4`, 2026-04-30)

> **Status final**: implementado, deployado em todos os 3 shields (mainnet, devnet, demo), validado end-to-end. Counters sobreviveram restart do container `x402-shield-mainnet` confirmadamente.
>
> **Validação adicional (commit `b949aa7`)**: stress test multi-agent em mainnet registrou 1.000 payments + 5 pubkeys novos no Redis do `api.rpcpriority.com`. Persistência confirmada sob carga real.
>
> Detalhes históricos preservados abaixo.

### Contexto
Hoje em `index.js`, os contadores `total_challenges_issued_session` e `total_payments_session` (e os arrays `paymentLog`, `challengeLog`, `loadHistory`) são **in-memory**. Resetam quando o container reinicia.

Persistido em Redis hoje: `total_paid_micro_lamports`, `unique_paying_pubkeys`, e por-pubkey `paidCount`/`totalPaid` em hash. Esses sobrevivem.

O que NÃO sobrevive:
- `paymentLog` (array com últimos 100 pagamentos pro audit stream)
- `challengeLog` (array com últimos 100 desafios 402 emitidos)
- `loadHistory` (60 amostras pra gráfico)
- `qosStats` (in-flight, dispatched_total, bypassed_total, etc.)
- `requestTimestamps` (pra cálculo de RPS — esse pode ficar volátil)

### Por que importa
Volume baixo hoje: aceitável. Quando tiver 10+ ops/dia em produção, perder dashboard rolling no restart vira problema visível pro pitch ("os números zeraram"). Antes do 1º cliente pago é o limite.

### Critério de pronto
- [ ] `lib/store.js` ganha métodos: `pushPayment()`, `pushChallenge()`, `pushLoadSample()`, `getRecentPayments()`, `getRecentChallenges()`, `getLoadHistory()`
- [ ] Estrutura Redis: `LIST` com `LPUSH` + `LTRIM` pra manter rolling window (100 payments, 100 challenges, 60 load samples)
- [ ] `index.js` substitui `paymentLog.push()` etc. por chamadas no store
- [ ] `total_challenges_issued_session` vira contador permanente (`x402:counters:challenges_total`) via `INCR`
- [ ] `total_payments_session` idem (`x402:counters:payments_total`)
- [ ] `qosStats` totals persistidos em hash (`x402:counters:qos`)
- [ ] Restart do container preserva os números — testado com `docker compose restart x402-shield-mainnet`

### Esforço estimado
~2-3h. Baixo risco — métodos isolados em `lib/store.js`, testes existentes em `test/atomic-consume-redis.test.js` cobrem o pattern.

### Dependências
Nenhuma — Redis já está no stack, padrão `LPUSH + LTRIM` já é usado em `pushAttestation()`.

### Gate decisional
Atacar **antes do 1º cliente pago em produção** ou **antes do hackatom se for usar dashboard /live como demo ao vivo** — o que vier primeiro.

Hoje é OK pular: volume zero, nada a perder.

### Não-objetivos
- Não migrar `requestTimestamps` (rolling 5s pra RPS — volatilidade é aceitável, restart só atrasa cálculo por 5s)
- Não persistir `qosQueue` (fila in-flight — restart já mata os requests pending de qualquer jeito)

---

## 3. Outreach tier 2/3 BR/LatAm

### Contexto
Plano A da `ESTRATEGIA.md` precisa de 1 contrato pago em M+3. Outreach é o caminho. Já existe `docs/outreach/OPERATORS-LIST.md` com 15 operadores mapeados (BR + LatAm + Europa).

### Critério de pronto
- [ ] 5 cold emails enviados nesta semana (templates já em `docs/outreach/EMAIL-TEMPLATES.md`)
- [ ] CRM atualizado em `docs/outreach/TRACKER.md` (já existe)
- [ ] Follow-up estruturado em D+3 e D+7
- [ ] Goal: 1 reunião agendada nos próximos 14 dias

### Esforço estimado
~30 min × 5 emails customizados = ~3h. Follow-up: 15 min/dia.

### Dependências
- Pitch reposicionado (item 1) — pra mensagem ficar coerente
- Demo URLs ativas (já estão)

### Gate decisional
Atacar **assim que pitch reposicionado**. Idealmente disparar antes do hackatom pra ter conversa rolando durante o evento.

### Não-objetivos
- Não atacar Tier 1 (Helius/Triton/Jito) ainda — esperar 2-3 referências consolidadas (per `ESTRATEGIA.md` §2.2)

---

## 4. RFC público x402-priority

### Contexto
**Autoridade de spec é moat estrutural** ([`ESTRATEGIA.md`](./ESTRATEGIA.md) §4). Mesmo sem cliente nenhum, ser quem definiu o padrão muda a conversa em 12 meses.

Draft já existe em `docs/TRUST-SCORE-RFC-DRAFT.md`. Precisa ser limpo, formalizado, e publicado em fórum visível.

### Critério de pronto
- [ ] Draft revisado e splitado em 3 RFCs (já mapeados no `ESTRATEGIA.md`):
  - `x402-priority` — gating + 402 challenge format
  - `x402-trust-score` — formato de reputation, decay, cross-operador attestation
  - `x402-qos-cooperative` — fila cooperativa, bypass, timeout
- [ ] Publicado no Solana Forums (https://forum.solana.com)
- [ ] Cross-post no GitHub Discussions do Solana org
- [ ] Submetido como aplicação ao Solana Foundation Grant Program (track: developer tooling)
- [ ] Tweet thread anunciando, com link pros 3 RFCs

### Esforço estimado
~1 semana de redação + outreach. Médio risco: prosa formal de RFC requer cuidado.

### Dependências
- Decisão sobre licença do código (BUSL-1.1 já decidido)
- Repo permanece privado, mas o **spec é público** (não é o código)

### Gate decisional
Idealmente M+1 (mês depois do hackatom). Não bloqueia outreach mas **fortalece** as conversas comerciais.

### Não-objetivos
- Não publicar repo do Shield (privado per decisão da sessão)
- Não esperar tração comercial — RFCs são primitivas paralelas

---

## 5. Aproveitar hackatom estrategicamente

### Contexto
Hackatom não é objetivo final. É **amplificador**. Goal não é ganhar prêmio — é gerar 1-2 conversas estratégicas com decision-makers do ecossistema Solana.

### Critério de pronto
- [ ] Pitch alinhado com reposicionamento agêntico-first (item 1)
- [ ] Demo URL pronta no slide deck: `https://app.rpcpriority.com/try`, `/live`, `/explorer`
- [ ] **Plano de conversas alvo**: pelo menos 2 nomes de pessoas com quem quero falar antes do evento (Solana Foundation, Helius lead eng, Triton CEO, Jito BD, Colosseum mentor)
- [ ] Tweet thread durante e depois do evento, com métricas reais (38 pagamentos validados, etc.)
- [ ] Material de follow-up: 1-pager versão atualizada do `BENEFICIOS.md` em PDF

### Esforço estimado
~6h de prep + dia do evento.

### Dependências
- Pitch reposicionado (item 1)
- Materiais já existentes em `docs/PITCH-*`

### Gate decisional
**Dia do evento** — não tem como adiar.

### Não-objetivos
- Não focar em "vencer prêmio" como meta primária
- Não adicionar features especulativas pra impressionar (status quo já vende, per discussão da sessão)

---

## Métricas de sucesso M+6 (gate decisional Plano A vs B)

Conforme [`ESTRATEGIA.md`](./ESTRATEGIA.md) §3:

| Métrica | Threshold pivotar pra Plano B | Threshold continuar Plano A |
|---|---|---|
| Contratos pagos | 0 | ≥1 |
| Pubkeys pagantes únicos em mainnet | <50 | ≥100 |
| RFCs com tração (comentários, citações) | 0 | ≥1 |
| Conversa formal com Tier 1 (Helius/Triton/Jito) | 0 | ≥1 |
| Receita acumulada na operator wallet | <0,1 SOL | ≥1 SOL |

**Decisão**: 3 de 5 metas batidas em M+6 → continua Plano A. Senão → ativa Plano B (operador próprio em nicho MEV/liquidação).

---

## Não-objetivos explícitos (decididos nesta sessão)

Não atacar — distração ou erro estratégico:

- ❌ **Wallet adapter / extension / Snap** — discutimos, decidimos status quo. Atrasa Plano A sem mover métricas. Reabrir só pós-M+6 com sinal de demanda.
- ❌ **Fiat onramp / USDC** — nosso ICP (agentes) já tem SOL. Onramp resolve barreira que não é nossa.
- ❌ **Subscription mensal em USDC** — quebra a tese de pay-per-spike. Vira concorrente direto da Helius (3 anos de vantagem).
- ❌ **Substituir Jito ou native fees** — soa delusional. Somos camada complementar, não substituta.
- ❌ **Atacar Helius/Triton primeiro no outreach** — esperar 2-3 referências tier 2/3.
- ❌ **Publicar o repo do Shield** — privado, juízes/parceiros recebem acesso via NDA.
- ❌ **Diluir pitch tentando atender todo mundo** — agentes + bots + indexers são o ICP. Wallet humano é caso secundário.
- ❌ **Pivotar antes de M+6** — gate explícito.

---

## Histórico — feedback do consultor que originou esta lista

Consultor (call em 2026-04-29) disse:

> *"RPC é o ponto de entrada obrigatório para qualquer agente falar com Solana. Agentes vão multiplicar chamadas automáticas: leitura de estado, simulação, arbitragem, trading, monitoramento, execução. O modelo atual de controle é pobre: IP rate limit, API key, plano fixo, whitelist. Isso falha para agentes modernos porque eles rodam em infra elástica, trocam IP, escalam horizontalmente e precisam pagar por uso/prioridade, não por contrato mensal. A solução de vocês não é 'evitar rate limit'; é transformar congestionamento RPC em um mercado de prioridade: quem precisa passar paga por requisição, com identidade criptográfica e reputação."*

E:

> *"Isso exatamente, eu acho que vai fazer muito mais sentido por conta do uso agêntico da rede, não pelo uso atual. O uso atual não existe isso de dar rate limit, né? [...] É muito difícil dar um tipo de rate limit e tal para usuário robusto, talvez para retail, mas aí já tem todo o sistema de FI, tanto o nativo da rede, que é a primeira camada, tanto da JIT, que é a segunda camada de FI, para a priorização de transação. Então essa solução já existe para o usuário normal, ela só não existe para uma camada agêntica."*

**Implicação**: posicionamento "anti-spam de hoje" → "primitiva nativa pra agentic future". Ver item 1.
