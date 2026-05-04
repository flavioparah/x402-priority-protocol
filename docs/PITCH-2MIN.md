# Pitch 2 Minutos — RPC Priority Protocol

> **Roteiro falado, não lido.** Tempo-alvo exato: **2:00**.  
> Ritmo: ~130 palavras por minuto com pausas estratégicas.  
> Audiência: investidor, operador de nó, judge de hackathon.  
> Adaptação: se a plateia for não-técnica, substituir os blocos de código por fala descritiva (ver notas).

---

## Estrutura e timing

| Bloco | Tempo | Palavras |
|---|---:|---:|
| 1. Hook — o problema | 0:00–0:22 | ~45 |
| 2. Por que a defesa atual falha | 0:22–0:45 | ~48 |
| 3. Nossa solução em 3 batidas | 0:45–1:10 | ~52 |
| 4. Prova real + os dois comandos | 1:10–1:45 | ~60 |
| 5. Negócio + call to action | 1:45–2:00 | ~32 |
| **Total** | **2:00** | **~237** |

---

## Roteiro completo

---

### Bloco 1 — Hook (0:00–0:22)

> *(Pausa de 1s. Olhar pra plateia. Tom direto, sem afobamento.)*

**"Toda vez que a rede Solana engarrafa — e ela engarrafa todo dia —
o operador de nó não ganha nada com o spam que consome a infraestrutura dele.
Pior: os clientes legítimos são bloqueados junto com os atacantes."**

> *(Pausa de 1s.)*

---

### Bloco 2 — Por que a defesa atual falha (0:22–0:45)

**"A defesa de hoje é bloquear por endereço de IP.
O problema: um agente de IA moderno roda em container, em Lambda, em serverless.
Ele troca de IP a cada execução.
Então o bloqueio derruba o cliente legítimo junto — e ainda não ganha nada com o ataque."**

> *(Breve pausa.)*

---

### Bloco 3 — Solução em 3 batidas (0:45–1:10)

**"Nossa proposta: em vez de bloquear, cobrar."**

> *(Pausa de 1s. Deixar pousar.)*

**"Instalamos um proxy reverso na frente do nó.
Carga baixa — a requisição passa de graça.
Carga alta — o sistema dispara um desafio de pagamento automático,
o agente que quer prioridade paga em SOL, sem cadastro, sem contrato,
e a requisição vai pra frente da fila.
O spam vira receita."**

> *(Pausa.)*

---

### Bloco 4 — Prova real + os dois comandos (1:10–1:45)

**"Isso está rodando em mainnet Solana hoje. Dois comandos explicam tudo."**

> *(Mostrar tela — terminal ou slide com os blocos abaixo.)*

**"Para o operador instalar o Shield:"**

```bash
git clone https://github.com/flavioparah/x402-priority-protocol.git
cp .env.example .env          # configura: carteira Solana + URL do seu nó
docker compose up -d --build  # Shield no ar
```

**"Para o desenvolvedor conectar ao Shield — uma linha de código:"**

```typescript
const connection = new X402Provider(
  'https://api.rpcpriority.com/rpc',
  Keypair.fromSecretKey(agentKey),
  { priorityBudget: 10_000 }
);
```

**"A partir daí, o SDK cuida de tudo. Pico de carga: paga automaticamente e refaz.
Folga: passa de graça. O agente nunca é bloqueado por IP."**

> *(Pausa de 0,5s.)*

**"Números medidos em produção: oito vírgula sete milissegundos de overhead.
Vinte e seis por cento de economia média para o cliente frequente via Trust-Score.
Quarenta e três de quarenta e três testes passando."**

---

### Bloco 5 — Negócio + call to action (1:45–2:00)

**"Piloto de noventa dias: revenue share setenta trinta a favor do operador, zero taxa fixa.
Se não funcionar, não paga."**

> *(Pausa. Olhar direto.)*

**"Obrigado."**

---

## Notas de apresentação

### Se a plateia não é técnica (investidor leigo, não-dev)
Substitua os blocos de código pela fala:

> *"Para o operador: clona o repositório, configura três variáveis — carteira, URL do nó e threshold de carga — e sobe com Docker. Meia hora. Para o desenvolvedor: uma linha de código troca a conexão normal pelo Shield. É tudo."*

### Timing discipline

- Os números do Bloco 4 (`8,7ms`, `26%`, `43/43`) devem ser ditos com pausa de 0,5s **antes** de cada um — não acelerados.
- Se a demo ao vivo atrasar, pule o terminal e vá direto pro slide com os blocos de código — nunca corte os números.
- Se passar de 1:50 no Bloco 5, cortar "zero taxa fixa" e ir direto ao "Obrigado".

### O comando central: por que este e não outro

O comando do cliente é `new X402Provider(url, keypair, config)` porque:
- É o **único ponto de mudança** no código do desenvolvedor — um construtor.
- Toda a lógica de 402, assinatura Ed25519, escrow e retry fica encapsulada no SDK.
- Audiência técnica reconhece imediatamente que é um drop-in do `@solana/web3.js`.
- Audiência não-técnica entende "uma linha" visualmente.

O servidor usa `docker compose up -d --build` porque:
- É o comando real de produção (não um npm start de dev).
- O `--build` garante que o operador compile a versão mais recente.
- Auditável: qualquer pessoa pode clonar e verificar o que está rodando.

---

## Variações por audiência

| Audiência | Ajuste principal |
|---|---|
| **Judge de hackathon** | Enfatizar "primeira implementação x402 em mainnet Solana" no Bloco 4 |
| **Operador de nó Tier 2/3** | Substituir Bloco 5 por: "Sessenta por cento do nosso tráfego de teste veio de agentes sem cadastro — isso seria custo puro pra você. Com o Shield, cada um pagou." |
| **Investidor pré-seed** | Após "Obrigado", adicionar: "Buscamos US$150–300k para fechar três contratos nos próximos noventa dias." |
| **CTO técnico** | No Bloco 4, citar: "Redis-backed com Lua script atômico — anti-replay com garantia de exactly-once sob concorrência." |
