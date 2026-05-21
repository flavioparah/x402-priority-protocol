# Glossário — RPC Priority Protocol

> **For:** all readers — terms used across the protocol, RFCs, and codebase.
>
> Glossário detalhado para leitores não-técnicos. Inclui termos do protocolo, jargões de blockchain, siglas de negócio e conceitos de mercado citados nos documentos estratégicos.

---

## 1. Termos do nosso produto

### x402
**O que é:** padrão aberto de pagamento HTTP publicado pela Coinbase em 2024–2025.

**Em uma frase:** o status HTTP `402 Payment Required` (que existia mas ninguém usava) foi formalizado num protocolo: o servidor responde 402 com instruções de pagamento, o cliente paga (via assinatura cripto) e refaz a requisição com prova de pagamento.

**Por que importa:** é o "trilho" que usamos. Sem x402, teríamos que inventar nosso próprio padrão de pagamento HTTP. Com x402, qualquer cliente que fala HTTP consegue pagar — não precisa de SDK proprietário.

**Analogia:** é como TLS/HTTPS — um padrão aberto que ninguém é dono mas todo mundo segue.

---

### RPC Priority Protocol
**O que é:** nosso produto comercial. A camada de prioridade paga sobre nós RPC da Solana, usando o trilho x402.

**Em uma frase:** transforma spam em receita para o operador e em acesso prioritário para o agente que paga.

**Site:** `rpcpriority.com`. **Endpoints públicos:** `api.rpcpriority.com` (mainnet canônico), `mainnet.rpcpriority.com` (alias), `devnet.rpcpriority.com` (devnet), `app.rpcpriority.com/try` (try UI).

---

### x402-shield
**O que é:** nome interno do componente servidor (o software que o operador instala). Aparece no código, no nome do container Docker, no `package.json`.

**Em uma frase:** é o "RPC Priority Protocol" do ponto de vista de quem está mexendo com o código.

**Quando usar cada um:**
- Falar com cliente/investidor → "RPC Priority Protocol"
- Falar com dev/SRE → "x402-shield"

---

### Trust-Score
**O que é:** sistema de reputação que dá desconto automático a clientes fiéis. Cada vez que um agente paga uma requisição, sua pontuação sobe; quanto maior a pontuação, menor o preço cobrado da próxima vez.

**Como calculamos:** `score = min(100, número_de_pagamentos × 5)`. Desconto aplicado: `preço × (1 - score/200)`. Score máximo (100) dá 50% off.

**Por que importa:** é o nosso *moat* (barreira competitiva). Quando dados de reputação rodam cross-operador (vários operadores compartilham), novo entrante começa com zero histórico e não consegue oferecer o mesmo desconto que nós.

---

## 2. Solana, blockchain e criptomoedas (lay-friendly)

### Solana
Blockchain de alta performance — promete ~50 mil transações por segundo (vs. 15 da Ethereum), blocos a cada 400 milissegundos. É a chain de escolha para aplicações que precisam de baixa latência: trading, gaming, agentes IA.

### Nó RPC (RPC node)
**RPC** = Remote Procedure Call. É o servidor que fica entre uma aplicação e a blockchain. **Toda aplicação Solana fala com a chain através de um nó RPC** — não tem como pular essa camada. Quando você usa Phantom, Jupiter, Drift, está chamando um nó RPC por trás.

**Operadores comerciais conhecidos:**
- **Helius** — maior operador da Solana, baseado nos EUA, levantou US$ 25M (Series A em 2024). Reporta tráfego na casa de bilhões de requisições/mês.
- **Triton** — concorrente direto, foco em low-latency para traders.
- **Jito** — mais conhecido por MEV (ver abaixo), mas também opera RPC.
- **QuickNode, Alchemy** — operadores multi-chain (não só Solana). QuickNode já valida x402 como trilha de acesso (ver QuickNode docs sobre x402 + Solana x402 agent guide). A diferença do RPC Priority Protocol não é simplesmente cobrar por RPC via 402; é combinar pagamento sob carga, reputação por pubkey e sinais cross-operator via broker neutro.

### Blockchain
Banco de dados distribuído onde cada transação é registrada em "blocos" encadeados. Não tem dono central — é mantido por uma rede de validadores que concordam sobre o estado das contas.

