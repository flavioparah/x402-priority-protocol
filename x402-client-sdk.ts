/**
 * x402-Client-SDK — Extensão da @solana/web3.js
 *
 * Intercepta automaticamente erros HTTP 402 do x402-Shield,
 * negocia o pagamento de prioridade e refaz a requisição original.
 *
 * MVP: usa assinatura Ed25519 off-chain para liquidação zero-latência.
 */

import {
  Connection,
  ConnectionConfig,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  SendOptions,
  Commitment,
} from "@solana/web3.js";
import * as nacl from "tweetnacl";
import * as bs58 from "bs58";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface X402Challenge {
  destination: string;
  amount_micro_lamports: number;
  nonce: string;
  ttl_seconds: number;
}

export interface X402ProviderConfig extends ConnectionConfig {
  /** Orçamento máximo em micro-lamports que o agente aceita pagar por requisição */
  priorityBudget?: number;

  /**
   * Estratégia de liquidação:
   * - "offchain" (MVP): assina mensagem Ed25519 off-chain contra saldo pré-depositado
   * - "onchain": envia SystemProgram.transfer real (maior latência)
   */
  settlementMode?: "offchain" | "onchain";

  /** Callback chamado antes de pagar — retorne false para cancelar */
  onChallenge?: (challenge: X402Challenge) => boolean | Promise<boolean>;

  /** Callback de telemetria (opcional) */
  onPayment?: (info: { nonce: string; amount: number; pubkey: string }) => void;
}

// ─── Classe principal ─────────────────────────────────────────────────────────

export class X402Provider extends Connection {
  private keypair: Keypair;
  private config: Required<X402ProviderConfig>;
  private _fetch: typeof fetch;

  constructor(endpoint: string, keypair: Keypair, config: X402ProviderConfig = {}) {
    super(endpoint, config);
    this.keypair = keypair;
    this._fetch = globalThis.fetch;

    this.config = {
      ...config,
      priorityBudget: config.priorityBudget ?? 10_000,
      settlementMode: config.settlementMode ?? "offchain",
      onChallenge: config.onChallenge ?? (() => true),
      onPayment: config.onPayment ?? (() => {}),
      commitment: config.commitment ?? "confirmed",
    } as Required<X402ProviderConfig>;

    // Sobrescreve o método interno _rpcRequest do Connection
    this._patchRpcRequest();
  }

  // ─── Core: intercepta todas as chamadas RPC ─────────────────────────────────

  private _patchRpcRequest() {
    // @ts-ignore — acessa método protegido da classe base
    const originalFetch = this._rpcWebSocket?.socket?.send?.bind(this._rpcWebSocket?.socket);

    // Sobrescreve o fetch HTTP usado pelo Connection internamente
    // @ts-ignore
    this._rpcBatchRequest = this._interceptedBatchRequest.bind(this);
  }

