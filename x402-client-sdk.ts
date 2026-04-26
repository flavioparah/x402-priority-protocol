/**
 * x402-Client-SDK — Extensão da @solana/web3.js
 *
 * Intercepta automaticamente erros HTTP 402 do x402-Shield,
 * negocia o pagamento de prioridade e refaz a requisição original.
 *
 * MVP: usa assinatura Ed25519 off-chain para liquidação zero-latência.
 */

import { Connection, ConnectionConfig, Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import * as bs58 from "bs58";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface X402Challenge {
  destination: string;
  amount_micro_lamports: number;
  /** Base (non-discounted) price in µL — useful to show the discount applied. */
  amount_base_micro_lamports?: number;
  /** Trust-Score (0..100) attributed to the hinted pubkey, if any. */
  trust_score?: number;
  nonce: string;
  ttl_seconds: number;
}

export interface X402ProviderConfig extends ConnectionConfig {
  /** Orçamento máximo em micro-lamports que o agente aceita pagar por requisição */
  priorityBudget?: number;

  /**
   * Estratégia de liquidação. Hoje o Shield só suporta "offchain":
   * o cliente pré-deposita SOL via /escrow/deposit e cada requisição é
   * assinada off-chain contra esse saldo.
   *
   * Modo "onchain" (SystemProgram.transfer por requisição) foi prototipado
   * mas removido da API pública porque o Shield server ainda não verifica
   * `Authorization: x402-tx <serialized-tx>`. Voltará quando o spec
   * `x402-tx` estiver implementado.
   */
  settlementMode?: "offchain";

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
  private _requestId = 0;

  constructor(endpoint: string, keypair: Keypair, config: X402ProviderConfig = {}) {
    super(endpoint, config);
    this.keypair = keypair;
    this._fetch = globalThis.fetch.bind(globalThis);

    this.config = {
      ...config,
      priorityBudget: config.priorityBudget ?? 10_000,
      settlementMode: config.settlementMode ?? "offchain",
      onChallenge: config.onChallenge ?? (() => true),
      onPayment: config.onPayment ?? (() => {}),
      commitment: config.commitment ?? "confirmed",
    } as Required<X402ProviderConfig>;

    // Intercept every RPC call that Connection issues.
    //
    // @solana/web3.js defines `_rpcRequest` as an *instance property* inside
    // its constructor (via createRpcClient), so a method declared on the
    // subclass prototype would be shadowed. We replace it here after super()
    // has run. This catches getAccountInfo, getBalance, getSlot,
    // getLatestBlockhash, sendTransaction, etc. in a single hook.
    //
    // NB: `_rpcRequest` is an internal contract of @solana/web3.js — revisit
    // this override on any major-version bump of the SDK.
    (this as any)._rpcRequest = this._x402RpcRequest.bind(this);
  }

  // ─── Core: intercepta todas as chamadas RPC ─────────────────────────────────

  private async _x402RpcRequest(methodName: string, args: unknown[]): Promise<unknown> {
    // @solana/web3.js validates response `id` as a string (superstruct schema
    // in jsonRpcResult). Sending a numeric id makes devnet echo a number and
    // breaks client-side validation. Stringify before the request.
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: String(++this._requestId),
      method: methodName,
      params: args,
    });
    return this._fetchWithX402(this.rpcEndpoint, body);
  }

  /**
   * Public escape hatch for arbitrary RPC methods with 402 interception.
   * Equivalent to calling _rpcRequest directly but with a typed return.
   */
  async request<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: String(++this._requestId),
      method,
      params,
    });
    return this._fetchWithX402<T>(this.rpcEndpoint, body);
  }

  // ─── Lógica central de negociação ──────────────────────────────────────────

  private async _fetchWithX402<T>(url: string, body: string, retrying = false): Promise<T> {
    const pubkey = this.keypair.publicKey.toBase58();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Hint the agent's pubkey so the Shield can look up Trust-Score
      // and apply a discount on the challenge before the client signs.
      // The hint is non-authoritative — Step 2's signature binds the
      // discounted price to the owner of the signing key.
      "X-x402-Agent-Pubkey": pubkey,
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
      headers: {
        "Content-Type": "application/json",
        "X-x402-Agent-Pubkey": pubkey,
        Authorization: authHeader,
      },
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
    const amountBaseHdr = response.headers.get("X-x402-Amount-Base");
    const trustScoreHdr = response.headers.get("X-x402-Trust-Score");
    const nonce = response.headers.get("X-x402-Nonce") ?? "";
    const ttl = parseInt(response.headers.get("X-x402-Nonce-TTL") ?? "30", 10);

    if (!destination || !nonce || amount <= 0) {
      throw new Error("x402: Malformed 402 challenge headers");
    }

    return {
      destination,
      amount_micro_lamports: amount,
      amount_base_micro_lamports: amountBaseHdr ? parseInt(amountBaseHdr, 10) : undefined,
      trust_score: trustScoreHdr ? parseInt(trustScoreHdr, 10) : undefined,
      nonce,
      ttl_seconds: ttl,
    };
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
    // Defensive: legacy callers may still pass settlementMode="onchain" via
    // an `as any` cast or stale config object — keep the branch as a hard
    // fail with a clear error rather than silently downgrading to offchain.
    if ((this.config.settlementMode as string) === "onchain") {
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

  /**
   * @deprecated On-chain per-request settlement is not wired into the Shield
   * (only the deposit path is on-chain — see /escrow/deposit). This method
   * is kept as a defensive throw in case external callers reach it via
   * older code paths. Removed from the public type in `X402ProviderConfig`;
   * `settlementMode` only accepts `"offchain"`.
   *
   * Will be reinstated once the Shield supports `Authorization: x402-tx ...`
   * with serialized SystemProgram.transfer verification server-side.
   */
  private async _payPriorityOnChain(_challenge: X402Challenge): Promise<string> {
    throw new Error(
      "x402: on-chain per-request settlement is not supported by the Shield. " +
      "Use settlementMode: 'offchain' (the only supported mode today)."
    );
  }

  // ─── Métodos de conveniência ────────────────────────────────────────────────

  /**
   * Credit the Shield's escrow with a verified on-chain transaction.
   *
   * The caller transfers lamports to the Shield's PAYMENT_DESTINATION on
   * Solana and passes the confirmed tx signature. The Shield fetches the
   * tx, verifies the sender/destination/amount, and credits escrow at
   * 1 lamport = 1000 µL. Anti-replay: each signature can be used once.
   *
   * Returns the resulting escrow balance for this agent's pubkey.
   */
  async depositEscrowWithTx(shieldBaseUrl: string, txSignature: string): Promise<{
    pubkey: string;
    credited_micro_lamports: number;
    balance: number;
    signature: string;
    slot: number;
  }> {
    const res = await this._fetch(`${shieldBaseUrl}/escrow/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_signature: txSignature }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`escrow deposit rejected: ${res.status} ${err}`);
    }
    return res.json() as Promise<{
      pubkey: string; credited_micro_lamports: number; balance: number; signature: string; slot: number;
    }>;
  }

  /**
   * DEMO/TEST ONLY: credit escrow without an on-chain transaction.
   *
   * Hits the Shield's /escrow/deposit-trusted endpoint, which the Shield
   * only mounts when started with ESCROW_TRUST_DEPOSITS=1. Intended for
   * smoke tests, benchmarks, and the Trust-Score progression demo where
   * a Solana round trip per deposit is prohibitive.
   *
   * In production, use {@link depositEscrowWithTx} instead.
   */
  async depositEscrowTrusted(shieldBaseUrl: string, amountMicroLamports: number): Promise<number> {
    const res = await this._fetch(`${shieldBaseUrl}/escrow/deposit-trusted`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pubkey: this.keypair.publicKey.toBase58(),
        amount_micro_lamports: amountMicroLamports,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `trusted deposit rejected (is the Shield running with ESCROW_TRUST_DEPOSITS=1?): ${res.status}`
      );
    }
    const data = await res.json() as { balance: number };
    return data.balance;
  }

  /** @deprecated Use depositEscrowTrusted (dev) or depositEscrowWithTx (prod). */
  async depositEscrow(shieldBaseUrl: string, amountMicroLamports: number): Promise<number> {
    return this.depositEscrowTrusted(shieldBaseUrl, amountMicroLamports);
  }

  /** Look up escrow balance for this agent's pubkey. */
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
