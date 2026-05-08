# Operator demo call playbook

> 30-min Zoom/Meet com decisor técnico de operador candidato. Objetivo: sair com **uma das três** ações:
> 1. ✅ Acordo verbal de piloto 90-dias (próxima ação: enviar termo + integration guide)
> 2. ⏸ "Vamos pensar e voltar" (próxima ação: bump em 7 dias com material adicional específico)
> 3. ❌ "Não é fit" (próxima ação: pedir refer + atualizar tracker)
>
> **NÃO é objetivo:** fechar contrato comercial completo nesta call. Pilot 90-dias zero-fee é a porta de entrada. Contrato vem em M+3 com case study na mão.

---

## Pré-call (24h antes)

- [ ] Confirmar attendees + papel de cada um (founder? CTO? sales eng?)
- [ ] Reler [`OPERATORS-LIST.md`](./OPERATORS-LIST.md) row do operador — relembrar **dor declarada** e **angle (Variant A/B/C)**
- [ ] Pré-aquecer 3 abas no browser:
  1. https://x402.rpcpriority.com/live (dashboard pulsando)
  2. https://x402.rpcpriority.com/try (botão pronto pra clicar)
  3. https://github.com/flavioparah/x402-priority-protocol (README aberto)
- [ ] Terminal aberto, `cd c:/projetos/x402`, prompt limpo, fonte 18pt+
- [ ] `npm run demo:trust` testado **5 minutos antes** da call (em outra janela) — se falhar internet, screenshot pronto
- [ ] [`OPERATOR-PITCH.md`](./OPERATOR-PITCH.md) PDF aberto pra share screen se precisar
- [ ] Camera ON, microfone testado, fundo limpo

---

## Estrutura (timing)

| Segmento | Tempo | Objetivo |
|---|---:|---|
| 1. Intro + agenda | 0:00–2:00 | Quebrar gelo, alinhar expectativa |
| 2. Confirmar dor | 2:00–5:00 | Eles falam, você escuta |
| 3. Live demo | 5:00–12:00 | A prova ⭐ |
| 4. Integração + deal | 12:00–18:00 | "Como isso entra no stack de vocês" |
| 5. Q&A + próximos passos | 18:00–28:00 | Resolver objeções, fechar piloto |
| 6. Saída | 28:00–30:00 | Calendar, follow-up, agradecer |

**Regra de bolso:** se passou de 30 min, é porque está indo bem (eles estão engajados). Não cortar artificialmente — mas anunciar "olha, passei do nosso tempo, posso continuar 10 min ou agendamos uma 2ª call?". Deixa eles escolherem.

---

## 1. Intro + agenda (0:00–2:00)

**Você:** "Oi {nome}, valeu pelo tempo. Antes de começar — vocês tem 30 min cheios ou preciso ser mais ágil?"

> *(Confirmar tempo. Se 20 min, comprimir seções 4 e 5.)*

**Você:** "Beleza. Plano: 5 minutos pra confirmar se a dor que assumimos no email é real pra vocês, 7 minutos de demo ao vivo do que a gente já tem rodando, e o resto pra discutir se faz sentido testar junto. Pode ser?"

> *(Esperar OK explícito.)*

**Você:** "Perfeito. Pra começar — me conta brevemente, na atual stack de RPC de vocês: como é que vocês precificam carga hoje? API key + plano fixo, é isso?"

> *(Cala. Deixa eles falarem 2 minutos. Você está coletando dados — anote palavras-chave que vão voltar nas seções 3 e 4.)*

---

## 2. Confirmar dor (2:00–5:00)

Pivô conforme o que eles disseram em (1):

**Se mencionaram spam / DDoS:**
> "Faz sentido. E quanto desse tráfego vocês acham que é spam vs legítimo de agente IA?"

**Se mencionaram churn de cliente:**
> "Interessante. Cliente que sai costuma ser o que paga pouco ou o que paga muito?"

