/**
 * PaymentProvider interface.
 *
 * The payment partner holds naira in Mode A. All money movement goes
 * through this interface — swap MockProvider for a real adapter without
 * touching the business logic.
 *
 * ASSUMPTION: Real provider endpoints (Paystack, Flutterwave, etc.) are NOT
 * implemented here. Any real-provider stub must mark every endpoint with
 * "ASSUMPTION:" or TODO. See docs/decisions.md.
 */

export interface PaymentInstructions {
  /** Reference the buyer uses to make the transfer. */
  reference: string;
  /** E.g. virtual account number + bank name for pay-by-transfer. */
  account_number?: string;
  bank_name?: string;
  /** Human-readable payment instructions. */
  instructions: string;
}

export interface PartnerTransaction {
  /** Provider's unique event/transaction ID. */
  id: string;
  reference: string;
  amount_minor: bigint;
  currency: string;
  status: "pending" | "success" | "failed";
  created_at: Date;
}

export interface PayoutRequest {
  /** Idempotency key — must be stored in payouts.partner_ref. */
  idempotency_key: string;
  amount_minor: bigint;
  currency: string;
  /** Verified payout account reference (from sellers.payout_ref). */
  account_ref: string;
  narration: string;
}

export interface PayoutResult {
  partner_ref: string;
  status: "pending" | "success" | "failed";
}

export interface AccountNameResult {
  name: string;
  account_number: string;
  bank_code: string;
}

export interface WebhookVerifyResult {
  ok: boolean;
  event_id: string;
  event_type: string;
  reference: string;
  amount_minor: bigint;
  currency: string;
}

export interface PaymentProvider {
  /**
   * Create per-order payment instructions (e.g. a virtual account).
   * The reference ties the inbound transfer to the order.
   */
  createPaymentInstructions(
    orderId: string,
    amountMinor: bigint,
    currency: string,
  ): Promise<PaymentInstructions>;

  /**
   * Verify and parse an incoming webhook payload.
   * Returns ok:false if the signature is invalid.
   */
  verifyWebhook(
    rawBody: string,
    signature: string,
  ): Promise<WebhookVerifyResult>;

  /** Check current status of a payment by reference. */
  getPaymentStatus(reference: string): Promise<PartnerTransaction | null>;

  /** Initiate a payout to a seller or buyer. Idempotent by idempotency_key. */
  createPayout(req: PayoutRequest): Promise<PayoutResult>;

  /** Initiate a refund (payout back to the buyer). */
  createRefund(req: PayoutRequest): Promise<PayoutResult>;

  /** Resolve a bank account holder name (for KYC name-match). */
  resolveAccountName(
    accountNumber: string,
    bankCode: string,
  ): Promise<AccountNameResult>;

  /** List recent transactions for reconciliation. */
  listTransactions(since: Date): Promise<PartnerTransaction[]>;
}