### Validador (validator)
Computador que faz parte da rede Solana e ajuda a produzir blocos novos. Para virar validador, precisa fazer "stake" de SOL (depositar como garantia) e rodar um software pesado. Recebe recompensas em SOL por bloco produzido.

### Wallet (carteira)
Software que guarda suas chaves criptográficas. Não guarda dinheiro — guarda a *prova* de que você é dono dos endereços onde o dinheiro está registrado na chain. Exemplos populares: Phantom, Backpack, Solflare.

### Pubkey / Public key (chave pública)
Endereço da sua carteira na blockchain. Análogo a número de conta bancária — pode ser compartilhado, é como te encontram. Em Solana, parece com `5yNGbq...QzHa9k`.

### Private key (chave privada)
Senha que prova que você é dono da pubkey. **Nunca compartilhar.** Quem tem a private key tem acesso aos fundos.

### Lamport
Menor unidade de SOL. **1 SOL = 1 bilhão de lamports.** Como satoshi para Bitcoin ou wei para Ethereum. Usamos lamports porque dá pra cobrar valores fracionários (1 lamport ≈ US$ 0,00000015 com SOL a US$ 150).

### Devnet vs Mainnet
- **Mainnet** — a rede de verdade, com SOL de verdade
- **Devnet** — rede de teste, com SOL falso (faucet gratuito), pra desenvolvedores não gastarem dinheiro real testando

---

## 3. Mercado de prioridade e MEV

### EIP-1559
**O que é:** "Ethereum Improvement Proposal 1559" — reforma do mercado de gas da Ethereum, ativada em agosto de 2021.

**O que mudou:** antes da EIP-1559, gas funcionava como leilão FCFS (first-come-first-served) — quem pagava mais entrava primeiro. Depois, virou um modelo de duas tarifas:
- **Base fee** — taxa algorítmica calculada por bloco, queimada (sai de circulação para sempre)
- **Priority fee** (gorjeta) — quanto você paga *a mais* para o validador te incluir antes; opcional

**Por que importa:** é o experimento mais caro já feito de "mercado de prioridade". A Ethereum **já queimou mais de US$ 11 bilhões em base fees** desde 2021. Provou que dá pra precificar escassez de blockspace dinamicamente — exatamente o que estamos fazendo um andar acima (escassez de RPC em vez de blockspace).

### MEV (Maximal Extractable Value)
**O que é:** lucro que produtores de bloco (validadores, builders, searchers) conseguem extrair manipulando ordem, inclusão ou exclusão de transações dentro de um bloco.

**Originalmente:** "Miner Extractable Value" no Bitcoin/Ethereum-PoW. Renomeado depois do Merge da Ethereum em 2022.

**Tipos de MEV mais comuns:**
- **Arbitragem** — bot vê SOL a preços diferentes em duas DEXs (ex.: Raydium e Orca), compra na barata e vende na cara no mesmo bloco
- **Liquidação** — bot vê posição de empréstimo abaixo do colateral em Solend ou MarginFi e paga o "liquidation bond" para capturar o desconto
- **Sandwich attack** — bot vê seu swap grande no mempool, faz swap *antes* (move o preço a seu favor), você executa com slippage pior, bot fecha *depois* lucrando a diferença
- **Backrunning de oracle** — atualização de preço do oracle Pyth gera oportunidade que dura milissegundos

**Escala:**
- ~US$ 1,4 bilhão extraído na Ethereum desde o Merge (Sept 2022)
- ~US$ 100 milhões+ extraído na Solana via Jito desde 2023

**Por que importa pra nós:** os **bots de MEV são exatamente o nicho do nosso Plano B**. Eles já pagam US$ 10–50k/mês por RPC premium porque milissegundos = lucro real. Não precisamos criar mercado, só precisamos servi-los melhor.

### Searcher
Bot ou time que monta transações de MEV (arbitragem, liquidação, etc.) e compete com outros searchers para serem incluídos primeiro. Pagam altíssimo por latência baixa.

### Jito Bundles
**O que é:** infraestrutura de MEV da Solana, construída pela Jito Labs. Tem três peças:

