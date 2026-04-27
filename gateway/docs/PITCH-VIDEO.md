# Pitch video script — 3 minutes

Target: Colosseum Frontier hackathon submission video. Loom-recommended.

Audience: Solana engineers, RPC operators (Helius, Triton, Jito), Colosseum judges. They've seen dozens of payment-layer projects this cycle. The challenge is to show that **we are not another one** — we're one layer below.

Format: one shared screen with a terminal on one side and the speaker video on the other. Two terminals during the demo.

---

## 0:00–0:20 — Hook (Flávio, CEO)

> "Solana RPC nodes get spammed all day. Operators defend with IP rate limits, which punish the very AI agents they want as customers — the ones rotating Lambda, containers, cloud bursting.
>
> Spam is pure cost. It should be revenue."

*[Cut to title card: **x402-shield** — HTTP 402 priority gate for Solana RPC.]*

Goal of this segment: name the pain in 15 seconds, so the rest of the video is obviously useful.

---

## 0:20–0:50 — The idea (João, CTO)

> "x402 is Coinbase's new HTTP payment status. We use it as a **protocol-level economic negotiation**. Not an error — a handshake.
>
> When our Shield sees load, it responds `402 Payment Required` with a signed challenge: destination wallet, price, nonce. The agent signs the payload with its Ed25519 key — the same key that pre-funded an escrow on the Shield — and retries. We verify the signature, debit the escrow, forward to the RPC.
>
> No API keys. No IP whitelists. No on-chain confirmation wait. The whole handshake is sub-10 milliseconds."

Visual: the protocol diagram (`x402_protocol_architecture.svg`) animated in 3 frames matching the 5 steps.

---

## 0:50–2:00 — Live demo (split screen)

Two terminals on screen. **No cuts.**

**Terminal 1 — Shield**, already running. Visible header:

```
╔══════════════════════════════════════════════════════╗
║              x402-Shield  v0.1.0  (MVP)              ║
║  Listening  : http://localhost:3000/rpc              ║
║  Upstream   : https://api.devnet.solana.com          ║
╚══════════════════════════════════════════════════════╝
```

**Terminal 2** — run `npm run demo`. The agent logs walk through all 5 steps with color coding:

```
── Step 1 ─ Generating agent keypair
  [Agent]  pubkey: Bv7qCtTYSTsT…2GUw

── Step 2 ─ Pre-funding escrow
  [Shield] escrow credited — balance: 100000 µL

── Step 3 ─ Sending RPC request without payment
  [Shield] 402 Payment Required issued
  [Agent]  challenge — amount=46943 µL  nonce=4965df34dc…  ttl=30s

── Step 4 ─ Evaluating budget & signing payload
  ✓ budget check: 46943 ≤ 50000
  [Agent]  signed 174-byte payload with Ed25519
  [Agent]  auth header: x402 3gSTTwm16B53XkjXCoNAot929fyU…

── Step 5 ─ Retrying with payment proof
  [Shield] signature verified — escrow debited 46943 µL
  [Agent]  RPC response: {"jsonrpc":"2.0","result":"ok","id":"1"}
  [Shield] remaining balance: 53057 µL  (started with 100000)
```

At the end of the demo, jump to terminal 1 and show the Shield's log echoing `Payment accepted from <pubkey> (46943 µL, nonce: 4965df34dc…)`.

Voiceover through the demo (João): narrate each step as the lines appear — don't explain what viewers can already read, explain *why*:

- At step 3: *"The Shield sees load and gates the request. The 402 is a signed invoice."*
- At step 4: *"Agent signs locally. No server round-trip for auth — just Ed25519, 4 ms."*
- At step 5: *"Shield verifies, debits the escrow, forwards to devnet. Real Solana response."*

---

## 2:00–2:30 — Numbers + positioning (João)

Single slide. No terminal.

**Left side — the KPI:**

> "End-to-end benchmark, 100 samples: x402 handshake overhead **8.3 ms p95**.
>
> Our target was under 50. We're at one-sixth."

**Right side — the positioning:**

> "MCPay and Latinum won prizes this cycle for payment layers above MCP — the application layer.
>
> We're one layer below. This is payment on the protocol itself, between the agent and the RPC node. Every MCP, every DeFi bot, every indexer talks to RPC. That's the blast radius."

*Optional one-line ping: "and yes, we ship open-source. Week 3."*

---

## 2:30–3:00 — Team + roadmap + ask (Flávio)

Team card on screen:

- Flávio Furtado — CEO
- João Romeiro — CTO
- Felipe Cardoso — DPO

> "Three-week plan:
>
> **Week 1** — working MVP. You just saw it.
>
> **Week 2** — Trust Score. Recurring agents with clean history pay progressively less. Reputation as Sybil defense without breaking pseudonymity.
>
> **Week 3** — Open-source protocol spec plus a network of RPC operator partners. We're targeting Helius, Triton, and Jito — operators who already monetize priority and for whom this is a drop-in revenue layer.
>
> We're building the economic layer of Solana's agent economy. Thank you."

---

## Production notes

- **Recording tool:** Loom. Record at 1080p, screen plus speaker cam. Both faces on the team segments — don't hide behind the terminal.
- **Pre-record the demo** in one take so the logs scroll naturally. If anything fails, rerun from scratch — don't splice.
- **Shield settings for the recording:**
  `RPC_LOAD_THRESHOLD=0` to guarantee a 402 on the demo request.
- **Audio:** room-quiet, no open laptop fans. Headset mic, not laptop mic.
- **Subtitles:** generate with Loom's auto-captions, then hand-correct the technical terms (x402, Ed25519, micro-lamports, pubkey, nonce).
- **Background music:** none during the demo. A light bed is fine for the intro/outro if the team has something royalty-free.
- **Length discipline:** aim for 2:50, leave 10 s buffer. Run over 3:00 and you get cut from submissions.

## Shot list

| Segment | Duration | Speaker | Screen |
|---------|----------|---------|--------|
| Hook | 0:20 | Flávio | Title card |
| Idea | 0:30 | João | Protocol diagram, 3 frames |
| Demo | 1:10 | João | 2 terminals, live run |
| Numbers + positioning | 0:30 | João | KPI + MCPay/Latinum comparison slide |
| Team + roadmap + ask | 0:30 | Flávio | Team card + 3-week roadmap |

Total: 3:00.
