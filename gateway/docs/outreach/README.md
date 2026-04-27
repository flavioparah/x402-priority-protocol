# Outreach package — Plano A M+1

> Pacote interno pra abertura de outreach a operadores RPC tier 2/3. Sprint M+1 do Plano A em [`../ESTRATEGIA.md`](../ESTRATEGIA.md).
>
> **Audience:** Flávio (CEO, fará o outreach). Não é material público.

## Quando usar cada arquivo

| Arquivo | Propósito | Audiência efetiva |
|---|---|---|
| [`OPERATOR-PITCH.md`](./OPERATOR-PITCH.md) | One-pager pra anexar ao email (PDF) | Decision-maker técnico do operador |
| [`EMAIL-TEMPLATES.md`](./EMAIL-TEMPLATES.md) | 3 variants de cold email × EN/PT | Flávio antes de cada envio |
| [`OPERATORS-LIST.md`](./OPERATORS-LIST.md) | 15 candidatos curados com angle | Flávio + tracker |
| [`TRACKER.md`](./TRACKER.md) | CRM-lite, single source of truth | Flávio (atualizado em real-time) |
| [`DEMO-FLOW.md`](./DEMO-FLOW.md) | 30-min call playbook | Flávio antes/durante cada demo |

## Sequência de execução (Flávio, esta semana)

```
Dia 1-2  Validar perfis + emails dos 15 em OPERATORS-LIST.md
Dia 3    Personalizar Variants A/B/C pra cada operador (placeholders {COMPANY} etc)
Dia 4    Disparar primeira leva (5 emails de manhã, 5 à tarde, 5 dia seguinte)
Dia 5+   Atualizar TRACKER.md em real-time conforme replies / opens
+7 dia   Bump 1 pros que não responderam
+21 dia  Bump 2 pros que ainda não responderam
+28 dia  Marcar X-declined os silenciosos; reuniões agendadas → DEMO-FLOW
```

## Métricas de validação (M+2)

Sucesso é binário em 3 marcos:

- ✅ ≥ 4 replies de 15 enviados (≥ 27% reply rate é sólido em B2B cold)
- ✅ ≥ 2 reuniões agendadas em M+2
- ✅ ≥ 1 piloto fechado em M+3

Se 0 reuniões em M+2 → iterar EMAIL-TEMPLATES.md (subject lines + opening sentence).
Se 0 piloto em M+3 → ativar Plano B (operador próprio nicho) conforme [`../ESTRATEGIA.md`](../ESTRATEGIA.md) §3.

## Arquivos relacionados (já existentes no repo)

Pra usar **durante** a call ou anexar:

| Arquivo | Quando |
|---|---|
| [`../BENEFICIOS.md`](../BENEFICIOS.md) | Se o operador pedir versão investidor-style |
| [`../QOS-COOPERATIVE-SPEC.md`](../QOS-COOPERATIVE-SPEC.md) | Se eles toparem Path 2 (integração 2-3 dias) |
| [`../TRUST-SCORE-RFC-DRAFT.md`](../TRUST-SCORE-RFC-DRAFT.md) | Se perguntarem sobre federation / cross-op |
| [`../FAQ-DEFENSIVO.md`](../FAQ-DEFENSIVO.md) | Pra preparar respostas a objeções específicas |
| `../../examples/operator-qos-reference.js` | Reference impl ~80 linhas pra mostrar simplicidade |
| `../../test/cooperative-qos.test.js` | 9/9 asserts; prova que a integração funciona end-to-end |

## Provas vivas pra abrir durante a call

| URL | Pra mostrar... |
|---|---|
| https://x402.rpcpriority.com/live | Dashboard com KPIs, payments, leaderboard |
| https://x402.rpcpriority.com/try | 402 challenge real no browser deles |
| https://x402.rpcpriority.com/explorer | Lookup de qualquer pubkey |
| https://github.com/flavioparah/x402-priority-protocol | Código aberto, README, commits |
| https://explorer.solana.com/tx/2fP8DQhypL3hj2Wu4jaEfUVLNJmCTV2j8Nn3VJouhAk1donYaJJrm2DWeyDzUriwF2uQfyqMxooLEXFco7rrfpro | Mainnet tx auditável |
