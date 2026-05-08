# Deploy adaptado — RPC Priority Protocol em VPS

> **Por que este doc existe:** instruções simplificadas que circulam na internet (estilo "clone, `npm install`, `pm2 start`, libera porta 3000") **não batem** com a estrutura real do repositório. Este guia traduz essas instruções para o que de fato existe aqui.
>
> Para o guia de produção completo (atualmente em uso em `kvm4`), ver [`DEPLOY.md`](./DEPLOY.md).

---

## Realidade do repo (o que existe de fato)

```
x402-priority-protocol/
├── index.js              ← gateway (Node.js / Express). NÃO há pasta gateway/.
├── lib/                  ← store, detection, qos
├── public/               ← painel estático (index, live, try, explorer)
│                            servido pelo próprio gateway via express.static
├── docker-compose.yml             ← deploy mainnet (x402-mainnet.rpcpriority.com)
├── docker-compose.devnet.yml      ← deploy devnet
├── docker-compose.mainnet.yml     ← deploy mainnet (verificado on-chain)
├── Dockerfile
├── .env.example
└── docs/
    ├── DEPLOY.md                  ← guia completo de produção
    └── DEPLOY-VPS-ADAPTADO.md     ← este doc
```

**Não há** `gateway/`, `dashboard/`, ou `DEPLOY_VPS.md`. O painel estático está em `public/` e é servido pelo gateway na mesma porta da API.

---

## Decisão de arquitetura

### Onde rodar cada peça

| Componente | Onde roda | Como |
|---|---|---|
| Gateway (`index.js`) | VPS (kvm4) | Docker Compose + Traefik (atual) **ou** PM2 bare-metal (alternativa simples) |
| Painel estático (`public/`) | **Mesmo gateway** | `express.static` já configurado em `index.js` — rotas `/`, `/live`, `/try`, `/explorer` |
| Estado (escrow, nonces, reputação) | Mesmo VPS | Redis sidecar via docker-compose (config atual) ou em memória |
| TLS (HTTPS) | Mesmo VPS | Traefik + Let's Encrypt automático |

### Por que não separar o painel estático em Vercel ou nginx separado

O painel **precisa falar com o gateway**. Separar o front-end implica:
- Configurar CORS no gateway
- Adicionar variável de ambiente no painel apontando para a URL do gateway
- Lidar com latência cross-origin
- Manter dois deploys sincronizados em versão

Para hackathon e estágio atual de produção, **a simplicidade vence**. O gateway servir o painel via `express.static` é a configuração correta. Considerar separação somente se aparecer requisito de CDN global ou de deploy independente do front.

---

## Método A — Deploy de produção (Docker Compose + Traefik)

Este é o método **em uso** nos três deploys live (`x402-mainnet`, `x402-devnet`, `x402.rpcpriority.com`).

### Pré-requisitos no VPS (uma vez)

- Docker + Docker Compose instalados
- Rede Docker `portainer_default` existe (`docker network ls | grep portainer`)
- Traefik rodando com `entrypoints=websecure` em `:443` e `certresolver=leresolver`
- DNS apontando para o IP do VPS:
  - `x402.rpcpriority.com` → demo (devnet upstream, trusted-deposit)
  - `x402-devnet.rpcpriority.com` → devnet com depósitos verificados on-chain
  - `x402-mainnet.rpcpriority.com` → mainnet com depósitos verificados on-chain

### Deploy do zero

```bash
# 1. SSH no VPS
ssh kvm4

# 2. Clonar o repo
cd /root
git clone https://github.com/flavioparah/x402-priority-protocol.git x402
cd x402

# 3. Provisionar .env
cp .env.example .env
$EDITOR .env
# Setar:
#   PAYMENT_DESTINATION=<carteira Solana de produção>
#   REAL_RPC_URL=https://api.mainnet-beta.solana.com
#   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
#   ESCROW_TRUST_DEPOSITS=  (vazio em produção; só liga em demo)

# 4. Subir o container principal (mainnet trusted-demo em x402.rpcpriority.com)
docker compose up -d --build

# 5. Subir o devnet companion (depósitos verificados on-chain)
echo "PAYMENT_DESTINATION_DEVNET=<mesma_carteira_ok>" >> .env
docker compose -f docker-compose.devnet.yml up -d --build

# 6. Subir o mainnet companion (depósitos verificados on-chain)
docker compose -f docker-compose.mainnet.yml up -d --build

# 7. Verificar
docker ps | grep x402
curl -s https://x402.rpcpriority.com/health           | jq
curl -s https://x402-devnet.rpcpriority.com/health    | jq
curl -s https://x402-mainnet.rpcpriority.com/health   | jq

# 8. Verificar painel estático (deve responder HTML)
curl -sI https://x402-mainnet.rpcpriority.com/live   | head -1
curl -sI https://x402-mainnet.rpcpriority.com/try    | head -1
curl -sI https://x402-mainnet.rpcpriority.com/explorer | head -1
```

### Atualizar para nova versão

```bash
ssh kvm4
cd /root/x402
git pull
docker compose up -d --build
docker compose -f docker-compose.devnet.yml up -d --build
docker compose -f docker-compose.mainnet.yml up -d --build
```

---

## Método B — Deploy alternativo (bare PM2, sem Docker)

Útil para um VPS mais simples, ambiente de teste, ou se preferir evitar Docker. **Ainda não está em uso em produção** — Traefik faz o TLS no Método A.

### Pré-requisitos

- Node.js 20+ no VPS
- `pm2` instalado globalmente (`npm i -g pm2`)
- Redis (opcional; se não estiver, o gateway usa armazenamento em memória — perde estado em restart)
- Algum reverse proxy à frente para TLS (nginx ou Caddy). **Não exponha 3000 direto na internet — não tem TLS.**

