#!/usr/bin/env node
/**
 * examples/deposit-with-tx.js
 *
 * Proves the verified-deposit path end-to-end on Solana devnet:
 *   1. Generate a keypair (the agent)
 *   2. Request a small devnet airdrop
 *   3. SystemProgram.transfer a few lamports to the Shield's
 *      PAYMENT_DESTINATION
 *   4. Wait for confirmation
 *   5. POST the tx signature to /escrow/deposit — Shield fetches the
 *      tx, verifies sender / destination / amount / no double-spend,
 *      and credits the agent's escrow at 1000 µL per lamport.
 *   6. Verify the escrow balance reflects the transfer.
 *
 * Usage:
 *   Terminal 1:   (Shield configured for devnet)
 *     REAL_RPC_URL=https://api.devnet.solana.com \
 *     SOLANA_RPC_URL=https://api.devnet.solana.com \
 *     PAYMENT_DESTINATION=<base58_devnet_wallet> \
 *     RPC_LOAD_THRESHOLD=0 \
 *     npm start
 *
 *   Terminal 2:
 *     SHIELD_URL=http://localhost:3000 \
 *     PAYMENT_DESTINATION=<same_base58_wallet> \
 *     node examples/deposit-with-tx.js
 *
 * The PAYMENT_DESTINATION must match between the Shield and this script —
 * the Shield only accepts transfers to its own configured destination.
 */

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

const SHIELD_URL = process.env.SHIELD_URL || "http://localhost:3000";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PAYMENT_DESTINATION = process.env.PAYMENT_DESTINATION;
const TRANSFER_LAMPORTS = parseInt(process.env.DEPOSIT_LAMPORTS || "100", 10); // 100 lamports = 100_000 µL escrow

if (!PAYMENT_DESTINATION) {
  console.error("PAYMENT_DESTINATION env var required (must match the Shield's).");
  process.exit(1);
}

const paint = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const ok = (m) => console.log(`  ${paint("32", "✓")} ${m}`);
const step = (n, t) => console.log(`\n${paint("1;36", `── Step ${n} ─`)} ${paint("1", t)}`);

async function main() {
  console.log(paint("1", "\nx402-shield — verified on-chain deposit demo"));
  console.log(`  shield:       ${SHIELD_URL}`);
  console.log(`  solana rpc:   ${RPC_URL}`);
  console.log(`  destination:  ${PAYMENT_DESTINATION}`);
  console.log(`  transfer:     ${TRANSFER_LAMPORTS} lamports`);

  const conn = new Connection(RPC_URL, "confirmed");

  step(1, "Loading or generating agent keypair");
  let agent;
  const envSecret = process.env.AGENT_SECRET_KEY;
  if (envSecret) {
    // base58-encoded 64-byte secret key (same format as `solana-keygen grind`
    // output or `Keypair.secretKey` → bs58). No airdrop needed.
    const bs58mod = require("bs58");
    agent = Keypair.fromSecretKey(bs58mod.decode(envSecret));
    ok(`loaded agent from AGENT_SECRET_KEY — ${agent.publicKey.toBase58()}`);
  } else {
    agent = Keypair.generate();
    console.log(`  generated fresh agent: ${agent.publicKey.toBase58()}`);
  }

  step(2, "Ensuring agent has devnet SOL");
  let balance = await conn.getBalance(agent.publicKey);
  if (balance > 1000) {
    ok(`existing balance ${balance / LAMPORTS_PER_SOL} SOL — skipping airdrop`);
  } else {
    // Public devnet faucet is heavily rate-limited. Ask small, retry.
    const airdropAmount = 0.01 * LAMPORTS_PER_SOL;
    let airdropSig;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        airdropSig = await conn.requestAirdrop(agent.publicKey, airdropAmount);
        break;
      } catch (err) {
        if (attempt === 3) {
          throw new Error(
            `airdrop failed after 3 attempts: ${err.message}\n  ` +
            `Public devnet faucet may be exhausted. Pre-fund a keypair ` +
            `(https://faucet.solana.com) and pass AGENT_SECRET_KEY=<bs58>.`
          );
        }
        console.log(`  airdrop attempt ${attempt} rejected, retrying…`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await conn.confirmTransaction(airdropSig, "confirmed");
    balance = await conn.getBalance(agent.publicKey);
    ok(`airdrop confirmed — ${balance / LAMPORTS_PER_SOL} SOL`);
  }

  step(3, "Transferring to Shield's PAYMENT_DESTINATION");
  const destination = new PublicKey(PAYMENT_DESTINATION);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: agent.publicKey,
      toPubkey: destination,
      lamports: TRANSFER_LAMPORTS,
    })
  );
  const signature = await sendAndConfirmTransaction(conn, tx, [agent], { commitment: "confirmed" });
  ok(`on-chain transfer confirmed — signature ${signature.slice(0, 16)}…`);

  step(4, "Posting signature to the Shield for verified deposit");
  const res = await fetch(`${SHIELD_URL}/escrow/deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_signature: signature }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Shield rejected deposit: ${res.status} ${err}`);
  }
  const deposit = await res.json();
  ok(`Shield verified the tx on-chain`);
  console.log(`  credited: ${deposit.credited_micro_lamports} µL`);
  console.log(`  balance:  ${deposit.balance} µL`);
  console.log(`  slot:     ${deposit.slot}`);

  step(5, "Confirming the balance via GET /escrow/balance");
  const balRes = await fetch(`${SHIELD_URL}/escrow/balance/${agent.publicKey.toBase58()}`);
  const bal = await balRes.json();
  if (bal.balance_micro_lamports !== deposit.balance) {
    throw new Error(
      `balance mismatch after deposit: ${bal.balance_micro_lamports} vs ${deposit.balance}`
    );
  }
  ok(`escrow balance reconciled — ${bal.balance_micro_lamports} µL`);

  step(6, "Anti-replay check — the Shield must reject the same signature twice");
  const replayRes = await fetch(`${SHIELD_URL}/escrow/deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_signature: signature }),
  });
  if (replayRes.ok) {
    throw new Error("Shield accepted a replayed signature — anti-replay broken!");
  }
  const replayErr = await replayRes.json();
  ok(`replay rejected: "${replayErr.error}"`);

  console.log(paint("32", "\nVERIFIED DEPOSIT END-TO-END PASSED"));
}

main().catch((e) => {
  console.error(paint("31", `\nFailed: ${e.message}`));
  process.exit(1);
});
