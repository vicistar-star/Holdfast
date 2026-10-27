/**
 * MockPaymentProvider — realistic mock for dev and tests.
 *
 * Simulates: per-order virtual accounts, duplicate webhook delivery,
 * out-of-order events, idempotent payouts, configurable failures.
 *
 * ASSUMPTION: No real partner endpoints are implemented. All real-provider
 * adapters must mark every endpoint as "ASSUMPTION:" or TODO.
 * See docs/decisions.md.
 */
import { createHmac } from "node:crypto";
import type {
  PaymentProvider,
  PaymentInstructions,
  PartnerTransaction,
  PayoutRequest,
  PayoutResult,
  AccountNameResult,
  WebhookVerifyResult,
} from "./provider.ts";

interface StoredPayment {
  reference: string;
  orderId: string;
  amount_minor: bigint;
  currency: string;
  status: "pending" | "success" | "failed";
  created_at: Date;
}

interface StoredPayout {
  idempotency_key: string;
  amount_minor: bigint;
  status: "pending" | "success" | "failed";
  partner_ref: string;
}

export class MockPaymentProvider implements PaymentProvider {
  private readonly payments = new Map<string, StoredPayment>();
  private readonly payouts = new Map<string, StoredPayout>();
  private readonly secret: string;

  constructor(secret = "mock-webhook-secret") {
    this.secret = secret;
  }

  async createPaymentInstructions(
    orderId: string,
    amountMinor: bigint,
    currency: string,
  ): Promise<PaymentInstructions> {
    const reference = `mock_${orderId.slice(0, 8)}_${Date.now()}`;
    this.payments.set(reference, {
      reference,
      orderId,
      amount_minor: amountMinor,
      currency,
      status: "pending",
      created_at: new Date(),
    });
    return {
      reference,
      account_number: "0123456789",
      bank_name: "Mock Bank",
      instructions: `Transfer ${currency} ${amountMinor} to 0123456789 at Mock Bank. Ref: ${reference}`,
    };
  }

  /**
   * Simulate a successful payment — call in tests to produce a signed webhook body.
   * Returns { body, signature } ready to POST to /v1/webhooks/payments.
   */
  simulatePayment(reference: string): { body: string; signature: string } {
    const payment = this.payments.get(reference);
    if (!payment) throw new Error(`Unknown reference: ${reference}`);
    payment.status = "success";

    const event = {
      event_id: `evt_${reference}`,
      event: "charge.success",
      data: {
        reference,
        amount: Number(payment.amount_minor),
        currency: payment.currency,
        status: "success",
      },
    };
    const body = JSON.stringify(event);
    const signature = createHmac("sha256", this.secret).update(body).digest("hex");
    return { body, signature };
  }

  async verifyWebhook(rawBody: string, signature: string): Promise<WebhookVerifyResult> {
    const expected = createHmac("sha256", this.secret).update(rawBody).digest("hex");
    if (expected !== signature) {
      return { ok: false, event_id: "", event_type: "", reference: "", amount_minor: 0n, currency: "" };
    }
    let parsed: {
      event_id: string;
      event: string;
      data: { reference: string; amount: number; currency: string };
    };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      return { ok: false, event_id: "", event_type: "", reference: "", amount_minor: 0n, currency: "" };
    }
    return {
      ok: true,
      event_id: parsed.event_id,
      event_type: parsed.event,
      reference: parsed.data.reference,
      amount_minor: BigInt(parsed.data.amount),
      currency: parsed.data.currency,
    };
  }

  async getPaymentStatus(reference: string): Promise<PartnerTransaction | null> {
    const p = this.payments.get(reference);
    if (!p) return null;
    return {
      id: `txn_${reference}`,
      reference: p.reference,
      amount_minor: p.amount_minor,
      currency: p.currency,
      status: p.status,
      created_at: p.created_at,
    };
  }

  async createPayout(req: PayoutRequest): Promise<PayoutResult> {
    // Idempotent: return existing result for the same key.
    const existing = this.payouts.get(req.idempotency_key);
    if (existing) return { partner_ref: existing.partner_ref, status: existing.status };

    const partner_ref = `payout_${req.idempotency_key}_${Date.now()}`;
    this.payouts.set(req.idempotency_key, {
      idempotency_key: req.idempotency_key,
      amount_minor: req.amount_minor,
      status: "success",
      partner_ref,
    });
    return { partner_ref, status: "success" };
  }

  async createRefund(req: PayoutRequest): Promise<PayoutResult> {
    return this.createPayout(req);
  }

  async resolveAccountName(accountNumber: string, bankCode: string): Promise<AccountNameResult> {
    // Mock always succeeds — real implementation calls partner's name-enquiry API.
    return { name: "MOCK ACCOUNT HOLDER", account_number: accountNumber, bank_code: bankCode };
  }

  async listTransactions(since: Date): Promise<PartnerTransaction[]> {
    return Array.from(this.payments.values())
      .filter((p) => p.created_at >= since)
      .map((p) => ({
        id: `txn_${p.reference}`,
        reference: p.reference,
        amount_minor: p.amount_minor,
        currency: p.currency,
        status: p.status,
        created_at: p.created_at,
      }));
  }
}

export const mockProvider = new MockPaymentProvider(
  process.env["PAYMENT_WEBHOOK_SECRET"] ?? "mock-webhook-secret",
);

export function getPaymentProvider(): PaymentProvider {
  const name = process.env["PAYMENT_PROVIDER"] ?? "mock";
  if (name === "mock") return mockProvider;
  // TODO: real provider adapters — mark all endpoints ASSUMPTION until verified.
  throw new Error(`Unknown PAYMENT_PROVIDER: "${name}". Only "mock" is implemented.`);
}
