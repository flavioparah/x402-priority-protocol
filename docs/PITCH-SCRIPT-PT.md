# Roteiro do Pitch — RPC Priority Protocol

> Roteiro falado, não lido. Fala em português brasileiro, ritmo natural, pausa estratégica antes de cada número. Tempo-alvo: **5 minutos** apresentação + 5–10 min Q&A. Cada bloco abaixo corresponde a um slide do `PITCH-SLIDES-PT.md`. **Alguém que não é desenvolvedor tem que entender. Toda vez que aparecer um termo técnico, traduzir na hora.**

---

## ⏱ Estrutura geral (timing)

| Segmento | Tempo | Slide |
|---|---:|---|
| 1. Hook + capa | 0:00–0:20 | 1 |
| 2. Problema (analogia da rodovia) | 0:20–1:10 | 2 |
| 3. Solução em 3 linhas | 1:10–2:00 | 3 |
| 4. Quem ganha o quê (operador × dev) | 2:00–2:30 | 4 |
| 5. **Prova** (KPIs + demo ao vivo) | 2:30–3:30 | 5 |
| 6. Mercado e timing | 3:30–4:20 | 6 |
| 7. Time + ask | 4:20–5:00 | 7 |

**Regra de bolso:** se passar de 5 minutos, cortar do slide 6 (mercado), não do slide 5 (prova). Prova vence narrativa.

---

## Slide 1 — Capa (0:00–0:20)

> *(Olhar pra plateia. Pausa de 2 segundos antes de começar. Tom: confiante, sem afobamento.)*

**"Boa tarde."**

> *(Pausa.)*

**"Meu nome é Flávio Furtado, sou CEO do RPC Priority Protocol. Comigo no time, João Romeiro como CTO e Felipe Cardoso como DPO."**

> *(Trocar contato visual entre os juízes/consultor enquanto fala os nomes.)*

**"Em cinco minutos vou te mostrar como a gente está transformando o spam que sobrecarrega a rede Solana em receita pro operador de nó e em acesso prioritário pro agente que paga."**

> *(Pausa de 1 segundo. Avançar pro slide 2.)*

**Notas pro apresentador:**
- Não mencionar "x402" ainda. Primeiro vende a *ideia*; o nome do protocolo aparece no slide 3.
- Se a audiência for técnica, pode trocar "agente" por "agente IA". Se leiga, manter "agente" e contextualizar no slide seguinte.

---

## Slide 2 — O problema (0:20–1:10)

**"Imagine uma rodovia pública que engarrafa todo dia."**

> *(Pausa pra a imagem se formar na cabeça do ouvinte.)*

**"Hoje, a defesa contra esse engarrafamento é bloquear placa por placa — bloquear por endereço de IP. Mas o motorista legítimo, que é um agente IA rodando numa Lambda, num container, num serverless... troca de carro toda hora. O IP muda a cada execução."**

> *(Gesticular: mão indo de um lado pro outro, mostrando rotação de infra.)*

**"Resultado:** o motorista certo é bloqueado injustamente. **E o operador do pedágio, do nó RPC?** Ele não ganha nada com o engarrafamento. Spam pra ele é puro custo. **Receita zero.**"

> *(Olhar pra o consultor. Esperar reconhecimento — aceno, expressão de "faz sentido".)*

**"Os grandes operadores — Helius, Triton, Jito — resolveram isso com API keys e planos fixos mensais. Funciona pra empresa que assina contrato. Não funciona pra agente IA moderno, que executa esporadicamente, sem cadastro, sem contrato."**

**"Então hoje você tem dois lados perdendo: operador sem receita extra, agente legítimo bloqueado."**

> *(Avançar pro slide 3.)*

**Notas pro apresentador:**
- Se o ouvinte ficou perdido, parar e desenhar a rodovia num papel. Vale 30s extras pra todo mundo entender.
- A palavra "Lambda" e "serverless" pode soar técnica — substituir por "máquinas que rodam por demanda" se for plateia leiga.

---

## Slide 3 — A solução (1:10–2:00)

