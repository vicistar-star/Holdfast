/**
 * @holdfast/contract-client
 *
 * Typed TypeScript wrapper for the Holdfast escrow Soroban contract.
 *
 * ASSUMPTION: This wrapper was written by hand against the contract specification
 * in README.md and contracts/escrow/src/lib.rs, using @stellar/stellar-sdk v13.
 * The Stellar CLI can generate bindings automatically with:
 *
 *   stellar contract bindings typescript \
 *     --contract-id <CONTRACT_ID> \
 *     --network testnet \
 *     --output-dir packages/contract-client/src/generated
 *
 * TODO: run the above after testnet deployment and replace this wrapper with
 * generated bindings. Until then, this file is the source of truth for the
 * TypeScript interface to the contract.
 */

import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  type xdr,
  type Keypair,
  type Account,
  type Transaction,
} from "@stellar/stellar-sdk";

// ── Types ─────────────────────────────────────────────────────────────────────

/** The six order states, mirroring the on-chain Status enum exactly. */
export type OrderStatus =
  | "Funded"
  | "Shipped"
  | "Released"
  | "Refunded"
  | "Disputed"
  | "Resolved";

/** An on-chain order decoded from the contract's storage format. */
export interface Order {
  buyer: string;
  seller: string;
  token: string;
  /** Amount in the token's smallest unit. Always bigint, never float. */
  amount: bigint;
  /** Unix timestamp (seconds) by which the seller must ship. */
  shipBy: bigint;
  /** Duration in seconds of the buyer's review window after shipping. */
  reviewSecs: bigint;
  /** Unix timestamp when mark_shipped was called. 0 until shipped. */
  shippedAt: bigint;
  status: OrderStatus;
}

/** Parameters for creating a new escrow order. */
export interface CreateAndFundParams {
  buyer: string;
  seller: string;
  token: string;
  /** Amount in smallest token unit. bigint, never float. */
  amount: bigint;
  /** Unix timestamp (seconds). Must be in the future. */
  shipBy: bigint;
  /** Duration in seconds. Must be within [MIN_REVIEW_SECS, MAX_REVIEW_SECS]. */
  reviewSecs: bigint;
}

/** Parameters for resolving a dispute. */
export interface ResolveDisputeParams {
  id: bigint;
  /** Buyer's portion of the funded amount. May be zero. */
  buyerShare: bigint;
  /** Seller's portion. buyerShare + sellerShare must equal order.amount exactly. */
  sellerShare: bigint;
}

/** Network + contract configuration for the client. */
export interface EscrowClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

// ── Error codes — must match contracts/escrow/src/errors.rs exactly ───────────

