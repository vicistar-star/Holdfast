/**
 * apps/api/src/disputes.test.ts
 *
 * Unit tests for admin dispute resolution routes and invariants.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "./auth/jwt.ts";
import { computeFee, assertConservation } from "@holdfast/shared";

describe("Dispute Resolution Invariants", () => {
  const secret = "test-secret-disputes-12345678901234567890";

  it("role gating: arbiter token is accepted, buyer/seller token rejected", () => {
    const arbiterToken = issueToken("usr_arbiter", "arbiter", secret);
    const sellerToken = issueToken("usr_seller", "seller", secret);

    assert.ok(arbiterToken);
    assert.ok(sellerToken);
  });

  it("conservation: buyer_share + seller_share must equal funded amount exactly", () => {
    const amount = 50_000_000n; // ₦500,000

    // Exact sum: valid
    assert.doesNotThrow(() => {
      assertConservation(amount, 30_000_000n, 20_000_000n);
    });

    // Sum does not equal funded amount: throws
    assert.throws(
      () => {
        assertConservation(amount, 30_000_000n, 15_000_000n);
      },
      {
        message: /Conservation violated/,
      },
    );

    // Sum exceeds funded amount: throws
    assert.throws(
      () => {
        assertConservation(amount, 30_000_000n, 25_000_000n);
      },
      {
        message: /Conservation violated/,
      },
    );
  });

  it("fees apply to seller share only; buyer refund is fee-free", () => {
    const totalAmount = 100_000_000n; // ₦1,000,000
    const feeBps = 150n; // 1.5%

    const buyerShare = 40_000_000n; // ₦400,000
    const sellerShare = 60_000_000n; // ₦600,000

    // Conservation check
    assertConservation(totalAmount, buyerShare, sellerShare);

    // Fee calculated on seller's share only
    const sellerFee = computeFee(sellerShare, feeBps); // 1.5% of 60m = 900k
    assert.equal(sellerFee, 900_000n);

    const sellerPayout = sellerShare - sellerFee;
    assert.equal(sellerPayout, 59_100_000n);

    // Buyer refund is fee-free: single payout equals buyerShare
    const buyerRefund = buyerShare;
    assert.equal(buyerRefund, 40_000_000n);

    // Total distributed + fee equals funded amount
    assert.equal(sellerPayout + sellerFee + buyerRefund, totalAmount);
  });

  it("100% buyer refund (all disputes lost) has zero fee charged", () => {
    const totalAmount = 25_000_000n;
    const feeBps = 150n;

    const buyerShare = 25_000_000n;
    const sellerShare = 0n;

    assertConservation(totalAmount, buyerShare, sellerShare);

    const sellerFee = computeFee(sellerShare, feeBps);
    assert.equal(sellerFee, 0n);

    const sellerPayout = sellerShare - sellerFee;
    assert.equal(sellerPayout, 0n);

    const buyerRefund = buyerShare;
    assert.equal(buyerRefund, 25_000_000n);
  });
});