1. **Jito-Solana client** — fork modificado do validator client da Solana. Mais de 50% do stake da Solana hoje roda Jito-Solana.
2. **Block Engine** — leilão fora-de-banda onde searchers submetem bundles de transações.
3. **Bundles** — grupos atômicos de transações que ou executam todas juntas ou nenhuma. Cada bundle vem com uma **tip** (gorjeta extra ao validador, separada do priority fee).

**Como funciona na prática:**
1. Searcher monta bundle: `[tx1: comprar SOL na Raydium, tx2: vender na Orca, tx3: tip 0.5 SOL ao validador]`
2. Submete ao Jito Block Engine
3. Block Engine roda leilão entre bundles competindo
4. Bundle vencedor é incluído no próximo bloco
5. Tip dividida ~50% validador, ~50% Jito

**Por que importa pra nós:** Jito opera **dentro** da produção do bloco. Nós operamos **antes** do bloco — na camada de RPC que monta a chamada que vira transação. Jito não concorre diretamente na mesma camada: opera na produção/ordenação de blocos, enquanto o x402-shield atua na camada de acesso RPC.

**Atenção:** Jito tem um produto de RPC também (Jito-RPC). Esse sim é concorrente nosso na camada de RPC, mas não no leilão de bundles. Não confundir.

### Priority fee (na Solana)
Taxa opcional que você paga ao validador da Solana para acelerar inclusão da sua transação no bloco. Diferente do Jito Bundle (que é leilão atômico), priority fee é só "pagar mais por ordem dentro do mempool".

**Por que isso não nos canibaliza:** priority fee serve **transações** (writes — escrever na chain). Mas 80%+ do tráfego RPC é **reads** (`getSlot`, `getAccountInfo`, `getProgramAccounts`) — leitura, não escrita. Reads não pagam priority fee porque não viram transação. **Saturação de leitura é onde mais dói pro operador, e priority fee não resolve isso.** É exatamente o vão que ocupamos.

---

## 4. Aplicações e ecosistema agente IA

### MCP (Model Context Protocol)
Padrão da Anthropic para conectar LLMs (modelos de IA como Claude, GPT) a fontes de dados e ferramentas externas. Permite que o agente IA consulte um banco de dados, chame uma API, leia um arquivo, etc.

**Por que importa:** MCPay e Latinum (concorrentes recentes do Colosseum) cobram por uso de servidores MCP. Eles operam na **camada de aplicação**. Nós operamos na **camada de protocolo** (RPC), que é mais embaixo no stack — toda aplicação Solana passa por nós, não só as que expõem MCP.

### MCPay
Vencedor recente do Colosseum (~US$ 25k em prêmio). Cobra micropagamentos por uso de servidores MCP. Camada de aplicação.

### Latinum
Outro vencedor recente do Colosseum (~US$ 25k). Similar ao MCPay, foco em monetização de agentes IA. Camada de aplicação.

### DeFi (Decentralized Finance)
Conjunto de aplicações financeiras na blockchain que substituem intermediários (bancos, corretoras) por *smart contracts*. Inclui:
- **DEX** (decentralized exchange) — corretora descentralizada (ex.: Raydium, Orca, Jupiter)
- **Lending** — empréstimos colateralizados (ex.: Solend, MarginFi)
- **Stablecoins** — tokens atrelados ao dólar (USDC, USDT)

### Liquidador
Bot que monitora posições de empréstimo em DeFi e, quando uma posição fica abaixo do colateral mínimo, paga a "fee de liquidação" pra capturar o desconto sobre o colateral. **Cliente premium pra RPC** porque milissegundos = ganhar a liquidação ou perder.

### Arbitrador (arbitrageur)
Bot que monitora preços de tokens em diferentes DEXs e captura a diferença comprando na barata e vendendo na cara. **Cliente premium pra RPC** pelo mesmo motivo.

### NFT sniper
Bot que monitora marketplaces de NFT (Magic Eden, Tensor) e compra NFTs quando aparecem listados abaixo do preço de piso. **Cliente premium pra RPC**.

---

## 5. Termos de protocolo HTTP e segurança

### HTTP 402 (Payment Required)
Status code do HTTP que existe na especificação desde 1999 mas nunca foi formalizado. A x402 da Coinbase finalmente deu uso prático a ele.

