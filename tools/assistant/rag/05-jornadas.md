# Jornadas — cliente-operador (usuário) e node-operador (cliente principal)

## Cliente-operador (USUÁRIO do protocolo)

### Quem é
Bot, dapp, agente IA, indexer, oracle, frontend de DEX, backend de wallet, liquidator DeFi, MEV searcher. Tem SOL na wallet, escala horizontal, rotaciona infra.

### Onde paga
- **Plano A**: ao node-operador parceiro que licencia nosso Shield. Não pra nós.
- **Plano B / fallback / situação atual**: direto pra carteira-operadora `CEH3dGLaYQmYGGwDpszfuBRfcUmBbLNinrSdVdi7k6zp` em mainnet.

### Jornada (6 fases)

1. **Discovery** (5 min): `curl https://api.rpcpriority.com/info` ou abre `app.rpcpriority.com/try` no browser
2. **Avaliação** (15-30 min): roda `tools/pay-test-mainnet.js` ou clica botão no /try
3. **Onboarding** (1h): wallet dedicada (Solflare/Backpack) + 0,001 SOL ($0,17) → integra SDK (1 linha)
4. **Operação** (passiva): tráfego flui, paga só sob carga, monitora via `/escrow/balance/<pk>` e `/reputation/<pk>`
5. **Otimização** (semana 2-4): cache local de reads, batching JSON-RPC, mantém wallet única pra Trust-Score subir
6. **Escala / Saída**: fica recorrente como tier 1; eventual exit = roda próprio nó (mas continua usando Shield como failover)

### Tempo total da descoberta à 1ª request paga em produção: < 2 horas. Sem contrato, sem onboarding humano. **x402 é checkout pra agentes.**

### Personas reais

| Persona | Volume típico | Dor sem nós |
|---|---|---|
| Bot de arbitragem MEV | 10-100 RPS, picos 500 | Tx perdida vale $50-$5k |
| Frontend DEX (Jupiter, Raydium) | 1-50 RPS sustained | UX ruim em pico → churn |
| Agente IA autônomo | 1-20 RPS | Falha silenciosa quando RPC engasga |
| Bot mint NFT | Burst 100+, depois zero | Disputa de slot → perde drop |
| Liquidador DeFi | 10-50 RPS | Janela perdida = dívida ruim |
| Wallet provider backend | 50-500 RPS | Lag visível pros usuários finais |
| Indexer / oracle | 50-200 RPS sustained | Poll alta freq cai sob carga |

---

## Node-operador (CLIENTE PRINCIPAL — Plano A)

### Quem é
Quem opera um nó RPC Solana e quer monetizar prioridade, sem reescrever sua infra. Tipos:

| Tier | Exemplos | Estratégia nossa |
|---|---|---|
| **Tier 1** ($10M+ ARR) | Helius, Triton, QuickNode, Alchemy | Atacar depois de 2-3 referências |
| **Tier 2/3** ($100k-10M ARR) | Yellow Capital, Solbeach, RPCs regionais BR/LatAm/EU | **Foco inicial — ataque imediato** |
| **Tier 4 in-house** | Drift, Pyth, Marinade, wallets | Caso de uso específico |
| **Tier 5 self-hosted** | Indie validators | Open source pega de graça |

### Por que adotam (4 dores que resolvemos)

| Defesa atual | Problema |
|---|---|
| Rate limit por IP | Quebra com cliente Lambda/container/agente IA |
| API key | Friction de cadastro, sem priority real |
| Bloqueio país/ASN | Falsos positivos altíssimos |
| Aceitar spam | Custo operacional alto, latência ruim |

**Nenhuma dessas vira receita.** Nós: spam vira receita; identidade criptográfica resolve IP-rotation; Trust-Score recompensa cliente fiel automaticamente; SKU novo (priority pago) sai da matriz de planos fixos.

### Modelo comercial — 3 streams complementares

**Stream 1 — Licença SaaS por instância**
| Tier | Volume mensal | Preço |
|---|---|---|
| Starter | < 10M req/mês | $500/mês |
| Growth | 10-100M | $1.500/mês |
| Scale | 100M-1B | $3.000/mês |
| Enterprise | >1B | $5.000+ custom |

**Stream 2 — Revenue share opcional**: 5% dos priority fees coletados pelo operador (alternativa ou complemento à licença).

**Stream 3 — Trust-Score Premium**: $200-500/mês adicional pra acesso ao dataset cross-operador (`crossOpScore`, `loyaltyScore`, `sybilRisk`, `fraudAlert`, webhook tempo real).

**90 dias zero rev-share**: pra reduzir resistência inicial. Operador só paga depois de validar que está ganhando.

### Jornada de venda (6 fases, 3 meses ciclo típico tier 2/3)

1. **Discovery** (1-2 sem): cold email, indicação, repo público, Solana Forums, conferência
2. **Avaliação técnica** (3-10 dias): leitura de RFCs + repo + roda devnet shield
3. **Piloto 30 dias**: install via Docker Compose (10 min), rollout gradual (passive → 402 horário noturno → 402 100% threshold alto → threshold otimizado)
4. **Negociação comercial** (1-2 sem): após dados concretos do piloto
5. **Onboarding produção** (1 mês): suporte 1ª linha (operador), 2ª linha (nós via Slack), updates regulares
6. **Operação contínua**: pricing tuning, Trust-Score Premium upsell, multi-region scale

### Setup técnico (10 min)

```bash
git clone <repo>/rpc-priority-protocol-server shield
cd shield
cp .env.example .env
# Editar: PAYMENT_DESTINATION (sua wallet), REAL_RPC_URL (seu RPC)
docker compose up -d --build
```

Traefik label exemplo (Plano A vai com domínio do operador):
```yaml
labels:
  - "traefik.http.routers.shield.rule=Host(`rpc.minha-empresa.com`)"
  - "traefik.http.routers.shield.tls.certresolver=letsencrypt"
```

### Risco principal e mitigação

**Operador faz fork sem licença**: BUSL-1.1 dá brecha de interpretação. Mitigação:
- Trust-Score broker centralizado fica nosso (cliente fiel discount = nosso dataset)
- API de attestation cross-operator
- Webhook de fraude tempo real
- Operador que fork sem licença oferece produto inferior — cliente final percebe

### Sequência de outreach (próximos 90 dias per ESTRATEGIA.md)

- **M+1**: Open-source da spec (não código completo) — consolida autoridade
- **M+2**: Primeiro piloto operador parceiro brasileiro (split 70/30 favor dele, sem licença fixa)
- **M+3**: Caso de uso documentado (latência + receita medidas) → outreach tier 2
- **M+6**: Gate decisional. Sem contrato pago = ativa Plano B
