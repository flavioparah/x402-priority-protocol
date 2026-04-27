# x402-Shield Mainnet Deployment Guide

Este projeto foi isolado e preparado para implantação profissional em **Solana Mainnet**. Ele consiste em um Gateway de alta performance (VPS) e um Dashboard de Gerenciamento (Vercel).

## 📁 Estrutura do Projeto
- `gateway/`: Backend em Node.js para ser instalado em uma VPS.
- `dashboard/`: Frontend estático para auditoria e métricas (Vercel Ready).

---

## 🚀 1. Configuração do Gateway (VPS)

1.  **Acesso à VPS**: Conecte-se via SSH à sua máquina.
2.  **Instalação**:
    ```bash
    git clone <seu-repo>
    cd teste-mainnetx402protocol/gateway
    npm install
    ```
3.  **Configuração de Segurança (.env)**:
    - Copie o arquivo de exemplo: `cp .env.example .env`
    - Edite o `.env` com sua `REAL_RPC_URL` (Helius/Quicknode) e sua `PAYMENT_DESTINATION`.
    - **IMPORTANTE**: Nunca suba o arquivo `.env` para o GitHub.
4.  **Chave Privada**:
    - Salve sua chave de teste em `sender-key.json` apenas para validações manuais se necessário.
5.  **Execução**:
    ```bash
    # Use PM2 para manter o servidor vivo em produção
    npm install -g pm2
    pm2 start index.js --name "x402-shield"
    ```

---

## 🌐 2. Configuração do Dashboard (Vercel)

1.  Acesse o painel da **Vercel**.
2.  Importe a pasta `teste-mainnetx402protocol/dashboard`.
3.  O arquivo `public/index.html` será servido automaticamente.
4.  No Dashboard, aponte o campo **VPS GATEWAY URL** para o IP ou domínio da sua VPS.

---

## 🔒 Segurança e Práticas Recomendadas

1.  **Proteção de Chaves**: O arquivo `.gitignore` já está configurado para ignorar `.env` e `sender-key.json`.
2.  **Rede**: Certifique-se de que a porta `3000` (ou a definida no `.env`) esteja aberta no firewall da sua VPS.
3.  **SSL**: Para produção, utilize Nginx como Reverse Proxy com Certbot (SSL) na VPS para que o Dashboard (HTTPS) consiga falar com o Gateway (HTTPS).

---

Desenvolvido por [vkxtech](https://vkxtech.com.br)
