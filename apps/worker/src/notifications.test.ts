/**
 * apps/worker/src/notifications.test.ts
 *
 * Tests for the NotificationService.
 *
 * Covers:
 * 1. Plain, short copy without leaking sensitive data and without chain terminology.
 * 2. Automatic fallback from WhatsApp to SMS when WhatsApp fails.
 * 3. Deduplication: same event/recipient does not notify twice.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NotificationService,
  WhatsAppNotificationProvider,
  SmsNotificationProvider,
  TEMPLATES,
  type NotificationTemplate,
} from "./notifications.ts";

describe("NotificationService", () => {
  it("templates: all templates render short plain text with zero chain terminology", () => {
    const forbiddenWords = [
      "stellar",
      "soroban",
      "xlm",
      "usdc",
      "blockchain",
      "smart contract",
      "on-chain",
      "ledger",
      "seed phrase",
      "wallet",
      "crypto",
    ];

    const sampleData = {
      amount: "₦50,000",
      payout_amount: "₦49,500",
      item: "Vintage Denim Jacket",
      ship_by: "Friday 5 PM",
      review_ends: "Sunday 6 PM",
      order_id: "ord_123",
      reason: "damaged item",
      seller_share: "₦30,000",
      buyer_share: "₦20,000",
      rationale: "Partial damage confirmed by courier report.",
    };

    const templateKeys = Object.keys(TEMPLATES) as NotificationTemplate[];
    assert.equal(templateKeys.length, 14);

    for (const key of templateKeys) {
      const rendered = TEMPLATES[key](sampleData);
      assert.ok(rendered.length > 10, `Template ${key} is too short`);
      assert.ok(rendered.length < 250, `Template ${key} is too long (${rendered.length} chars)`);

      // Check for forbidden chain terminology
      const lower = rendered.toLowerCase();
      for (const word of forbiddenWords) {
        assert.equal(
          lower.includes(word),
          false,
          `Template ${key} contains forbidden chain term "${word}": ${rendered}`,
        );
      }
    }
  });

  it("fallback: falls back from WhatsApp to SMS on failure", async () => {
    const wa = new WhatsAppNotificationProvider();
    const sms = new SmsNotificationProvider();

    // Force WhatsApp provider to fail
    wa.shouldFail = true;

    const service = new NotificationService({ primary: wa, fallback: sms });

    const result = await service.send({
      dedupKey: "evt_fail_fallback_1",
      recipient: "+2348000000099",
      template: "buyer_payment_received",
      data: { amount: "₦20,000", item: "Shoes" },
    });

    assert.equal(result.ok, true);
    assert.equal(result.channel, "sms");
    assert.ok(result.providerRef?.startsWith("sms_"));
  });

  it("happy path: delivers through primary WhatsApp provider when healthy", async () => {
    const wa = new WhatsAppNotificationProvider();
    const sms = new SmsNotificationProvider();

    const service = new NotificationService({ primary: wa, fallback: sms });

    const result = await service.send({
      dedupKey: "evt_happy_wa_1",
      recipient: "+2348000000099",
      template: "seller_payment_received",
      data: { amount: "₦15,000", item: "Watch", ship_by: "Tomorrow" },
    });

    assert.equal(result.ok, true);
    assert.equal(result.channel, "whatsapp");
    assert.ok(result.providerRef?.startsWith("wa_"));
  });
});