**Como nós usamos:**
1. Cliente faz `POST /rpc` com JSON-RPC normal
2. Servidor detecta carga alta + identidade desconhecida → responde `402 Payment Required` com headers indicando preço e endereço de destino
3. Cliente assina mensagem com sua chave privada e refaz requisição com header `Authorization: x402 <signature>`
4. Servidor verifica assinatura, debita do escrow, atende a requisição com prioridade

### Ed25519
Algoritmo de assinatura criptográfica (esquema de curva elíptica). É o algoritmo que Solana usa para chaves de carteira. Rápido, seguro, padrão da indústria.

**Por que importa:** o cliente assina cada pagamento com Ed25519 — assinatura é matematicamente impossível de falsificar sem a private key, e dá pra verificar em ~1 ms.

### Nonce
Número usado uma única vez. Em criptografia, serve para impedir **replay attacks** (atacante captura uma assinatura válida e reusa pra fazer várias requisições com um único pagamento).

**Como usamos:** cada requisição traz um nonce único, válido por 30 segundos, e o servidor rejeita qualquer nonce repetido.

### Replay attack
Ataque onde o invasor captura uma requisição válida (incluindo assinatura) e reusa repetidamente. Defesa padrão: nonces + timestamps com janela curta.

### Rate limiting
Técnica clássica de defesa: limitar quantas requisições um cliente pode fazer em uma janela de tempo. Tradicionalmente feito **por IP**.

**Por que IP-based rate limiting é ruim para agentes IA:**
- Lambda muda IP a cada execução
- Containers em ECS/Cloud Run rotacionam IPs
- VPN/proxy compartilha IP entre milhares de usuários

Resultado: agente legítimo é bloqueado e atacante atrás de proxy passa. **Esse é exatamente o problema que resolvemos.**

### API key
Chave de autenticação proprietária emitida pelo operador. Modelo tradicional de cobrança: você assina um plano fixo (ex.: US$ 500/mês) e recebe uma API key.

**Limitação:** plano fixo não cabe em agente IA moderno que executa esporadicamente, em infra serverless, sem contrato pré-definido. **Pay-per-request via x402 é a alternativa que oferecemos.**

### Reverse proxy
Servidor que fica na frente de outro servidor, recebendo requisições e repassando-as. **Nosso server é um reverse proxy:** o operador instala na frente do nó RPC dele, nós interceptamos a requisição, decidimos se cobra ou não, e repassamos pra infra dele.

**Por que importa:** instalação é "5 minutos" porque não exige reescrever o nó RPC. É só apontar o tráfego antes pra nós.

---

## 6. Negócio e estratégia

### B2B / B2C
- **B2B** (Business-to-Business) — vender pra empresa. No nosso caso: vender o software para Helius/Triton/Jito.
- **B2C** (Business-to-Consumer) — vender direto pro usuário final. No nosso caso: ser nós mesmos o operador e cobrar agentes diretamente.

### SaaS (Software as a Service)
Modelo de negócio onde o cliente paga assinatura recorrente (mensal/anual) por software hospedado. Ex.: Salesforce, Slack, Notion. Nossa Opção 2 é vender x402-shield como SaaS para operadores.

### Revenue share
Modelo de cobrança onde o fornecedor recebe um percentual da receita gerada pelo cliente, em vez de licença fixa. Ex.: nós cobramos 5% de cada US$ 1 que o operador captura via 402. Alinha incentivos: nós só ganhamos se o operador ganhar.

### Drop-in (replacement)
Componente que substitui outro sem precisar mudar o código ao redor. Ex.: nosso SDK é "drop-in" para `@solana/web3.js` porque o desenvolvedor só troca `new Connection(...)` por `new X402Provider(...)` — o resto do código continua igual.

### Moat (barreira competitiva)
Termo do mundo de investimento popularizado por Warren Buffett. Significa "fosso ao redor do castelo" — o que protege o negócio de concorrentes. Pode ser:
- **Network effects** (efeito de rede) — quanto mais usuários, mais valioso
- **Switching cost** (custo de troca) — sair pra concorrente é caro
- **Data moat** — dados acumulados que concorrente não consegue replicar
- **Brand moat** — marca reconhecida

**Nosso moat principal:** Trust-Score com efeito de rede em dados cross-operador.