**"Nossa proposta é simples: a gente não bloqueia. A gente cobra."**

> *(Pausa. Deixar a frase pousar.)*

**"E faz isso usando um padrão aberto da Coinbase, chamado x402. Pensa no x402 como o **HTTPS do pagamento HTTP** — não é nosso, qualquer um pode usar."**

**"Funciona em três batidas:"**

> *(Apontar pros pontos no slide enquanto explica.)*

**"Primeiro: identidade em vez de endereço. O agente se identifica por uma chave criptográfica — como uma carteira digital. Pode trocar de servidor à vontade que mantém o lugar na fila."**

**"Segundo: preço que respira com a demanda. Quando o nó está folgado, passa de graça. Quando lota, cobra de quem quer prioridade. Não é bloqueio binário."**

**"Terceiro — e essa é a virada de chave: defesa que paga a conta. Quem quer atacar, paga. **A defesa contra spam vira a maior fonte de receita do operador.**"

> *(Olhar pra o consultor. Ênfase máxima nessa última frase.)*

**Notas pro apresentador:**
- Se for um investidor com background cripto, pode mencionar "é um EIP-1559 aplicado à camada de RPC, em vez de blockspace". Isso conecta na hora.
- Se for leigo, NÃO falar EIP-1559. Manter analogia da rodovia.

---

## Slide 4 — Quem ganha o quê (2:00–2:30)

> *(Slide com a tabela de duas colunas — operador × desenvolvedor.)*

**"Pra ficar concreto, quem ganha o quê:"**

> *(Apontar pra coluna da esquerda.)*

**"Operador de nó: spam que era prejuízo agora vira receita recorrente. Cliente fiel ganha desconto automático — chamamos de Trust-Score, e isso é exatamente nosso moat, vou voltar nele em um minuto. Tudo isso com cinco minutos de deploy. É um proxy reverso, não exige reescrever o nó."**

> *(Apontar pra coluna da direita.)*

**"Desenvolvedor de agentes: acesso garantido sem precisar de API key, sem whitelist de IP. Paga só quando precisa — sob carga baixa, passa de graça. E é drop-in no SDK que ele já usa: troca uma linha de código."**

> *(Avançar pro slide 5. Esse é o slide mais importante.)*

**Notas pro apresentador:**
- Não detalhar Trust-Score aqui. Só plantar a palavra. Detalhe se vier pergunta no Q&A.
- Esse slide passa rápido — 30 segundos é suficiente. A tabela faz o trabalho visual.

---

## Slide 5 — Prova (2:30–3:30) ⭐

> *(Esse é o slide mais importante. Falar mais devagar. Olhar nos olhos do consultor.)*

**"Tudo isso que falei até agora, **não é projeção. É medição.**"**

> *(Pausa.)*

**"Primeiro número: oito vírgula sete milissegundos."**

> *(Apontar pro KPI no slide. Pausa.)*

**"Esse é o overhead do nosso protocolo no percentil 95. A meta original do nosso pitch era **abaixo de cinquenta** milissegundos. Batemos por **seis vezes**."**

**"Segundo número: vinte e seis por cento de economia média. Vinte e duas requisições consecutivas, score subindo de zero a cem, desconto aplicado automaticamente. Isso foi rodado em produção, contra o domínio público que vou mostrar agora."**

> *(Tirar o celular do bolso ou apontar pra tela com a aba já aberta.)*

**"Vou rodar agora, ao vivo:"**

```bash
curl -X POST https://x402.rpcpriority.com/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}'
```

> *(Mostrar a resposta na tela.)*

**"HTTP 402, payment required. Header X-X402-Amount com o preço em micro-lamports. Header X-X402-Trust-Score zero, porque essa chave nunca pagou. **Isso aqui está rodando agora, com certificado Let's Encrypt válido. Qualquer juiz, investidor ou operador testa em dez segundos.**"**

> *(Voltar pra audiência. Pausa de 2 segundos.)*

