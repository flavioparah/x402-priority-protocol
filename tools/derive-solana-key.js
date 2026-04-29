#!/usr/bin/env node
/**
 * tools/derive-solana-key.js — Derive a Solana keypair from a BIP39 mnemonic.
 *
 * Solana wallets (Phantom, Solflare, Backpack, MetaMask-Solana, etc.) all derive
 * from the same BIP39 seed but use slightly different derivation paths. This
 * script tries the common paths and prints the public key for each so you can
 * identify which one matches your wallet, then outputs the 64-byte secret key
 * in base58 (the format the Shield's pay-test-mainnet.js consumes).
 *
 * SECURITY:
 *   - Your mnemonic NEVER leaves this machine. Everything is local cryptography.
 *   - Pass the mnemonic via env var so it doesn't end up in shell history:
 *       Linux/Mac/Git-Bash:  AGENT_MNEMONIC="word1 word2 ..." node tools/derive-solana-key.js
 *       PowerShell:          $env:AGENT_MNEMONIC="word1 ..."; node tools/derive-solana-key.js
 *   - When done: unset the env var (or close the shell).
 *
 * Usage:
 *   AGENT_MNEMONIC="<12 or 24 words>" node tools/derive-solana-key.js
 *   AGENT_MNEMONIC="..." TARGET_PUBKEY=<base58> node tools/derive-solana-key.js
 *     # If TARGET_PUBKEY is set, only the matching path's privkey is printed.
 */

const bip39 = require("bip39");
const { derivePath } = require("ed25519-hd-key");
const nacl = require("tweetnacl");
const bs58 = require("bs58");

const MNEMONIC = (process.env.AGENT_MNEMONIC || "").trim().replace(/\s+/g, " ");
const TARGET = process.env.TARGET_PUBKEY || null;

if (!MNEMONIC) {
  console.error("Error: AGENT_MNEMONIC env var required (12 or 24 BIP39 words).");
  console.error("Example: AGENT_MNEMONIC=\"abandon abandon ... art\" node tools/derive-solana-key.js");
  process.exit(1);
}

if (!bip39.validateMnemonic(MNEMONIC)) {
  console.error("Error: mnemonic failed BIP39 checksum validation.");
  console.error("Check: word count (12/15/18/21/24), word spelling, no extra punctuation.");
  process.exit(1);
}

const seed = bip39.mnemonicToSeedSync(MNEMONIC, "");
const seedHex = seed.toString("hex");

// Common Solana derivation paths in the wild. The first match against
// TARGET_PUBKEY (when provided) wins.
const PATHS = [
  { path: "m/44'/501'/0'/0'", note: "Phantom default, MetaMask Snap, most Solana wallets" },
  { path: "m/44'/501'/0'", note: "Solflare default (some configs)" },
  { path: "m/44'/501'/0'/0'/0'", note: "Sollet legacy" },
  { path: "m/44'/501'/1'/0'", note: "Phantom 2nd account" },
  { path: "m/44'/501'/2'/0'", note: "Phantom 3rd account" },
];

console.log(`\nDerived from mnemonic (${MNEMONIC.split(" ").length} words):\n`);

let matched = false;
for (const { path, note } of PATHS) {
  const derivedSeed = derivePath(path, seedHex).key;
  const kp = nacl.sign.keyPair.fromSeed(derivedSeed);
  const pub = bs58.encode(Buffer.from(kp.publicKey));
  const sec = bs58.encode(Buffer.from(kp.secretKey));

  const isMatch = TARGET && pub === TARGET;
  const tag = isMatch ? " ← MATCH" : "";

  console.log(`  ${path.padEnd(28)}  ${pub}${tag}`);
  console.log(`    ${note}`);

  if (isMatch) {
    console.log(`\n  AGENT_SECRET_KEY="${sec}"\n`);
    matched = true;
    break;
  }
  console.log();
}

if (TARGET && !matched) {
  console.log(`\n${"!".repeat(60)}`);
  console.log(`No path matched TARGET_PUBKEY=${TARGET}`);
  console.log(`Possible reasons:`);
  console.log(`  - Wrong mnemonic (different wallet)`);
  console.log(`  - Different account index (try 1', 2', ... above)`);
  console.log(`  - Custom derivation path (open an issue with your wallet name)`);
  console.log(`${"!".repeat(60)}`);
  process.exit(2);
}

if (!TARGET) {
  console.log("Pick the path whose pubkey matches your wallet, then run with TARGET_PUBKEY set:");
  console.log(`  AGENT_MNEMONIC=\"...\" TARGET_PUBKEY=<your_pubkey> node tools/derive-solana-key.js`);
  console.log(`That will print only the matching AGENT_SECRET_KEY (safer to copy).`);
}