### Network effect (efeito de rede)
Produto que fica mais valioso quanto mais gente usa. Clássico: WhatsApp (sozinho não vale nada; com 2 bilhões de usuários, vale fortunas). **Nosso Trust-Score:** quanto mais operadores conectados, mais dados de reputação cross-operador, mais útil pra cada agente.

### Switching cost
Custo (em dinheiro, tempo, risco) de trocar de um fornecedor para outro. Quanto mais alto, mais o cliente fica travado com o fornecedor atual. Fornecedores B2B amam switching cost; clientes odeiam.

### TAM (Total Addressable Market)
"Mercado endereçável total". Quanto dinheiro existe no mercado todo se conseguirmos 100% dele. **Nosso TAM:** se 1% das requisições RPC mensais da Solana virar prioridade paga a 1 lamport cada, o volume priorizado é da ordem de milhões de dólares/ano.

### MRR (Monthly Recurring Revenue)
Receita mensal recorrente. Métrica favorita de SaaS porque é previsível. **Meta Plano A em M+12:** US$ 50–200k MRR através de 5–15 operadores licenciados.

### Pré-seed / Seed / Series A
Estágios de captação de investimento de uma startup, do mais inicial ao mais maduro:
- **Pré-seed** — primeiro dinheiro de fora, geralmente US$ 100k–500k. É o que estamos pleiteando.
- **Seed** — segunda rodada, US$ 1M–3M tipicamente, depois de provar tração inicial.
- **Series A** — primeira rodada institucional grande, US$ 5M–20M+. Helius levantou Series A.

### Pivô
Mudar a tese do produto/empresa baseado em aprendizado de mercado. **Nosso Plano B é um pivô preparado** (de SaaS B2B pra operador próprio em nicho), não um pivô improvisado.

### Go-to-market (GTM)
Estratégia de como chegar até o cliente: canal de venda, mensagem, preço, parcerias, prova social. **Nossa GTM:** começar por tier 2/3 de operadores (BR/LATAM, menos resistência), provar com case study, depois escalar pra Helius/Triton/Jito.

### Pilot / Piloto
Implementação de teste com cliente, geralmente curta (30–90 dias) e com termos suaves (sem licença fixa, ou revenue share só). Objetivo: gerar case study sem assustar o cliente. **Nosso Plano A propõe piloto 70/30 a favor do operador, sem fixed fee.**

### Harmonic.gg
**O que é:** marketplace aberto de construção de blocos para a blockchain Solana. Validadores rodam um cliente "drop-in" que agrega propostas de bloco de múltiplos builders independentes, otimizando a receita do validador e reduzindo exposição a sandwich attacks.

**Por que aparece nas nossas docs:** o consultor do Colosseum citou Harmonic como exemplo de "infraestrutura neutra na Solana". Importante esclarecer: **Harmonic não concorre diretamente na mesma camada: opera na produção/ordenação de blocos, enquanto o x402-shield atua na camada de acesso RPC.** Mesmo princípio (neutralidade), camada diferente.

### Neutral broker
**O que é:** ator que fica entre concorrentes, não favorece nenhum, e por isso é confiado por todos. Termo do mundo de pagamentos e finanças, popularizado por empresas como Visa, Plaid, Equifax e DTCC.

**Como aplicamos:** o RPC Priority Protocol é o broker neutro **entre operadores Solana** (Helius, Triton, Jito, etc.). Helius não confia dados de cliente à Jito (concorrente direto), mas pode confiar em nós (não somos operador). Essa neutralidade **não pode ser construída por um operador existente** — é o moat estrutural mais importante do Plano A.

**Paralelos diretos:** Visa entre bancos. Plaid entre bancos e apps fintech. Equifax entre credores. DTCC entre corretoras.

### Metcalfe's law
**O que é:** lei empírica de redes formulada por Robert Metcalfe em 1980 (originalmente sobre redes de telecomunicação). Estabelece que o **valor de uma rede cresce proporcionalmente ao quadrado do número de participantes** (≈ N²), porque cada novo nó aumenta o valor para todos os anteriores.

**Por que importa para nós:** justifica matematicamente o moat do Trust-Score. Com 1 operador na rede, valor = 1². Com 5 operadores, valor = 25. Concorrente que tenta lançar Trust-Score próprio começa em N=1 enquanto nós já estamos em N=5 — vantagem **25× maior** que se contássemos só operadores.

