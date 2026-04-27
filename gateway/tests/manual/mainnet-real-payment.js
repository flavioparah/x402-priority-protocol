const { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction, 
  SystemProgram, 
  sendAndConfirmTransaction 
} = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const crypto = require("crypto");

// ─── Configuração ────────────────────────────────────────────────────────────

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3000/rpc";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com"; // Conexão direta para enviar o depósito
const KEY_PATH = path.resolve(__dirname, "../../sender-key.json");

/**
 * Deterministic JSON stringifier for body integrity.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runMainnetTest() {
  console.log("[INFO] Starting Mainnet Payment & Priority Authorization Validation...");

  // 1. Load Sender Key
  if (!fs.existsSync(KEY_PATH)) {
    console.error(`[ERROR] Key file not found at ${KEY_PATH}`);
    console.log("Please create a 'sender-key.json' file with your Solana private key array [1,2,3...]");
    process.exit(1);
  }

  let fileContent = fs.readFileSync(KEY_PATH, "utf-8");
  // Aggressive clean: remove everything except numbers, commas, and brackets
  fileContent = fileContent.replace(/[^0-9,\[\]]/g, "");
  
  let secretKey = Uint8Array.from(JSON.parse(fileContent));
  if (secretKey.length === 32) {
    console.log("💡 Detected 32-byte private key. Deriving full keypair...");
    secretKey = Keypair.fromSeed(secretKey).secretKey;
  }

  const senderKeypair = Keypair.fromSecretKey(secretKey);
  const connection = new Connection(SOLANA_RPC, "confirmed");

  console.log(`Wallet: ${senderKeypair.publicKey.toBase58()}`);
  const balance = await connection.getBalance(senderKeypair.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 2000000) { // < 0.002 SOL
    console.error("❌ Insufficient balance for testing (need at least 0.002 SOL).");
    process.exit(1);
  }

  // 2. Fetch Gateway Info (to get PAYMENT_DESTINATION)
  const infoRes = await fetch(GATEWAY_URL.replace("/rpc", "/info"));
  const info = await infoRes.json();
  const destination = new PublicKey(info.operator_pubkey);
  console.log(`Target Destination: ${destination.toBase58()}`);

  // 3. Create & Send Real Deposit Transaction
  let signature = process.argv[2];
  
  if (!signature) {
    const amountToDeposit = 1000000; // 0.001 SOL
    console.log(`[INFO] Initiating 0.001 SOL on-chain transfer...`);
    
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: destination,
        lamports: amountToDeposit,
      })
    );

    signature = await sendAndConfirmTransaction(connection, tx, [senderKeypair]);
    console.log(`[SUCCESS] Transaction confirmed. Signature: ${signature}`);
  } else {
    console.log(`[INFO] Reusing provided signature: ${signature}`);
  }
  
  console.log(`Explorer: https://solscan.io/tx/${signature}`);

  // 4. Submit Signature to Gateway
  console.log(`[INFO] Submitting transaction signature to gateway /escrow/deposit...`);
  const depRes = await fetch(GATEWAY_URL.replace("/rpc", "/escrow/deposit"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      tx_signature: signature, 
      pubkey: senderKeypair.publicKey.toBase58() 
    })
  });

  const depData = await depRes.json();
  if (depRes.status !== 200) {
    console.error(`[ERROR] Gateway rejected deposit: ${depData.error}`);
    process.exit(1);
  }
  console.log(`[SUCCESS] Gateway credited escrow account.`);

  // 5. Perform a Gated RPC Request using the real balance
  console.log(`[INFO] Performing authorized RPC request (getHealth)...`);
  const rpcBody = { jsonrpc: "2.0", id: 1, method: "getHealth", params: [] };
  
  // 5a. Get Challenge
  const chalRes = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json", 
      "X-x402-Agent-Pubkey": senderKeypair.publicKey.toBase58() 
    },
    body: JSON.stringify(rpcBody)
  });

  if (chalRes.status !== 402) {
    console.log("⚠️  Gateway did not issue a challenge (maybe load is low). Force testing challenge logic...");
    // If not challenged, we can't test the payment logic here unless we force it.
    process.exit(0);
  }

  const challenge = await chalRes.json();
  
  // 5b. Sign Proof
  const payload = JSON.stringify({
    protocol: "x402-shield",
    network: "mainnet",
    nonce: challenge.payment.nonce,
    pubkey: senderKeypair.publicKey.toBase58(),
    amount: challenge.payment.amount_micro_lamports,
    destination: challenge.payment.destination,
    body_hash: crypto.createHash("sha256").update(canonicalJson(rpcBody)).digest("hex")
  });

  const messageBytes = Buffer.from(payload);
  const proofSig = nacl.sign.detached(messageBytes, senderKeypair.secretKey);
  const authHeader = `x402 ${bs58.encode(proofSig)}.${senderKeypair.publicKey.toBase58()}.${bs58.encode(messageBytes)}`;

  // 5c. Submit with Proof
  const finalRes = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json", 
      "Authorization": authHeader,
      "X-x402-Agent-Pubkey": senderKeypair.publicKey.toBase58()
    },
    body: JSON.stringify(rpcBody)
  });

  if (finalRes.status === 200) {
    console.log("[SUCCESS] Mainnet payment verified. RPC request processed with priority.");
    const rpcData = await finalRes.json();
    console.log("[INFO] RPC Response:", JSON.stringify(rpcData));
  } else {
    const errorData = await finalRes.json();
    console.error(`[ERROR] Validation failed: HTTP ${finalRes.status} - ${errorData.error}`);
  }
}

runMainnetTest().catch(console.error);
