#!/usr/bin/env node
/**
 * tools/stress-test/spawn-agents.js
 *
 * Multi-agent setup phase. Generates N ephemeral Ed25519 keypairs and
 * funds each one's escrow on the Shield.
 *
 * Two modes (chosen via MODE env var):
 *
 *   MODE=demo    (default)  Use demo.rpcpriority.com + /escrow/deposit-trusted
 *                           NO on-chain transactions. Instant setup, free.
 *                           Validates: protocol, atomic-consume, Trust-Score,
 *                           leaderboard, anti-sybil, Redis persistence,
 *                           concurrency.
 *
 *   MODE=mainnet            Use api.rpcpriority.com + 2-step on-chain funding
 *                           (treasury→agent SOL transfer, then agent→operator
 *                           deposit signed by agent). Costs ~6k lamports tx
 *                           fees per agent + the funding amount. Slow (2N
 *                           confirmations). Use only for end-to-end mainnet
 *                           validation.
 *
 * Usage:
 *   node tools/stress-test/spawn-agents.js                                 # demo, 30 agents
 *   AGENTS=50 node tools/stress-test/spawn-agents.js                       # demo, 50 agents
 *   MODE=mainnet TREASURY_SECRET_KEY=<bs58> AGENTS=50 \
 *     node tools/stress-test/spawn-agents.js                               # mainnet, 50 agents
 *
 * Optional env:
 *   AGENTS                       N agents (default 30)
 *   FUND_MICRO_LAMPORTS          escrow µL per agent (default 10_000_000 = 10M µL ≈ 500 paid req)
 *   FUND_LAMPORTS_PER_AGENT      mainnet only: lamports treasury sends per agent (default 10000)
 *   AGENTS_FILE                  output path (default tools/stress-test/agents.json)
 *   PARALLEL                     concurrency (default 5 for mainnet, 20 for demo)
 *   SHIELD_URL                   override (defaults: demo→demo.rpcpriority.com, mainnet→api.rpcpriority.com)
 *   RPC_URL                      mainnet only (default https://api.mainnet-beta.solana.com)
 */

const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");

const MODE = (process.env.MODE || "demo").toLowerCase();
if (!["demo", "mainnet"].includes(MODE)) {
  console.error(`Error: MODE must be "demo" or "mainnet" (got "${MODE}")`);
  process.exit(1);
}

const SHIELD_URL = process.env.SHIELD_URL || (MODE === "mainnet"
  ? "https://api.rpcpriority.com"
  : "https://demo.rpcpriority.com");
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const AGENTS = parseInt(process.env.AGENTS || "30", 10);
const FUND_MICRO_LAMPORTS = parseInt(process.env.FUND_MICRO_LAMPORTS || "10000000", 10);
const FUND_LAMPORTS = parseInt(process.env.FUND_LAMPORTS_PER_AGENT || "10000", 10);
const AGENTS_FILE = process.env.AGENTS_FILE || path.join(__dirname, "agents.json");
const PARALLEL = parseInt(process.env.PARALLEL || (MODE === "mainnet" ? "5" : "20"), 10);

const TREASURY_SECRET = process.env.TREASURY_SECRET_KEY;
if (MODE === "mainnet" && !TREASURY_SECRET) {
  console.error("Error: MODE=mainnet requires TREASURY_SECRET_KEY env var (base58 of treasury 64-byte secret).");
  process.exit(1);
}

const paint = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const ok = (m) => console.log(`  ${paint("32", "✓")} ${m}`);
const warn = (m) => console.log(`  ${paint("33", "!")} ${m}`);
const err = (m) => console.log(`  ${paint("31", "✗")} ${m}`);

async function fundAgentDemo(agent, operatorPubkey) {
  // Trusted-deposit path: tell the demo Shield to credit the agent's escrow
  // directly, no on-chain tx required.
  const r = await fetch(`${SHIELD_URL}/escrow/deposit-trusted`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pubkey: agent.pubkey,
      amount_micro_lamports: FUND_MICRO_LAMPORTS,
    }),
  });
  if (!r.ok) throw new Error(`deposit-trusted ${r.status}: ${(await r.text()).slice(0, 100)}`);
  const dep = await r.json();
  agent.escrowBalance = dep.balance;
}