### Deploy

```bash
ssh <seu-vps>

# 1. Clonar
cd /root
git clone https://github.com/flavioparah/x402-priority-protocol.git x402
cd x402

# 2. Instalar dependências (na raiz, não em gateway/)
npm ci --omit=dev

# 3. Provisionar .env
cp .env.example .env
$EDITOR .env

# 4. Iniciar com PM2
pm2 start index.js --name x402-shield
pm2 save
pm2 startup       # configura auto-start no reboot (segue instruções do output)

# 5. Verificar
pm2 status
curl -s http://localhost:3000/health | jq
```

### TLS via nginx (recomendado se for usar Método B)

```nginx
# /etc/nginx/sites-available/x402
server {
    listen 443 ssl http2;
    server_name x402.example.com;

    ssl_certificate     /etc/letsencrypt/live/x402.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/x402.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/x402 /etc/nginx/sites-enabled/
sudo certbot --nginx -d x402.example.com
sudo systemctl reload nginx
```

### Firewall (UFW exemplo)

**Não abra a porta 3000 publicamente.** Apenas 80 e 443 (que o nginx escuta):

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (redirect → HTTPS)
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable
```

---

## Variáveis de ambiente importantes

Conferir em [`.env.example`](../.env.example) para a lista completa. As que mais impactam:

| Variável | Default | Para mudar quando |
|---|---|---|
| `PORT` | `3000` | Conflito de porta no VPS |
| `REAL_RPC_URL` | `https://api.mainnet-beta.solana.com` | Apontar pra um RPC privado (Helius, Triton, ou seu próprio nó) |
| `SOLANA_RPC_URL` | igual ao `REAL_RPC_URL` | Quando o RPC para *verificar depósitos* deve ser diferente do RPC que você está vendendo |
| `PAYMENT_DESTINATION` | `YourSolAddressHere` | **Sempre setar** com a carteira de produção |
| `ESCROW_TRUST_DEPOSITS` | vazio | **Não setar em produção.** Apenas para demos do trust-score progressivo (`x402.rpcpriority.com`). |
| `RPC_LOAD_FORCE` | vazio | Setar `0.9` para forçar 402 em todas as requests durante demo/gravação |
| `REDIS_URL` | vazio | Apontar para Redis (ex.: `redis://redis:6379` em compose, ou `redis://localhost:6379` bare) — se vazio, usa armazenamento em memória |

---

## Verificação pós-deploy

```bash
# 1. Health
curl -s https://<seu-host>/health | jq
# Esperado: {"status":"ok","load":"0.xx","threshold":0.75,"nonces_active":N,"store_backend":"redis"|"memory"}

# 2. Info
curl -s https://<seu-host>/info | jq
# Esperado: {"operator_pubkey":"...","network":"mainnet","shield_url":"...","prices":{...}}

# 3. 402 path
curl -i -X POST https://<seu-host>/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'
# Sob carga >= threshold ou RPC_LOAD_FORCE setado: deve retornar 402 com X-x402-* headers

# 4. Painel estático
curl -sI https://<seu-host>/live   | head -1   # HTTP/1.1 200
curl -sI https://<seu-host>/try    | head -1   # HTTP/1.1 200
curl -sI https://<seu-host>/explorer | head -1 # HTTP/1.1 200

# 5. Stats endpoints (alimentam o painel /live)
curl -s https://<seu-host>/stats/recent | jq '.totals'
curl -s https://<seu-host>/stats/leaderboard | jq '.leaderboard | length'
```

---

## Troubleshooting rápido

| Sintoma | Causa provável | Resolução |
|---|---|---|
| 404 em `/live`, `/try`, `/explorer` | `public/` não foi copiado pra imagem Docker | Verificar que `Dockerfile` tem `COPY public/ ./public/` |
| 502 ao abrir o painel | gateway não subiu | `docker compose logs --tail=50 x402-shield` ou `pm2 logs x402-shield` |
| Cert TLS expirou | Traefik/Let's Encrypt | `docker compose restart traefik` (se for o caso) ou `certbot renew` |
| `/health` responde mas `/rpc` dá 502 | `REAL_RPC_URL` errado ou RPC upstream caiu | Conferir `.env`, testar o upstream com curl direto |
| Estado some no restart | `REDIS_URL` não setado, store em memória | Subir Redis sidecar e configurar `REDIS_URL` |
| Saldo não credita após depósito on-chain | `SOLANA_RPC_URL` apontando pra RPC errado, ou tx ainda não finalizada | Esperar finalização (`DEPOSIT_COMMITMENT=confirmed` é default) e checar logs |

---

## Não confunda

- **Não há** `gateway/` nem `dashboard/` no repo. Não rode `cd gateway` ou `cd dashboard`.
- **Não rode** `npm install` em subpastas — só na raiz.
- **Não exponha** 3000 publicamente sem TLS na frente.
- **Não setar** `ESCROW_TRUST_DEPOSITS=1` em mainnet com carteira real — qualquer um pode creditar saldo sem provar pagamento.

---

## Referências

- [`DEPLOY.md`](./DEPLOY.md) — guia completo, com setup de Traefik, devnet companion e on-chain verify
- [`README.md`](../README.md) — overview do projeto e roadmap
- [`docker-compose.yml`](../docker-compose.yml), [`docker-compose.devnet.yml`](../docker-compose.devnet.yml), [`docker-compose.mainnet.yml`](../docker-compose.mainnet.yml) — definições dos 3 deploys
- [`index.js`](../index.js) — implementação do gateway (Express + proxy + escrow + Trust-Score + QoS)
