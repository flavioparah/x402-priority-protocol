# Os 3 RFCs — resumo executivo

Localização canônica: `docs/rfc/` no repositório. Licença: CC BY 4.0. Período de comments aberto até 2026-06-30. Submetidos como pre-RFC pra Solana Forums e GitHub Solana org Discussions (M+1 da estratégia).

## RFC 1 — x402-priority v1.0 (DRAFT)

**Wire protocol — 402 challenge format + signed retry**

### Escopo
Especifica como uma gateway HTTP gateia requests por carga e pricing dinâmico. Quando carga < threshold, requests passam grátis. Quando carga ≥ threshold, gateway emite 402 com nonce; cliente assina nonce com Ed25519 e retry.

### Componentes
- **Load metric**: sliding-window RPS normalized vs MAX_RPS
- **Pricing curve**: linear entre BASE_PRICE e MAX_PRICE no range gated
- **402 challenge headers**: `X-x402-Status`, `X-x402-Payment-Destination`, `X-x402-Amount`, `X-x402-Amount-Base`, `X-x402-Trust-Score`, `X-x402-Nonce`, `X-x402-Nonce-TTL`
- **Authorization header**: `x402 <bs58sig>.<bs58pubkey>.<bs58msg>` — 3 partes base58 separadas por ponto
- **Atomic consume primitive**: Lua script Redis pra check-and-debit race-free

### Endpoints
- `POST /rpc` — gated proxy
- `POST /escrow/deposit` — verified on-chain
- `GET /info`, `/health`, `/stats/recent`, `/stats/leaderboard`, `/stats/qos`, `/escrow/balance/:pubkey`, `/reputation/:pubkey`

### Security model
- Replay: nonce TTL 30s + atomic check
- Hint spoofing: pubkey hint binda nonce, signer mismatch rejeita
- Operator key compromise: gateway não tem privkey operator (só pubkey)
- Chosen-pubkey: pubkey signed = pubkey in Authorization (enforced)
- DoS: pricing curve + per-IP rate limit = self-limiting económica

### Status implementação
✅ Reference impl em `index.js` + `lib/store.js`. Mainnet validado com 1.000+ paid requests.

---

## RFC 2 — x402-trust-score v0.1 (DRAFT)

**Cross-operator reputation broker**

### Escopo
Camada de reputação que complementa x402. Permite que operadores apliquem desconto baseado em dados (paidCount, churn pattern, sybil risk) sem coordenar diretamente entre si. Broker neutro agrega.

### Por que broker neutro
Mesma justificativa de Visa/Plaid/Equifax/DTCC: operadores não compartilham dados de cliente entre si, mas confiam num agregador não-competidor pra normalizar.

### Data model
```typescript
interface ReputationRecord {
  pubkey: string;                       // base58 Ed25519
  global_trust_score: number;           // 0-100
  paid_count_total: number;
  total_paid_micro_lamports: number;
  active_in_n_providers: number;        // efeito de rede
  loyalty_concentration: number;        // 0-1
  per_provider: { [id]: { score, paid_count, ... } };
  fraud_flags: string[];
  sybil_risk: "low" | "medium" | "high";
  churn_pattern: "stable" | "shopping" | "ephemeral";
}
```

### API
- `GET /reputation/:pubkey` — retorna ReputationRecord (público)
- `POST /attest` — operator reporta sucesso (autenticado por Ed25519 do operator)
- `POST /report` — operator flagra suspeita (categorias: spam_burst, duplicate_signature, wash_payment, payment_dispute, refund_abuse)
- `GET /info` — broker metadata

### Score formula
```
provider_score(pk, p) = min(100, paid_count_at_p × 5)
weighted_avg(pk) = Σ (provider_score × weight(p)) / Σ weight(p)
cross_provider_bonus(pk) = min(1.5, 1 + 0.1 × (active_in_n_providers - 1))
global_trust_score(pk) = min(100, weighted_avg × cross_provider_bonus)
```

**Cross-provider bonus é o moat**: pubkey com score 50 num operador → cap 50. Mesma reputação distribuída em 3 operadores → 60. Em 5 → 70. **Operador novo se beneficia de juntar a rede.**

### Sinais de detection (5)
1. `cross_provider_velocity` — pubkey atestada por ≥3 operadores em <24h com firstSeen <72h → sybil_risk: high
2. `wash_payment_suspect` — operador atesta mesma pubkey >100×/dia com amount constante → flag após 3 dias
3. `coordinated_burst` — ≥10 pubkeys novos em <24h, mesmo subset de operadores → flag em todos
4. `dormant_revival` — lastSeen >90 dias, depois >50 attestations súbitas → churn ephemeral, score frozen 7 dias
5. `cross_provider_dispute` — 2+ operadores reportam mesma pubkey/categoria <24h → dispute weight 3×

### Federation (v1.1, opcional)
Múltiplos brokers cooperativos via gossip. Last-write-wins. Convergência <5min. Designação "primary" é anti-spec — todos brokers são pares.

### Status implementação
✅ Implementado in-process com `index.js` (broker colocado com 1 provider pro MVP). Produção real terá `trust-score-broker` repository separado.

---

## RFC 3 — x402-qos-cooperative v1.0 (DRAFT)

**Operator-side QoS hint protocol**

### Escopo
Define o **mínimo interface** pra operador parceiro cooperar com Shield no scheduling. Shield envia hint de prioridade via header, operador honra (ou retorna overload). Fallback automático pra fila standalone se operador não responder.

### Headers
- **Outbound (Shield → operador)**: `X-Priority-Score: <int>` — score derivado do payment + Trust-Score
- **Inbound (operador → Shield)**: `X-QoS-Overload: 1` no header da response → Shield faz fallback 60s pra fila standalone

### Endpoints (operator-side)
- `OPTIONS /qos-status` — health probe (Shield checa cada 30s)
- `POST /rpc` — request normal, com header `X-Priority-Score`

### Fallback contract
- Operador unreachable >60s → Shield força fallback automático
- 3 sucessos consecutivos durante fallback → Shield retoma cooperative mode antecipadamente
- Cooperative_fallback_until exposto via `/stats/qos`

### Por que existe
Standalone QoS (Shield-only fila) funciona, mas quando o BOTTLENECK é o RPC node em si (CPU, thread pool, mempool depth), só o operador pode:
- Reservar capacidade pra paid requests (worker pools por tier)
- Aplicar quotas per-thread
- Coordenar com QoS interno do validator (Jito-Solana mods)
- Emitir overload signal gracioso

### Status implementação
✅ Implementado em `index.js` (Shield side) + `examples/operator-qos-reference.js` (operator side, ~80 linhas). Integration test em `test/cooperative-qos.test.js`. 12/12 assertions passando.

---

## Por que isso é moat estrutural

1. **Quem define o spec controla compatibilidade futura.** Concorrente que implementa diferente NÃO É COMPATÍVEL com ecossistema.
2. **Trust-Score cross-operator é o único spec onde o broker neutro centralizado é necessário.** Operador único não calcula crossOpScore.
3. **Custo de publicar = ZERO marginal.** Todo o conteúdo já existia em código + docs internas; só foi reorganizado.

Quem busca "Solana RPC priority pricing" no Google ou no Solana Forums passa a achar nosso material primeiro. Helius/Triton monitoram esses fóruns.
