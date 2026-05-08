# Roteiro — pitch estrito de 2 minutos

Deck: `docs/PITCH-2MIN-RPC-PRIORITY-2026-05-06.html`  
PDF: `docs/PITCH-2MIN-RPC-PRIORITY-2026-05-06.pdf`  
Tempo alvo: **120 segundos cravados**. Deck com 6 slides reais: capa + 5 slides de conteúdo.

---

## Slide 1 — Capa (0:00-0:08)

Somos o **RPC Priority Protocol**: crypto priority and trust infra for the agentic era.  
Criamos uma camada neutra de prioridade em x402 para plugar antes dos nós RPC existentes da Solana.

## Slide 2 — Problema (0:08-0:31)

Solana já opera em escala de **bilhões de chamadas JSON-RPC por dia**.  
Só o Ironforge declara **300 milhões de requests por dia**.  
O problema é que a defesa atual ainda depende de IP, API key e plano fixo. Isso não identifica agentes. Um agente legítimo pode rodar em serverless, trocar de máquina, trocar IP e parecer tráfego ruim. Sem uma camada neutra de reputação, o operador bloqueia demais ou deixa abuso passar.

## Slide 3 — Mercado (0:31-0:52)

Se modelarmos apenas **1 bilhão de chamadas RPC por dia**, 2% de tráfego agentic já representa **20 milhões de requests de agentes por dia**.  
Se esse share chegar a 20% até 2030, são **200 milhões por dia**.  
O x402 ainda está no começo: em requests, a penetração atual contra a escala de RPC da Solana é menor que 0,1%. Essa é a janela.

## Slide 4 — Solução (0:52-1:22)

A nossa solução fica antes do nó RPC que o operador já roda.
O agente recebe um desafio x402, assina com sua chave, paga quando há congestionamento e entra na fila de prioridade.  
O Shield verifica pagamento, aplica Trust-Score e envia tráfego limpo para o operador.  
A pepita de ouro é esta: **não estamos criando só um proxy; estamos criando uma camada neutra de reputação para prioridade na rede Solana.** Sem reputação neutra, prioridade vira só mais uma API key privada. Com a nossa camada, o agente prova histórico econômico, não IP.

## Slide 5 — Modelo (1:22-1:48)

O modelo é **B2A: business to agent**.  
Abstraímos quem está por trás do agente: pessoa física, empresa, bot ou workload enterprise. Quem paga é a chave do agente.  
Temos dois contratos: priority fee por requisição sob demanda para agentes, e contrato enterprise para operadores que licenciam ou hospedam o Shield.  
Num cenário de congestionamento, a camada pode representar de **9 milhões de dólares em GMV em 2026** para **260 milhões em 2030**. Com 5% de take, isso vai de **meio milhão** para **13 milhões de dólares por ano**.

## Slide 6 — Time / Fechamento (1:48-2:00)

Flávio lidera produto e mercado. João lidera arquitetura e implementação. Felipe lidera blockchain, segurança e governança.  
Agora o objetivo é simples: vencer atenção no Frontier, fechar três pilotos com operadores e tornar o Trust-Score a camada neutra de reputação para agentes Solana.

---

## Notas de precisão dos números

- **Bilhões de JSON-RPC calls/dia:** dado público reportado pela Chainstack sobre o ecossistema Solana.
- **300M requests/dia:** dado público da Sanctum sobre Ironforge.
- **20M/dia e 200M/dia:** cenário modelado com base em 1B RPC calls/dia e share agentic de 2% hoje até 20% em 2030.
- **Penetração x402 menor que 0,1% por requests:** proxy comparando weekly Solana x402 transactions abaixo de 510k com escala de bilhões de RPC calls/dia. É uma aproximação conservadora, não métrica oficial de rede.
- **GMV 2026-2030:** cenário de congestionamento, não previsão garantida. Assume mercado Solana RPC de $450M em 2026 crescendo para $1,3B em 2030, com share de tráfego agentic priority-priced de 2% para 20%.