**Limite na prática:** Metcalfe puro (N²) é otimista. Na prática vale algo entre N×log(N) e N². Mesmo na versão conservadora, vantagem é não-linear.

### Sybil attack
**O que é:** tipo de ataque em sistemas distribuídos onde um único agente cria múltiplas identidades falsas para ganhar influência desproporcional. Nome vem do livro "Sybil" (1973), sobre múltiplas personalidades.

**Como aparece no nosso domínio:** um atacante poderia tentar criar 100 pubkeys novas, depositar SOL pequeno em cada, e fazer requisições "como se fosse 100 agentes legítimos". 

**Como nosso Trust-Score detecta:** cross-operator. Pubkey criada há horas que aparece em **múltiplos operadores** numa janela curta dispara `sybilRisk` flag. Operador único nunca consegue detectar — só nós, porque vemos a rede inteira. É um dos aggregates não-replicáveis sem broker neutro.

### Acquisition exit
**O que é:** caminho de saída de uma startup via fusão ou aquisição (M&A). Alternativa ao IPO. No mundo de tech, mais de 90% das saídas bem-sucedidas são por aquisição, não IPO.

**No nosso caso (Plano C):** se Jito ou Helius decidirem competir, nosso valor de saída via aquisição depende de quantos operadores integrados temos na rede. Estimativas:
- 0 operadores: US$ 0 (eles constroem do zero)
- 1-2 operadores: US$ 1-3M (acquihire — só time)
- **3-5 operadores: US$ 5-30M (estratégica — rede neutra com efeito de rede)**
- 5+ operadores + RFC autoria: US$ 30-100M (infra crítica)

**Implicação tática:** o moat **não depende de Jito não construir**. Depende de termos **3+ operadores integrados antes** de qualquer concorrente decidir competir. Nesse ponto, eles preferem comprar a construir.

### Agent credit score
Equivalente do "credit score" de pessoa física, mas pra agentes AI. Score baseado em histórico de pagamentos, Trust-Score acumulado e padrões comportamentais. Conceito Tier 3 do nosso roadmap — vender o score pra plataformas de lending DeFi (Solend, MarginFi, Kamino) que poderiam usar como sinal pra empréstimo subcolateralizado a agentes top-tier.

### Cooperative QoS
Modelo de Quality of Service onde o shield envia "priority hint" no header (`X-Priority-Score`) e o operador do nó RPC implementa fila prioritária no próprio stack. Requer integração do operador parceiro (mais lenta, mais profunda). Oposto: Standalone QoS.

### KYC-light
Sinal de "behavior history" usado como complemento — não substituto — à KYC tradicional. Trust-Score com histórico de meses/anos de pagamentos limpos é proxy de "agente legítimo, não funding ilícito". Útil pra operadores em jurisdições com MiCA/GDPR que querem sinal extra de qualidade do cliente sem fazer KYC formal.

### QoS scheduler
Quality of Service scheduler — fila ordenada por prioridade (preço, score) que decide a ordem de despache de requisições. Diferente de gating (passa/bloqueia binário). Em mercados com escassez (Ethereum gas, Solana RPC sob carga), QoS = "mercado eficiente"; gating = "exclusão econômica".

### Standalone QoS
Modelo onde o próprio shield mantém a fila prioritária internamente, antes de despachar pro upstream. Não depende de adoção do operador. Adiciona latência sob alta contenção mas garante ordem por preço. Oposto: Cooperative QoS.

### Tier (Tier 1/2/3/4)
Estágios da expansão estratégica do produto. Tier 1 = single-operator pricing discount (hoje). Tier 2 = cross-operator reputation oracle (Plano A maduro). Tier 3 = Trust-Score-as-a-Service (lending/insurance/marketplace). Tier 4 = universal AI agent passport cross-chain. Cada Tier tem audiência VC e ticket de captação distintos.

### Universal AI agent passport
Visão Tier 4: mesma chave Ed25519 (formato Solana) acumula Trust-Score cross-chain. Agente verificado em Solana traz reputação pra Base, Ethereum, Sui, Aptos, NEAR — qualquer chain compatível com Ed25519 ou que aceite atestados via bridge. Identidade reusável da economia de agentes AI.

