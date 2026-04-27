# Outreach tracker

> CRM-lite para a primeira onda de outreach do Plano A. Atualizar **em real-time** logo após cada touch (email enviado, reply, meeting, etc.). Single source of truth.
>
> **Stages:**
> `0` cold (não contatado ainda)
> `1` emailed (V1 enviada)
> `2` bumped (follow-up enviado)
> `3` replied (qualquer reply, positivo ou negativo)
> `4` meeting-scheduled
> `5` meeting-done
> `6` piloting (90-dias zero-fee ativo)
> `7` contracted (pós-pilot, com SaaS / revenue share)
> `X` declined (recusa explícita ou silêncio pós-2-bumps)

> **Owner:** Flávio (todos hoje). Escalar pra co-CEO/BD em M+3 se MRR > US$ 50k.

---

## Snapshot atual

> Atualizar este sumário toda sexta-feira.

| Métrica | Valor |
|---|---|
| Total de operadores na lista | 15 |
| Emails enviados | 0 |
| Open rate (proxy: replies / sent) | — |
| Replies | 0 |
| Reuniões agendadas | 0 |
| Reuniões realizadas | 0 |
| Pilots ativos | 0 |
| Contratos fechados | 0 |
| Declined | 0 |
| Pendência semana corrente | preparar primeira onda (validação de perfis) |

---

## Tracker principal

| # | Operator | Tier | Region | Variant | Contact (name + email) | Stage | Date sent | Last touch | Next action | Owner | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Syndica | 2 | Toronto | A | Sebastian Bor (CEO) — confirmar email | 0 | — | — | Validar perfil + email | Flavio | Solana-native; Stake-Weighted QoS é o competidor mais direto da nossa proposta |
| 2 | Chainstack | 2 | EU/SG | A | Eugene Aseev (founder) — LinkedIn | 0 | — | — | Validar perfil + canal | Flavio | Multi-chain, Solana é minoria — ângulo: linha extra de receita sem mexer em nada |
| 3 | Ankr | 2 | US/SG | A | Stanley Wu (CTO) / business@ankr.com | 0 | — | — | Validar perfil | Flavio | Decentralized fit; possível parceria estratégica em vez de cliente |
| 4 | DRPC | 2 | EU | A | team@drpc.org / Discord | 0 | — | — | Validar perfil | Flavio | Open-source decentralized; fit técnico forte |
| 5 | GetBlock | 2 | EU | A | sales@getblock.io | 0 | — | — | Validar | Flavio | — |
| 6 | Blockdaemon | 2 | US | A | sales@blockdaemon.com (SDR funnel) | 0 | — | — | Validar; ciclo enterprise longo | Flavio | Angle compliance/KYC-light |
| 7 | NodeReal | 2 | SG | A | sales via formulário | 0 | — | — | Validar | Flavio | Binance Labs portfolio |
| 8 | BlockPI | 2 | China | A | contact@blockpi.io / Discord | 0 | — | — | Validar | Flavio | — |
| 9 | Tatum | 2 | EU | A | Jiri Kobelka (CEO) — LinkedIn | 0 | — | — | Validar | Flavio | Foco SDK alinha com nossa filosofia open-source |
| 10 | Lava Network | 2 | Decentralized | A* | Yair Cleper (CEO) — Twitter @yair_lava | 0 | — | — | Validar; pitch como spec partnership | Flavio | Best fit — possível Federation v1.1 testbed |
| 11 | P2P.org | 2 | Global | B | Konstantin Boyko (CEO) — LinkedIn | 0 | — | — | Validar | Flavio | Validator + RPC institucional |
| 12 | Stakefish | 2 | APAC | B | Chun Wang (founder) — LinkedIn | 0 | — | — | Validar | Flavio | — |
| 13 | Marinade Finance | 2 | Solana-native | B | DAO — abordar via Discord + público em conferência | 0 | — | — | Identificar CTO público | Flavio | DAO; pode precisar 2 conversas |
| 14 | Drift Protocol | 3 | Solana-native | C | cindy@drift.trade (head of growth) | 0 | — | — | Validar | Flavio | Pitch: signal Trust-Score grátis (não vender RPC) |
| 15 | MarginFi | 3 | Solana-native | C | Edgar Pavlovsky — Twitter @edgarpvlsky | 0 | — | — | Validar | Flavio | Mesmo angle do Drift |

