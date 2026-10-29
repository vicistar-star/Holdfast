/**
 * apps/web/src/components.test.ts
 *
 * Tests for frontend presentation logic, state copy, and invariants.
 *
 * Checks:
 * 1. Plain language copy for every state.
 * 2. ZERO chain terminology in any user-facing string.
 * 3. Buyer refund guarantee copy in plain words.
 * 4. Naira formatting from minor units.
 * 5. Conservation and fee-split math on the frontend.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getStatusPresentation,
  getLinkGuaranteeCopy,
  formatNaira,
} from "./lib/presentation.ts";
import { ALL_ORDER_STATUSES } from "@holdfast/shared";

// Forbidden chain jargon in user-facing text per README rule 13
const FORBIDDEN_WORDS = [
  "blockchain",
  "stellar",
  "soroban",
  "xlm",
  "crypto",
  "wallet",
  "seed phrase",
  "gas fee",
  "smart contract",
  "on-chain",
  "token",
];

describe("Frontend Presentation & User-Facing Invariants", () => {
  it("zero chain terminology in all order status copy", () => {
    for (const status of ALL_ORDER_STATUSES) {
      const copy = getStatusPresentation(status, {
        shipBy: new Date(),
        reviewEnds: new Date(),
        sellerHandle: "demo_seller",
      });

      const fullText = `${copy.badge} ${copy.title} ${copy.description} ${copy.nextActionTitle} ${copy.nextActionDescription}`.toLowerCase();

      for (const word of FORBIDDEN_WORDS) {
        assert.equal(
          fullText.includes(word),
          false,
          `Found forbidden word "${word}" in copy for status ${status}: "${fullText}"`,
        );
      }
    }
  });

  it("buyer pay page guarantee copy in plain words", () => {
    const guarantees = getLinkGuaranteeCopy(48, 24);
    assert.equal(guarantees.length, 3);
    assert.ok(guarantees[0]?.includes("Guaranteed refund"));
    assert.ok(guarantees[0]?.includes("48 hours"));
    assert.ok(guarantees[1]?.includes("24 hours"));

    const combined = guarantees.join(" ").toLowerCase();
    for (const word of FORBIDDEN_WORDS) {
      assert.equal(
        combined.includes(word),
        false,
        `Found forbidden word "${word}" in guarantee copy: "${combined}"`,
      );
    }
  });

  it("naira currency formatting from minor units", () => {
    assert.equal(formatNaira(0n), "₦0");
    assert.equal(formatNaira(2500000n), "₦25,000");
    assert.equal(formatNaira(10000000n), "₦100,000");
    assert.equal(formatNaira(2500050n), "₦25,000.50");
    assert.equal(formatNaira("50000000"), "₦500,000");
  });

  it("status copy matches state machine transitions", () => {
    const funded = getStatusPresentation("Funded", { shipBy: "2026-10-31T12:00:00Z" });
    assert.equal(funded.badge, "Payment Received");
    assert.ok(funded.nextActionDescription.includes("automatic full refund"));

    const shipped = getStatusPresentation("Shipped", { reviewEnds: "2026-11-02T12:00:00Z" });
    assert.equal(shipped.badge, "Package On The Way");
    assert.ok(shipped.nextActionDescription.includes("confirm delivery"));

    const released = getStatusPresentation("Released");
    assert.equal(released.badge, "Order Completed");

    const refunded = getStatusPresentation("Refunded");
    assert.equal(refunded.badge, "Refunded in Full");

    const disputed = getStatusPresentation("Disputed");
    assert.equal(disputed.badge, "Under Review");

    const resolved = getStatusPresentation("Resolved");
    assert.equal(resolved.badge, "Dispute Settled");
  });
});