### Public Goods (categoria do Colosseum)
Categoria do hackathon Colosseum dedicada a projetos cuja maior contribuição é abrir infraestrutura comum pro ecossistema, em vez de capturar valor sozinho. **Estamos nos posicionando aqui** porque o spec x402-priority aberto vira infra de toda Solana.

---

## 7. Métricas técnicas (números que aparecem no pitch)

### p50 / p95 / p99
Percentis de latência. Em vez de média (que esconde outliers), medimos:
- **p50** = mediana — metade das requisições é mais rápida que isso
- **p95** = 95% das requisições são mais rápidas que isso
- **p99** = só 1% das requisições é mais lenta que isso

**Nossa medição:** **8,7 ms p95** de overhead, medido no benchmark do projeto, sob as condições descritas na documentação técnica. Ou seja, em 95% das requisições, nosso servidor adiciona menos de 8,7 ms ao tempo total. (Meta era < 50 ms — batemos por 6×.)

### Overhead
Tempo adicional que o nosso protocolo introduz em comparação a uma chamada RPC normal sem proteção. Quanto menor, melhor — alto overhead mata adoção.

### Throughput
Requisições por segundo que o sistema aguenta. Medido em RPS (requests per second).

### SLA (Service Level Agreement)
Acordo de nível de serviço — promessa contratual sobre uptime, latência, suporte. Ex.: "99,9% de uptime ou crédito automático na fatura". **No Plano B, vendemos SLA garantido com penalidade — coisa que Helius/Triton não vendem hoje.**

### KPI (Key Performance Indicator)
Métrica-chave de desempenho. As nossas: latência (p95), economia média, % de retenção de agente no operador, MRR.

### Uptime
Percentual do tempo em que o serviço está no ar. 99% = ~7 horas de downtime por mês. 99,9% = ~43 minutos por mês. 99,99% = ~4 minutos por mês. Cada nove a mais é exponencialmente mais caro.

---

## 8. Termos legais / governança

### RFC (Request for Comments)
Documento que descreve um padrão técnico, geralmente publicado para debate público antes de virar consenso da indústria. **Estamos planejando publicar um RFC do x402-priority subprotocol** para virar referência do padrão. Quem é autor do RFC controla a evolução.

### Open source
Código-fonte público, modificável e redistribuível por qualquer pessoa. **Nossa estratégia:** abrir o spec e o server (gera adoção, ninguém precisa pedir permissão pra usar), mas guardar o Trust-Score backend centralizado (é onde está o moat).

### Code license / licença de código
Termos legais que regem o uso do código aberto:
- **MIT** — totalmente liberal, ninguém é obrigado a contribuir de volta
- **Apache 2.0** — similar ao MIT mas com cláusula de patentes
- **GPL** — copyleft: derivados também precisam ser open source
- **AGPL** — copyleft mais agressivo: até serviço web rodando o código precisa abrir

**Nossa escolha tentativa:** Apache 2.0 para spec/server (libera adoção); Trust-Score backend é proprietário (não está no repo open source).

---

## 9. Atalhos e jargões em português

### Drop-in
"Encaixa direto" — termo técnico em inglês que costumamos manter no original em PT.

### Boilerplate
Código repetitivo que aparece sempre igual em vários lugares. Bom protocolo elimina boilerplate.

### Stack
"Pilha" de tecnologias usadas. Stack RPC = nó RPC + balanceador + proxy + monitoração.

### Spec
Especificação. Documento técnico que descreve como algo funciona.

### Push / Pull
- **Push** — você vai até o cliente
- **Pull** — o cliente vem até você

### Ship
Entregar / colocar em produção. "MVP shippado" = MVP entregue, no ar, funcionando.

### POC vs. MVP
- **POC** (Proof of Concept) — só demonstra que a ideia é tecnicamente viável; nem sempre roda em prod
- **MVP** (Minimum Viable Product) — produto mínimo viável; já roda em prod, já dá pra usar

**Nosso estágio:** MVP shippado. Não é POC.

---

**Última atualização:** 2026-04-25.
**Próxima revisão:** quando algum termo novo aparecer no pitch ou em resposta a investidor.