  /**
   * Método público para chamadas RPC arbitrárias com interceptação 402.
   * Use este método em vez de `connection._rpcRequest` diretamente.
   */
  async request<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    return this._fetchWithX402<T>(this.rpcEndpoint, body);
  }

  private async _interceptedBatchRequest(requests: unknown[]) {
    const body = JSON.stringify(requests);
    return this._fetchWithX402(this.rpcEndpoint, body);
  }

  // ─── Lógica central de negociação ──────────────────────────────────────────

  private async _fetchWithX402<T>(url: string, body: string, retrying = false): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const response = await this._fetch(url, { method: "POST", headers, body });

    if (response.status !== 402) {
      if (!response.ok) {
        throw new Error(`RPC error: ${response.status} ${response.statusText}`);
      }
      return response.json() as Promise<T>;
    }

    if (retrying) {
      throw new Error("x402: payment rejected by Shield after retry");
    }

    // ── Lê o desafio 402 ──────────────────────────────────────────────────────
    const challenge = this._parseChallenge(response);

    // Verifica o orçamento
    if (challenge.amount_micro_lamports > this.config.priorityBudget) {
      throw new X402BudgetExceededError(challenge.amount_micro_lamports, this.config.priorityBudget);
    }

    // Notifica o callback do usuário (permite cancelar)
    const approved = await this.config.onChallenge(challenge);
    if (!approved) {
      throw new Error("x402: payment cancelled by onChallenge callback");
    }

    // ── Paga a taxa de prioridade ─────────────────────────────────────────────
    const authHeader = await this._payPriority(challenge);

    // Notifica telemetria
    this.config.onPayment({
      nonce: challenge.nonce,
      amount: challenge.amount_micro_lamports,
      pubkey: this.keypair.publicKey.toBase58(),
    });

    // ── Refaz a requisição com a prova de pagamento ───────────────────────────
    const retryResponse = await this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body,
    });

    if (retryResponse.status === 402) {
      const errBody = await retryResponse.json().catch(() => ({}));
      throw new Error(`x402: Shield rejected payment — ${(errBody as any)?.payment?.instructions ?? "check logs"}`);
    }

    if (!retryResponse.ok) {
      throw new Error(`RPC error after payment: ${retryResponse.status}`);
    }

    return retryResponse.json() as Promise<T>;
  }

  // ─── Parsing do desafio ─────────────────────────────────────────────────────

  private _parseChallenge(response: Response): X402Challenge {
    const destination =
      response.headers.get("X-x402-Payment-Destination") ?? "";
    const amount = parseInt(response.headers.get("X-x402-Amount") ?? "0", 10);
    const nonce = response.headers.get("X-x402-Nonce") ?? "";
    const ttl = parseInt(response.headers.get("X-x402-Nonce-TTL") ?? "30", 10);

    if (!destination || !nonce || amount <= 0) {
      throw new Error("x402: Malformed 402 challenge headers");
    }

    return { destination, amount_micro_lamports: amount, nonce, ttl_seconds: ttl };
  }

  // ─── Liquidação off-chain (MVP, zero-latência) ──────────────────────────────

  /**
   * Constrói o cabeçalho Authorization para o modo offchain.
   *
   * Payload assinado: JSON.stringify({ nonce, pubkey, amount, destination })
   * Assinatura Ed25519 com a chave do agente.
   * Header: "x402 <sig_bs58>.<pubkey_bs58>.<msg_bs58>"
   */
  private async _payPriority(challenge: X402Challenge): Promise<string> {
    if (this.config.settlementMode === "onchain") {
      return this._payPriorityOnChain(challenge);
    }
    return this._payPriorityOffChain(challenge);
  }

  private _payPriorityOffChain(challenge: X402Challenge): string {
    const pubkey = this.keypair.publicKey.toBase58();
    const payload = JSON.stringify({
      nonce: challenge.nonce,
      pubkey,
      amount: challenge.amount_micro_lamports,
      destination: challenge.destination,
    });

    const messageBytes = new TextEncoder().encode(payload);
    const signature = nacl.sign.detached(messageBytes, this.keypair.secretKey);

    const sigB58 = bs58.encode(signature);
    const pubkeyB58 = pubkey;
    const msgB58 = bs58.encode(messageBytes);

    return `x402 ${sigB58}.${pubkeyB58}.${msgB58}`;
  }

  private async _payPriorityOnChain(challenge: X402Challenge): Promise<string> {
    // Liquidação on-chain real (maior latência, mas sem necessidade de escrow pré-depositado)
    const destination = new PublicKey(challenge.destination);
    const { blockhash, lastValidBlockHeight } = await this.getLatestBlockhash();

    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: this.keypair.publicKey,
    }).add(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey: destination,
        lamports: Math.ceil(challenge.amount_micro_lamports / 1_000), // converte µL → lamports
      })
    );

    // Assina e serializa (sem enviar ainda — o Shield pode verificar)
    tx.sign(this.keypair);
    const serialized = bs58.encode(tx.serialize());

    return `x402-tx ${serialized}`;
  }

  // ─── Métodos de conveniência ────────────────────────────────────────────────

  /** Deposita saldo no escrow do Shield (MVP) */
  async depositEscrow(shieldBaseUrl: string, amountMicroLamports: number): Promise<number> {
    const res = await this._fetch(`${shieldBaseUrl}/escrow/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pubkey: this.keypair.publicKey.toBase58(),
        amount_micro_lamports: amountMicroLamports,
      }),
    });
    if (!res.ok) throw new Error("Failed to deposit escrow");
    const data = await res.json() as { balance: number };
    return data.balance;
  }

  /** Consulta saldo no escrow */
  async getEscrowBalance(shieldBaseUrl: string): Promise<number> {
    const pubkey = this.keypair.publicKey.toBase58();
    const res = await this._fetch(`${shieldBaseUrl}/escrow/balance/${pubkey}`);
    const data = await res.json() as { balance_micro_lamports: number };
    return data.balance_micro_lamports;
  }
}

// ─── Erro customizado ─────────────────────────────────────────────────────────

export class X402BudgetExceededError extends Error {
  constructor(public requested: number, public budget: number) {
    super(`x402: requested ${requested} µL exceeds priority budget ${budget} µL`);
    this.name = "X402BudgetExceededError";
  }
}

// ─── Exemplo de uso ───────────────────────────────────────────────────────────

/*
import { Keypair } from "@solana/web3.js";
import { X402Provider } from "./x402-client-sdk";

const agentKeypair = Keypair.generate(); // ou carregue do arquivo seguro

const rpc = new X402Provider(
  "http://localhost:3000/rpc",   // endereço do x402-Shield
  agentKeypair,
  {
    priorityBudget: 5_000,       // aceita pagar até 5.000 µL por requisição
    settlementMode: "offchain",  // MVP: zero-latência

    onChallenge: (challenge) => {
      console.log(`[Agent] Challenge: ${challenge.amount_micro_lamports} µL — nonce: ${challenge.nonce}`);
      return true; // aprovar automaticamente
    },

    onPayment: ({ nonce, amount, pubkey }) => {
      console.log(`[Agent] Paid ${amount} µL from ${pubkey.slice(0, 8)}… (nonce: ${nonce})`);
    },
  }
);

// Uso idêntico ao Connection padrão — a negocia02 é transparente
const accountInfo = await rpc.getAccountInfo(agentKeypair.publicKey);
console.log(accountInfo);

// Ou via método genérico
const slot = await rpc.request<{ result: number }>("getSlot", []);
console.log("Slot atual:", slot.result);
*/