---

## Funnel visual (atualizar semanalmente)

```
0 cold      ████████████████ 15  (100%)
1 emailed   ░░░░░░░░░░░░░░░░  0
2 bumped    ░░░░░░░░░░░░░░░░  0
3 replied   ░░░░░░░░░░░░░░░░  0
4 meeting   ░░░░░░░░░░░░░░░░  0
5 done      ░░░░░░░░░░░░░░░░  0
6 piloting  ░░░░░░░░░░░░░░░░  0
7 contract  ░░░░░░░░░░░░░░░░  0
X declined  ░░░░░░░░░░░░░░░░  0
```

Meta M+1 → M+2:

```
0 cold      ░░░░░░░░░░░░░░░░  0   ← todos saíram do cold
1 emailed   ░░░░░░░░░░░░░░░░  0   ← passaram pra bumped ou replied
2 bumped    ████████░░░░░░░░ ~6   (não responderam ao 1º email)
3 replied   ████░░░░░░░░░░░░ ~4
4 meeting   ██░░░░░░░░░░░░░░  2   ← meta crítica
5 done      ░░░░░░░░░░░░░░░░  0   (acontece na semana seguinte)
6 piloting  ░░░░░░░░░░░░░░░░  0
7 contract  ░░░░░░░░░░░░░░░░  0
X declined  ████████░░░░░░░░ ~6
```

Se em M+2 (4 semanas após primeiro envio) `meeting >= 2`, a tese GTM funciona. Se `meeting == 0`, problema é subject line ou audiência — iterar antes de continuar.

---

## Log de touches (append-only)

> Toda interação (envio, reply, call, no-show) gera uma linha aqui. Não editar histórico, só adicionar.

| Date | Operator | Action | Owner | Outcome | Notes |
|---|---|---|---|---|---|
| 2026-04-26 | (sistema) | tracker criado | Flavio | — | 15 candidatos curados em OPERATORS-LIST.md |

---

## Templates de status update interno (Slack / Discord do time)

**Daily (durante semana de outreach):**
```
Outreach update {DATE}:
- Sent: X (today) / Y (cumulative)
- Replies: Z (Y/X open-equivalent)
- Meetings booked: W
- Next 24h: next batch / specific reply to handle
```

**Weekly (sextas):**
```
Outreach week N recap:
- Funnel: 0:X / 1:Y / 2:Z / 3:W / 4:V / 5:U / 6:T / 7:S
- Best-performing variant: A | B | C
- Worst-performing subject: "..."
- Key replies this week: {nomes + status}
- Decision: {continue current strategy / pivot / activate plan B}
```

---

## Anti-spam rules (obrigatórias)

1. **Nunca >2 follow-ups por operador** sem mudança material de contexto.
2. **Nunca BCC** ou send-all em massa — toda mensagem é 1-pra-1, tracker tem linha individual.
3. **Domínio:** sempre mandar de `flavio@rpcpriority.com`, nunca pessoal Gmail (deliverability).
4. **Volume:** máximo 5 envios por dia, espalhados ao longo do dia. Burst de 15 dispara filtros de spam.
5. **Re-engage:** após `X declined`, não reabordar antes de 90 dias E sem mudança material (novo case study, novo produto, marco público).

---

## Ferramentas (a configurar)

- **Email:** Gmail/Workspace direto OU [Lemlist](https://lemlist.com) / [Apollo.io](https://apollo.io) se volume crescer
- **Tracking de open/click:** [Mailtrack](https://mailtrack.io) free tier (sufficient pra 15)
- **Calendar:** [Cal.com](https://cal.com) ou Calendly (link no sign-off de cada email após reply)
- **Demo recording:** [Loom](https://loom.com) — gravar 5-min walkthrough da demo:trust pra anexar em emails frios
- **CRM upgrade path:** Notion ou Airtable se passar de 50 operadores; Hubspot só com pré-seed levantado