export const ErrorCode = {
  NotFound: 1,
  WrongState: 2,
  Unauthorized: 3,
  Paused: 4,
  AmountInvalid: 5,
  DeadlineInvalid: 6,
  CapExceeded: 7,
  WindowClosed: 8,
  WindowOpen: 9,
  SharesMismatch: 10,
  FeeTooHigh: 11,
  AlreadyInitialized: 12,
  ReviewSecsInvalid: 13,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── Status discriminant map — must match the Rust enum order ─────────────────

const STATUS_BY_DISCRIMINANT: Record<number, OrderStatus> = {
  0: "Funded",
  1: "Shipped",
  2: "Released",
  3: "Refunded",
  4: "Disputed",
  5: "Resolved",
};

const ALL_STATUSES: OrderStatus[] = [
  "Funded",
  "Shipped",
  "Released",
  "Refunded",
  "Disputed",
  "Resolved",
];

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * EscrowClient — typed wrapper around the Holdfast escrow contract.
 *
 * Exposes one build* method per contract function.  Each method returns a
 * base64-encoded XDR transaction envelope that must be:
 *   1. Simulated (to get the resource footprint), or
 *   2. Signed and submitted via simulateSignAndSubmit().
 *
 * All amounts are bigint. No floats are used for money anywhere.
 */
export class EscrowClient {
  private readonly contract: Contract;
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;

  constructor(config: EscrowClientConfig) {
    this.contract = new Contract(config.contractId);
    this.server = new rpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Fetch an order by ID using a simulation (no signing required).
   * Throws if the order does not exist or the simulation fails.
   */
  async getOrder(id: bigint, sourcePublicKey: string): Promise<Order> {
    const account = await this.server.getAccount(sourcePublicKey);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call("get_order", nativeToScVal(id, { type: "u64" })),
      )
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`get_order failed: ${sim.error}`);
    }

    const simSuccess = sim as rpc.Api.SimulateTransactionSuccessResponse;
    const retval = simSuccess.result?.retval;
    if (!retval) throw new Error("get_order: no return value in simulation");

    return decodeOrder(retval);
  }

  // ── Transaction builders ───────────────────────────────────────────────────

  /** Build a create_and_fund transaction. Returns base64 XDR. */
  buildCreateAndFund(
    params: CreateAndFundParams,
    sourceAccount: Account,
  ): string {
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "create_and_fund",
          nativeToScVal(params.buyer, { type: "address" }),
          nativeToScVal(params.seller, { type: "address" }),
          nativeToScVal(params.token, { type: "address" }),
          nativeToScVal(params.amount, { type: "i128" }),
          nativeToScVal(params.shipBy, { type: "u64" }),
          nativeToScVal(params.reviewSecs, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    return tx.toEnvelope().toXDR("base64");
  }

  /** Build a mark_shipped transaction. Returns base64 XDR. */
  buildMarkShipped(id: bigint, sourceAccount: Account): string {
    return this.buildIdCall("mark_shipped", id, sourceAccount);
  }

  /** Build a confirm_delivery transaction. Returns base64 XDR. */
  buildConfirmDelivery(id: bigint, sourceAccount: Account): string {
    return this.buildIdCall("confirm_delivery", id, sourceAccount);
  }

  /**
   * Build a claim_auto_release transaction (permissionless).
   * Anyone may submit this once the review window has closed.
   */
  buildClaimAutoRelease(id: bigint, sourceAccount: Account): string {
    return this.buildIdCall("claim_auto_release", id, sourceAccount);
  }

  /**
   * Build a claim_refund transaction (permissionless).
   * Anyone may submit this once the ship_by deadline has passed.
   */
  buildClaimRefund(id: bigint, sourceAccount: Account): string {
    return this.buildIdCall("claim_refund", id, sourceAccount);
  }

  /** Build an open_dispute transaction. Caller must be the buyer. */
  buildOpenDispute(id: bigint, sourceAccount: Account): string {
    return this.buildIdCall("open_dispute", id, sourceAccount);
  }

  /**
   * Build a resolve_dispute transaction. Caller must be the arbiter.
   * buyerShare + sellerShare must equal order.amount exactly.
   */
  buildResolveDispute(
    params: ResolveDisputeParams,
    sourceAccount: Account,
  ): string {
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "resolve_dispute",
          nativeToScVal(params.id, { type: "u64" }),
          nativeToScVal(params.buyerShare, { type: "i128" }),
          nativeToScVal(params.sellerShare, { type: "i128" }),
        ),
      )
      .setTimeout(30)
      .build();

    return tx.toEnvelope().toXDR("base64");
  }

  // ── Sign + submit

  /**
   * Simulate a transaction to get the resource footprint, sign it,
   * submit it, and poll until it's confirmed. Returns the transaction hash.
   *
   * In production the sponsor service wraps this with fee-bump and
   * sponsored reserves. This method is for direct (non-sponsored) use.
   */
  async simulateSignAndSubmit(txXdr: string, signer: Keypair): Promise<string> {
    const tx = TransactionBuilder.fromXDR(txXdr, this.networkPassphrase) as Transaction;

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }

    const prepared = rpc
      .assembleTransaction(tx, sim as rpc.Api.SimulateTransactionSuccessResponse)
      .build();

    prepared.sign(signer);

    const response = await this.server.sendTransaction(prepared);
    if (response.status === "ERROR") {
      throw new Error(`sendTransaction failed: ${JSON.stringify(response)}`);
    }

    // Poll until confirmed or failed.
    const hash = response.hash;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const status = await this.server.getTransaction(hash);
      if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) return hash;
      if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(status)}`);
      }
    }

    throw new Error(`Transaction not confirmed after polling: ${hash}`);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Build a transaction that calls a function with a single u64 id argument. */
  private buildIdCall(
    method: string,
    id: bigint,
    sourceAccount: Account,
  ): string {
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(method, nativeToScVal(id, { type: "u64" })),
      )
      .setTimeout(30)
      .build();

    return tx.toEnvelope().toXDR("base64");
  }
}

// ── Decode helpers ─────────────────────────────────────────────────────────

function decodeOrder(val: xdr.ScVal): Order {
  const raw = scValToNative(val) as Record<string, unknown>;

  return {
    buyer: coerceString(raw["buyer"]),
    seller: coerceString(raw["seller"]),
    token: coerceString(raw["token"]),
    amount: coerceBigInt(raw["amount"]),
    shipBy: coerceBigInt(raw["ship_by"]),
    reviewSecs: coerceBigInt(raw["review_secs"]),
    shippedAt: coerceBigInt(raw["shipped_at"]),
    status: decodeStatus(raw["status"]),
  };
}

/** Coerce an unknown value to string safely. */
function coerceString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") {
    return String(v);
  }
  return "";
}

/** Coerce an unknown value to bigint safely. */
function coerceBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  return 0n;
}

function decodeStatus(raw: unknown): OrderStatus {
  if (typeof raw === "number" && raw in STATUS_BY_DISCRIMINANT) {
    return STATUS_BY_DISCRIMINANT[raw] as OrderStatus;
  }
  if (typeof raw === "string" && isOrderStatus(raw)) return raw;
  throw new Error(`Unknown on-chain status value: ${String(raw)}`);
}

function isOrderStatus(s: string): s is OrderStatus {
  return (ALL_STATUSES as string[]).includes(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Construct an EscrowClient from environment variables.
 * Reads: ESCROW_CONTRACT_ID, STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE.
 * Throws if any are missing.
 */
export function createClientFromEnv(): EscrowClient {
  const contractId = process.env["ESCROW_CONTRACT_ID"];
  const rpcUrl = process.env["STELLAR_RPC_URL"];
  const networkPassphrase = process.env["STELLAR_NETWORK_PASSPHRASE"];

  if (!contractId || !rpcUrl || !networkPassphrase) {
    throw new Error(
      "Missing required env vars: ESCROW_CONTRACT_ID, STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE",
    );
  }

  return new EscrowClient({ contractId, rpcUrl, networkPassphrase });
}

// Re-export Networks for convenience.
export { Networks };
