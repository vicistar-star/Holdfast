/**
 * PaymentProvider interface.
 * Re-exported from @holdfast/shared.
 */
export type {
  PaymentInstructions,
  PartnerTransaction,
  PayoutRequest,
  PayoutResult,
  AccountNameResult,
  WebhookVerifyResult,
  PaymentProvider,
} from "@holdfast/shared";

import { MockPaymentProvider } from "./mockProvider.ts";

export const defaultPaymentProvider = new MockPaymentProvider();