**Se mencionaram pricing fixo não escalar:**
> "Isso é exatamente o gap que a gente endereça. Posso te mostrar o que a gente construiu?"

**Se eles falaram pouco / "está tudo bem":**
> "Entendi. Talvez não seja fit pra vocês hoje — mas deixa eu te mostrar 5 minutos do que a gente fez, e vocês me dizem se isso resolveria algum problema futuro."

> 🎯 **Objetivo desta seção:** sair com **uma frase de dor concreta** dita por eles. Vai ser usada no pitch de venda mais tarde.

---

## 3. Live demo (5:00–12:00) ⭐

**Esta é a parte que vence ou perde a call.** Falar mais devagar. Compartilhar tela.

### Demo step 1 — A prova (3 min)

**Você:** "Tudo isso que vou mostrar — não é mock. Roda em produção, agora."

> *(Compartilha tela do navegador em https://x402.rpcpriority.com/live)*

**Você:** "Esse é o dashboard ao vivo do nosso shield. À esquerda, RPC Load atual. Aqui em cima, KPIs — total de pagamentos, volume em SOL, RPS. Esse painel embaixo é o **QoS Priority Queue** — fila ordenada por preço quando há contenção. Tudo refrescando a cada 2 segundos."

> *(Apontar pro número de "Recent Payments" — pode ter dezenas se demo:trust foi rodado recentemente.)*

**Você:** "Esses pagamentos, todos foram processados pelo shield rodando em mainnet. Se vocês quiserem auditar a tx mais recente — podem clicar nessa pubkey aqui e cair no Solana Explorer."

### Demo step 2 — Live curl (2 min)

**Você:** "Vou mostrar o 402 acontecendo agora."

> *(Abrir o terminal já preparado. Rodar:)*

```bash
curl -i -X POST https://x402.rpcpriority.com/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'
```

> *(Mostrar a resposta com headers `X-X402-Amount`, `X-X402-Trust-Score`, `X-X402-Nonce`. Deixar 5 segundos pra eles lerem.)*

**Você:** "402 Payment Required. Header `X-X402-Amount` = preço atual em micro-lamports. `Trust-Score: 0` porque essa chave nunca pagou. Header `Nonce` é o desafio assinado — válido 30 segundos."

### Demo step 3 — Trust-Score progression (3 min)

**Você:** "Vou mostrar o efeito de fidelidade. Roda 22 requisições consecutivas, mesma pubkey, score subindo 5 pontos por pagamento até 100 (= 50% off)."

> *(Rodar:)*

```bash
SHIELD_URL=https://x402.rpcpriority.com npm run demo:trust
```

> *(Esperar 30-45 segundos. Vai aparecer a tabela com barra de progresso. No final mostra 26.1% de economia média.)*

**Você:** "26 por cento de economia média no agente que paga 22 vezes. Esse desconto se aplica **automaticamente** — operador não precisa configurar nada por cliente. E o melhor: assim que vocês entrarem na rede, o cliente que pagou na Helius vai chegar em vocês com Trust-Score já alto. **Vocês recebem cliente fiel pré-aquecido.**"

> 🎯 Olhar nos olhos do cliente. Esperar reação. Esse é **o momento de venda**.

---

## 4. Integração + deal terms (12:00–18:00)

**Você:** "Tem dois caminhos de integração — depende do que vocês querem fazer."

### Path 1: 5 minutos de deploy (sidecar)

> *(Abrir aba do GitHub README.)*

**Você:** "Caminho mais rápido: vocês rodam nosso shield como reverse proxy na frente do RPC de vocês. Sem mudança no validator, sem mudança no stack — é literalmente um `docker compose up`. Vocês configuram a wallet de pagamento, e o shield faz o resto."

> *(Apontar pro snippet de configuração no README.)*

**Você:** "Tempo total: meia tarde."

### Path 2: QoS cooperativo (2-3 dias, premium)

**Você:** "Se vocês quiserem que o pricing por prioridade vá direto pro pool de workers do RPC de vocês — em vez de ficar enfileirado no nosso shield — a gente tem o `x402-qos-cooperative` spec."

> *(Abrir https://github.com/flavioparah/x402-priority-protocol/blob/main/docs/QOS-COOPERATIVE-SPEC.md ou compartilhar o operator-qos-reference.js)*

**Você:** "Vocês implementam ~80 linhas que leem dois headers — `X-Priority-Score` e `X-QoS-Spec-Version` — e roteiam pro próprio scheduler. A gente forneceu uma reference impl funcional. Tempo total: 2-3 dias do time de vocês."

### Deal terms

**Você:** "E pra vocês não terem que arriscar em algo que vocês não testaram — primeiros 90 dias **zero fee**. Vocês quedam 70% de tudo que a gente cobrar via 402. Nós quedamos 30% como platform fee."

**Você:** "Não tem cláusula de saída. Não tem fixed fee. Não tem mínimo de volume. Vocês podem desligar o sidecar a qualquer momento e continua tudo como está — não há lock-in técnico nem comercial."

**Você:** "**O que a gente pede em troca: 30 minutos com vocês ao final dos 90 dias** pra um post-mortem honesto. Funcionou? Não funcionou? O que mudaríamos? Esse é o único compromisso."

> 🎯 **Pause aqui.** Deixe eles digerirem. A pergunta que naturalmente vem é "qual a pegadinha?". A resposta é: nenhuma — vocês são o operador parceiro #1, e nosso primeiro case study vale muito mais do que qualquer fee.

---

## 5. Q&A — guia rápido pra perguntas previstas

| Pergunta | Resposta de bolso (15s) |
|---|---|
| **"Quem mais já tá usando?"** | "Hoje, ninguém em produção sob contrato — vocês seriam o piloto #1. Por isso o deal é 70/30 a favor de vocês: a gente não pode pedir prêmio antes de ter prova social, mas a tecnologia é shippada e auditável." |
| **"E se a gente parar e levar a tecnologia pra dentro?"** | "O server é open-source Apache-2.0 — vocês podem forkar livremente. O que vocês perdem ao sair é o Trust-Score cross-operador, que só funciona como rede neutra entre múltiplos operadores." |
| **"Quanto isso vai custar pros nossos clientes?"** | "Vocês definem. `BASE_PRICE` e `MAX_PRICE` são env vars no shield. Default Cenário 20×: 20 a 1.000 lamports por requisição (~$0,0000017 a $0,000083). Cliente de 1M req/dia paga ~$162/mês efetivo — 3× mais barato que Helius Business. Vocês ajustam pra qualquer lugar." |
| **"E se a Solana inteira tomar nativo?"** | "Improvável em 18-24 meses (foco da Solana Foundation é throughput, não monetização de RPC). Mesmo se acontecer: Trust-Score cross-operador é metadata fora-de-chain — protocolo nativo não vai resolver isso." |
| **"E privacidade dos dados de cliente?"** | "Pubkey é pseudônimo. Não armazenamos IP, não correlacionamos com identidade off-chain. Aggregates podem ser publicados; per-attestation amounts são privados ao operador. Detalhe técnico em `TRUST-SCORE-RFC-DRAFT.md` §6." |
| **"Cobram em lamports — meu cliente quer USD."** | "Vocês definem como cobrar — o sidecar suporta cobrança em lamports (default), mas vocês podem montar plano híbrido: assinatura USD + extra-fee em SOL para spike. A gente conversa." |

> 🚫 **NÃO improvisar respostas:** se você não tem resposta de bolso pra alguma objeção, fala explicitamente "deixa eu te voltar com isso por escrito até amanhã" — anota e retorna mesmo. Promessa não cumprida em 24h destrói confiança.

---

## 6. Saída (28:00–30:00)

### Cenário A — eles toparam piloto

**Você:** "Excelente. Vou te mandar nas próximas 24 horas:
1. Termo simplificado de piloto (1 página, não tem advogado, é um memo de entendimento)
2. Integration guide com checklist passo-a-passo (Path 1 ou Path 2)
3. Calendar invite pra 2ª call em 2 semanas — vocês já vão estar testando, a gente alinha métricas

Posso confirmar que {nome do contato técnico} é o ponto-de-contato técnico pra setup?"

> *(Confirmar. Marcar follow-up no calendar AINDA durante a call.)*

### Cenário B — "vamos pensar e voltar"

**Você:** "Faz sentido. Pra ajudar a decidir — qual material adicional ajudaria? Tenho:
- Vídeo de 5 minutos (Loom) com demo gravada
- Spec técnica completa em PDF
- Termo de piloto pra mandar pro jurídico de vocês
- Reference implementation pra vocês conferirem o código antes de aceitar

Quer que eu te mande algum, ou todos?"

> *(Anotar resposta. Mandar materiais em até 24h. Bumpar em 7 dias.)*

### Cenário C — "não é fit"

**Você:** "Sem problema, agradeço a honestidade. Por curiosidade — se você fosse a gente, a quem você iria atrás primeiro? Tem alguém na sua rede que seria fit melhor?"

> *(Se eles indicarem alguém, é gold. Pedir intro warm.)*

**Você:** "E se daqui a 6-12 meses o contexto mudar — caso vocês mudem de stack, ou a gente tenha N operadores na rede — tudo bem eu te bumpar pra revisitar?"

> *(Geralmente sim. Marcar `X declined` no tracker mas com flag pra re-engage em 90+ dias.)*

---

## Pós-call (30 minutos depois, antes de sair do laptop)

- [ ] Atualizar [`TRACKER.md`](./TRACKER.md): nova linha em "Log de touches", stage atualizado
- [ ] Anotar 3 quotes / palavras-chave deles em "Notes" da row do operador
- [ ] Se cenário A: enviar email follow-up com os 3 anexos prometidos
- [ ] Se cenário B: enviar material específico que eles pediram + calendar invite pro bump em 7 dias
- [ ] Se cenário C: thank-you + ask intro
- [ ] Compartilhar quote-key no Slack/Discord do time (relevante pra próximas calls)

---

## Anti-padrões (não fazer)

🚫 **Não rodar curl ao vivo se a internet for fraca.** Screenshot pré-tirada > demo travada.
🚫 **Não falar de pré-seed nem cap table.** Se eles perguntarem, responder "estamos em conversa, mas isso não afeta o piloto — vocês não precisam esperar a gente fechar rodada".
🚫 **Não criticar Helius / Triton / Jito explicitamente.** "Eles cobram diferente, a gente complementa" é melhor que "eles fazem errado".
🚫 **Não comprometer com features fora do roadmap.** Se eles pedirem "X-chain support" ou "Postgres audit log", responder "não está no roadmap pré-Series-A, mas se virar bloqueador podemos priorizar — quanto vale pra vocês?"
🚫 **Não enviar material ao final da call de cabeça quente.** Manda em 24h, com cabeça fria, com revisão.
🚫 **Não fechar contrato no final da call.** Pilot 90-dias = a porta de entrada. Contrato é depois.

---

## Métricas pós-call (semana 2)

| Métrica | Meta | Implicação |
|---|---|---|
| % das calls que viraram pilot | ≥ 30% | < 30%: deal terms ou demo precisam iterar |
| % das pilots que viraram contract em M+3 | ≥ 50% | < 50%: produto não cumpre o que demo prometeu — investigar |
| Tempo médio email→call | ≤ 14 dias | > 14 dias: outreach não está engajando — iterar subject lines |

Se o funnel passa essas 3 métricas em M+3 (3 meses pós-primeira call), Plano A está validado e a próxima sprint é **levantamento pré-seed** (US$ 150-300k pra escalar a operação comercial).