**"O site `rpcpriority.com` é a vitrine. **Esse domínio aqui é o motor.** A diferença é que o motor a gente já tem rodando."**

**Notas pro apresentador:**
- ENSAIAR o curl antes. Se a internet falhar, ter screenshot pronto.
- Se a audiência travar nos números, parar e perguntar: *"Faz sentido isso ser rápido?"* — engajar antes de seguir.
- Esse é o slide que vence o pitch. Tem que ser executado sem fricção.

---

## Slide 6 — Mercado e timing (3:30–4:20)

**"Por que agora?"**

**"Três coisas alinharam:"**

> *(Contar nos dedos.)*

**"Primeira: o protocolo x402 é novo. A Coinbase publicou o spec em 2024 e 2025. Janela de seis a doze meses pra quem chega primeiro virar referência."**

**"Segunda: a Solana está vivendo um boom de agentes IA. Bots de arbitragem, liquidadores, MCP servers, DeFi automatizada — todo mundo multiplicando o tráfego de RPC. O Helius sozinho reporta tráfego na casa de bilhões de requisições por mês."**

**"Terceira: dois concorrentes recentes do Colosseum, MCPay e Latinum, ganharam categorias com prêmios de vinte e cinco mil dólares cada. **Eles cobram pela aplicação. A gente cobra pelo acesso à rede.** Camada diferente, raio de impacto incomparavelmente maior — toda aplicação Solana, não só as que expõem MCP."**

> *(Pausa.)*

**"Tem um precedente que vale citar: a EIP-1559 da Ethereum, que introduziu pagamento por prioridade em 2021, **já queimou onze bilhões de dólares em base fee**. Onze bilhões. Mercado de prioridade não é hipótese — é realidade comprovada. A gente está aplicando o mesmo princípio um andar acima, na camada de RPC, em vez de blockspace."**

**Notas pro apresentador:**
- Se cortar slide por tempo, esse é o slide a cortar. Mas o número da EIP-1559 é o melhor argumento de mercado se sobrar tempo.
- "Onze bilhões" precisa pausar antes e depois pra impactar.

---

## Slide 7 — Time + ask (4:20–5:00)

> *(Slide com fotos ou nome dos três fundadores.)*

**"Sou Flávio. Toco produto e go-to-market. João Romeiro é nosso CTO, construiu o MVP que vocês acabaram de ver rodar. Felipe Cardoso é DPO, cuida de privacidade, contratos B2B e governança do RFC aberto."**

> *(Pausa.)*

**"O que a gente está pedindo:"**

**"Se você é investidor anjo ou fundo: rodada de pré-seed entre cento e cinquenta e trezentos mil dólares pra fechar o primeiro contrato com operador parceiro nos próximos seis meses."**

**"Se você opera um nó de Solana: trinta dias de piloto. Sem licença fixa nos primeiros noventa dias. Você só paga se a gente fizer você ganhar."**

**"Se você é juiz ou consultor do Colosseum: considere a categoria de Public Goods. O spec x402-priority que a gente está consolidando vira infraestrutura aberta de toda a Solana — não só vencedor isolado."**

> *(Pausa. Olhar pra plateia. Sorrir.)*

**"Obrigado. Ficamos aqui pro Q&A."**

> *(Esperar 3 segundos antes de abrir a mão pra perguntas.)*

**Notas pro apresentador:**
- Não corra no fim. O ask é o que o consultor lembra.
- Se for reunião 1-pra-1, adaptar o ask: foco no que ele especificamente pode oferecer (mentoria, intro pra operador, julgamento).
- Mantenha o sorriso no fim — relaxa a sala antes do Q&A.

---

## 🛡️ Q&A — guia rápido pra perguntas previstas

> Detalhe completo está em [`FAQ-DEFENSIVO.md`](./FAQ-DEFENSIVO.md). Aqui vai o resumo de bolso pro Q&A.