async function fundAgentMainnet(agent, treasury, operator, conn) {
  // Step 1: Treasury sends SOL to AGENT's address (covers deposit + tx fee).
  // The agent needs SOL on-chain because the Shield credits whoever signs the
  // deposit transaction. We need the AGENT to be the signer of the deposit tx.
  const totalToSend = FUND_LAMPORTS + 5500; // funding + 1 tx fee
  const tx1 = new Transaction().add(SystemProgram.transfer({
    fromPubkey: treasury.publicKey,
    toPubkey: new PublicKey(agent.pubkey),
    lamports: totalToSend,
  }));
  await sendAndConfirmTransaction(conn, tx1, [treasury], { commitment: "confirmed" });

  // Step 2: Agent (now with SOL) sends FUND_LAMPORTS to operator.
  const agentKp = Keypair.fromSecretKey(bs58.decode(agent.secretKey));
  const tx2 = new Transaction().add(SystemProgram.transfer({
    fromPubkey: agentKp.publicKey,
    toPubkey: operator,
    lamports: FUND_LAMPORTS,
  }));
  const depositSig = await sendAndConfirmTransaction(conn, tx2, [agentKp], { commitment: "confirmed" });
  agent.txSignature = depositSig;

  // Step 3: POST signature → Shield credits agent's escrow.
  const r = await fetch(`${SHIELD_URL}/escrow/deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_signature: depositSig }),
  });
  if (!r.ok) throw new Error(`escrow/deposit ${r.status}: ${(await r.text()).slice(0, 100)}`);
  const dep = await r.json();
  if (dep.pubkey !== agent.pubkey) {
    throw new Error(`escrow credited ${dep.pubkey} (expected ${agent.pubkey})`);
  }
  agent.escrowBalance = dep.balance;
}

async function main() {
  console.log(paint("1", `\nx402 stress-test — spawn ${AGENTS} agents (mode=${MODE})`));
  console.log(`  shield:                ${SHIELD_URL}`);
  if (MODE === "mainnet") console.log(`  rpc:                   ${RPC_URL}`);
  console.log(`  fund per agent:        ${FUND_MICRO_LAMPORTS.toLocaleString()} µL escrow${MODE === "mainnet" ? ` (${FUND_LAMPORTS} lamports on-chain)` : ""}`);
  console.log(`  parallel concurrency:  ${PARALLEL}`);
  console.log(`  output file:           ${AGENTS_FILE}`);

  let treasury = null;
  let conn = null;
  if (MODE === "mainnet") {
    treasury = Keypair.fromSecretKey(bs58.decode(TREASURY_SECRET));
    conn = new Connection(RPC_URL, "confirmed");
    console.log(`  treasury pubkey:       ${treasury.publicKey.toBase58()}`);

    const treasuryBalance = await conn.getBalance(treasury.publicKey);
    const needed = AGENTS * (FUND_LAMPORTS + 5500) + 5500; // amount per agent + tx fees + safety
    console.log(`  treasury balance:      ${treasuryBalance.toLocaleString()} lamports (${(treasuryBalance / LAMPORTS_PER_SOL).toFixed(9)} SOL)`);
    console.log(`  needed:                ${needed.toLocaleString()} lamports`);
    if (treasuryBalance < needed) {
      err(`treasury underfunded — need ${(needed / LAMPORTS_PER_SOL).toFixed(6)} SOL, have ${(treasuryBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      process.exit(2);
    }
  }

  // Discover Shield operator pubkey
  console.log(`\n${paint("1;36", "── 1 ─")} Discovering Shield`);
  const info = await fetch(`${SHIELD_URL}/info`).then((r) => r.json());
  const operator = MODE === "mainnet" ? new PublicKey(info.operator_pubkey) : null;
  ok(`operator: ${info.operator_pubkey}`);
  ok(`network:  ${info.network}`);
  ok(`trusted_deposits: ${info.trusted_deposits_enabled ? "ON" : "OFF"}`);
  if (MODE === "demo" && !info.trusted_deposits_enabled) {
    err(`MODE=demo but Shield doesn't have trusted_deposits enabled. Either use MODE=mainnet or check SHIELD_URL.`);
    process.exit(3);
  }

  // Generate N ephemeral keypairs
  console.log(`\n${paint("1;36", "── 2 ─")} Generating ${AGENTS} ephemeral keypairs`);
  const agents = [];
  for (let i = 0; i < AGENTS; i++) {
    const kp = nacl.sign.keyPair();
    agents.push({
      idx: i,
      pubkey: bs58.encode(Buffer.from(kp.publicKey)),
      secretKey: bs58.encode(Buffer.from(kp.secretKey)),
      escrowBalance: 0,
      txSignature: null,
      error: null,
    });
  }
  ok(`generated ${agents.length} keypairs (in-memory only)`);

  // Fund each agent
  console.log(`\n${paint("1;36", "── 3 ─")} Funding (${PARALLEL} in parallel)`);
  let fundedCount = 0;
  let failedCount = 0;
  const startedAt = Date.now();

  for (let i = 0; i < agents.length; i += PARALLEL) {
    const batch = agents.slice(i, i + PARALLEL);
    await Promise.all(batch.map(async (agent) => {
      try {
        if (MODE === "demo") {
          await fundAgentDemo(agent, operator);
        } else {
          await fundAgentMainnet(agent, treasury, operator, conn);
        }
        fundedCount++;
      } catch (e) {
        agent.error = e.message || String(e);
        failedCount++;
      }
    }));
    process.stdout.write(`\r  progress: ${Math.min(i + PARALLEL, agents.length)}/${agents.length}  funded=${fundedCount}  failed=${failedCount}`);
  }
  process.stdout.write("\n");
  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  ok(`funding done in ${dur}s — ${fundedCount} ok, ${failedCount} failed`);

  if (failedCount > 0) {
    warn(`${failedCount} agents failed to fund. First 3 errors:`);
    agents.filter((a) => a.error).slice(0, 3).forEach((a) => console.log(`    [${a.idx}] ${a.pubkey.slice(0, 12)}…: ${a.error}`));
  }

  // Persist
  console.log(`\n${paint("1;36", "── 4 ─")} Persisting agent keys`);
  fs.writeFileSync(AGENTS_FILE, JSON.stringify({
    spawnedAt: new Date().toISOString(),
    mode: MODE,
    shield: SHIELD_URL,
    operator: info.operator_pubkey,
    network: info.network,
    fundMicroLamports: FUND_MICRO_LAMPORTS,
    treasuryPubkey: treasury ? treasury.publicKey.toBase58() : null,
    agents,
  }, null, 2));
  ok(`wrote ${AGENTS_FILE}`);
  warn(`SECURITY: this file contains ${agents.length} private keys. Treat as secret.`);

  console.log(paint("32", `\n✓ SPAWN COMPLETE — ${fundedCount}/${agents.length} agents ready`));
  console.log(`  next: node tools/stress-test/run-stress.js`);
}

main().catch((e) => {
  console.error(paint("31", `\nFailed: ${e.message}`));
  if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
});