| Pergunta provável | Resposta de bolso (15 segundos) |
|---|---|
| "Por que Helius não constrói isso?" | "Pra Helius, isso canibaliza receita atual. Pra nós, é o produto. Eles vão preferir licenciar — depois que tivermos prova com tier 2." |
| "O que impede um clone em 3 meses?" | "Código não defende, dado defende. Trust-Score cross-operador é nosso moat. Helius é o último que convence Triton e Jito a entrar numa rede compartilhada." |
| "Vocês competem com Jito Bundles?" | "Não. Jito é leilão dentro do bloco. Nós somos leilão antes do bloco. Inclusive, searcher de Jito é cliente nosso — ele precisa de RPC rápido pra montar o bundle." |
| "E se Solana publicar RFC nativo?" | "Improvável em 18-24 meses. E se acontecer, nós somos os candidatos óbvios pra implementação de referência — temos seis meses de produção." |
| "Por que não open-source tudo?" | "É justamente o Plano A. Spec aberto, server aberto. **Trust-Score backend fechado.** É o único pedaço com moat real." |
| "Qual o investimento necessário?" | "Cento e cinquenta a trezentos mil pré-seed. Cobre 12 meses, leva a três a cinco contratos B2B com operadores." |
| "E se o piloto falhar?" | "Plano B já desenhado: viramos operador próprio focado em arbitradores e liquidadores. Capital reduzido. Caminho de volta ao Plano A é natural." |

---

## 🎬 Notas de produção (logística)

- **Antes da apresentação:**
  - Abrir aba com `x402.rpcpriority.com` pronta no terminal/celular
  - Testar `curl` na rede do local (wifi do hotel, do hackathon)
  - Plano B se internet falhar: screenshot de resposta 402 pré-tirada + GIF do Trust-Score subindo
  - Imprimir uma cópia de [`ESTRATEGIA.md`](./ESTRATEGIA.md) e [`FAQ-DEFENSIVO.md`](./FAQ-DEFENSIVO.md) — se o consultor cavar, mostrar página específica

- **Durante a apresentação:**
  - Velocidade: ~140 palavras por minuto (lento o bastante pra entendimento)
  - Pausas: 1–2s antes de cada número importante
  - Olhar nos olhos: rotacionar entre 3 pessoas no máximo
  - Movimento: mãos pra frente, ombros abertos. Não esconder atrás do laptop.

- **Adaptações por audiência:**
  - **Investidor sem cripto:** parar no slide 2, desenhar a rodovia no papel. Dedicar 30s extras à analogia. Cortar EIP-1559 do slide 6.
  - **CTO técnico:** acelerar slide 3, gastar mais tempo no slide 5 e no Q&A técnico. Mencionar Ed25519, escrow, replay protection.
  - **Operador de nó:** focar no slide 4 e na frase "5 minutos de deploy". Oferecer demo de instalação ali na hora.
  - **Consultor de hackathon (caso de hoje):** gastar mais tempo no slide 7 (ask + Public Goods). Pedir feedback específico.

- **Depois da apresentação:**
  - Coletar e-mail/contato dos interessados
  - Mandar follow-up em até 24h: PDF do `BENEFICIOS.md` + link pra demo
  - Anotar perguntas que apareceram e ainda não estão no FAQ → atualizar FAQ-DEFENSIVO.md

---

## 🎙️ Versão alternativa — pitch de 60 segundos (elevador)

Caso encontre alguém num corredor:

> "RPC Priority Protocol. A gente faz o spam que sobrecarrega os nós RPC da Solana virar receita recorrente pro operador. Ao invés de bloquear por IP — que pune agente IA legítimo — a gente cobra micro-pagamento por requisição usando o padrão x402 da Coinbase. Cliente fiel ganha desconto automático: até 50% off via reputação. **Já está rodando em produção, com cert válido, em** `x402.rpcpriority.com` **— oito vírgula sete milissegundos de overhead, vinte e seis por cento de economia média medida.** Pré-seed aberta. Conversamos?"

**60 segundos cravados.** Decorar.

---

**Última atualização:** 2026-04-25.
**Próxima revisão:** após primeira apresentação ao consultor, com ajustes baseados no que funcionou e no que travou.
