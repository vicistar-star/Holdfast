/**
 * packages/shared/src/reputation.test.ts
 *
 * Fixture-based tests for seller reputation engine.
 * Hand-computed expected values, including all edge cases specified in README:
 * 1. Zero orders (empty state)
 * 2. One dispute among three orders (sample < 10 -> "New seller", disputeRate: null)
 * 3. All disputes lost
 * 4. Anti-gaming: self-dealing (buyer phone == seller phone/payout)
 * 5. Anti-gaming: buyer-seller wash loop (> 3 orders from same buyer)
 * 6. Median time to ship and median response time
 * 7. Verification flag kept strictly separate from performance metrics
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeReputation,
  getVolumeBand,
  calculateMedian,
  checkAntiGaming,
  type OrderRecordForReputation,
} from "./index.ts";

describe("Seller Reputation Engine", () => {
  const baseDate = new Date("2026-10-01T12:00:00Z");
  const sellerPhone = "+2348011111111";
  const sellerPayout = "0123456789";

  it("fixture: zero orders (new seller, empty history)", () => {
    const rep = computeReputation({
      sellerHandle: "new_store",
      sellerCreatedAt: new Date("2026-09-01T12:00:00Z"),
      kycTier: 0,
      orders: [],
      now: baseDate,
    });

    assert.equal(rep.sellerHandle, "new_store");
    assert.equal(rep.isVerified, false);
    assert.equal(rep.isNewSeller, true);
    assert.equal(rep.disputeRate, null);
    assert.equal(rep.completedOrdersLifetime, 0);
    assert.equal(rep.completedOrdersTrailing90d, 0);
    assert.equal(rep.disputesLost, 0);
    assert.equal(rep.totalVolumeBand, "Under ₦100,000");
    assert.equal(rep.medianTimeToShipHours, null);
    assert.equal(rep.medianResponseTimeHours, null);
    assert.equal(rep.accountAgeDays, 30);
  });

  it("fixture: one dispute among three orders (below min sample size)", () => {
    // 3 orders: 2 released, 1 disputed
    const orders: OrderRecordForReputation[] = [
      {
        id: "ord_1",
        sellerId: "s_1",
        buyerPhone: "+2348020000001",
        sellerPhone,
        amount: 2_500_000n, // ₦25,000
        status: "Released",
        createdAt: new Date("2026-09-10T10:00:00Z"),
        fundedAt: new Date("2026-09-10T11:00:00Z"),
        shippedAt: new Date("2026-09-11T11:00:00Z"), // 24h to ship
        releasedAt: new Date("2026-09-13T12:00:00Z"),
      },
      {
        id: "ord_2",
        sellerId: "s_1",
        buyerPhone: "+2348020000002",
        sellerPhone,
        amount: 5_000_000n, // ₦50,000
        status: "Released",
        createdAt: new Date("2026-09-15T10:00:00Z"),
        fundedAt: new Date("2026-09-15T11:00:00Z"),
        shippedAt: new Date("2026-09-17T11:00:00Z"), // 48h to ship
        releasedAt: new Date("2026-09-18T12:00:00Z"),
      },
      {
        id: "ord_3",
        sellerId: "s_1",
        buyerPhone: "+2348020000003",
        sellerPhone,
        amount: 3_000_000n, // ₦30,000
        status: "Disputed",
        createdAt: new Date("2026-09-20T10:00:00Z"),
        fundedAt: new Date("2026-09-20T11:00:00Z"),
        shippedAt: new Date("2026-09-21T11:00:00Z"),
        disputedAt: new Date("2026-09-22T10:00:00Z"),
      },
    ];

    const rep = computeReputation({
      sellerHandle: "growing_boutique",
      sellerCreatedAt: new Date("2026-08-01T12:00:00Z"),
      kycTier: 1, // KYC verified
      orders,
      now: baseDate,
      minSampleSize: 10,
    });

    // Verified marker is separate from performance
    assert.equal(rep.isVerified, true);
    // Shipped count = 3 < 10, so isNewSeller is true and disputeRate is null (no single dispute penalization)
    assert.equal(rep.isNewSeller, true);
    assert.equal(rep.disputeRate, null);
    assert.equal(rep.completedOrdersLifetime, 2);
    assert.equal(rep.completedOrdersTrailing90d, 2);
    assert.equal(rep.totalVolumeBand, "Under ₦100,000"); // ₦25,000 + ₦50,000 = ₦75,000
    // Median time to ship of [24, 48, 24] = 24 hours
    assert.equal(rep.medianTimeToShipHours, 24);
  });

  it("fixture: all disputes lost with sufficient sample size", () => {
    // 10 orders, all disputed and resolved 100% in buyer's favour
    const orders: OrderRecordForReputation[] = [];
    for (let i = 1; i <= 10; i++) {
      orders.push({
        id: `ord_${i}`,
        sellerId: "s_bad",
        buyerPhone: `+23480300000${i.toString().padStart(2, "0")}`,
        sellerPhone,
        amount: 10_000_000n,
        status: "Resolved",
        createdAt: new Date(`2026-09-${i.toString().padStart(2, "0")}T10:00:00Z`),
        fundedAt: new Date(`2026-09-${i.toString().padStart(2, "0")}T11:00:00Z`),
        shippedAt: new Date(`2026-09-${i.toString().padStart(2, "0")}T15:00:00Z`),
        disputedAt: new Date(`2026-09-${i.toString().padStart(2, "0")}T18:00:00Z`),
        resolvedAt: new Date(`2026-09-${i.toString().padStart(2, "0")}T20:00:00Z`),
        buyerShare: 10_000_000n, // Full refund to buyer
        sellerShare: 0n,
      });
    }

    const rep = computeReputation({
      sellerHandle: "bad_seller",
      sellerCreatedAt: new Date("2026-08-01T12:00:00Z"),
      kycTier: 1,
      orders,
      now: baseDate,
      minSampleSize: 10,
    });

    assert.equal(rep.isNewSeller, false);
    assert.equal(rep.disputeRate, 1.0); // 10 / 10 = 1.0
    assert.equal(rep.disputesLost, 10);
    assert.equal(rep.completedOrdersLifetime, 0); // No released orders
  });

  it("anti-gaming: flags self-dealing and excludes from reputation", () => {
    const orderSelfDealing: OrderRecordForReputation = {
      id: "ord_self",
      sellerId: "s_1",
      buyerPhone: sellerPhone, // Same phone!
      sellerPhone,
      amount: 100_000_000n,
      status: "Released",
      createdAt: baseDate,
    };

    const res = checkAntiGaming(orderSelfDealing, 0);
    assert.equal(res.isFlagged, true);
    assert.deepEqual(res.reasons, ["self_dealing"]);

    // When processed in reputation, it must be flagged and excluded
    const rep = computeReputation({
      sellerHandle: "cheater",
      sellerCreatedAt: new Date("2026-08-01T12:00:00Z"),
      kycTier: 0,
      orders: [orderSelfDealing],
      now: baseDate,
    });

    assert.equal(rep.flaggedOrdersCount, 1);
    assert.equal(rep.completedOrdersLifetime, 0); // Excluded!
    assert.equal(rep.totalVolumeBand, "Under ₦100,000");
  });

  it("anti-gaming: flags repeated buyer-seller wash loop", () => {
    const buyerPhone = "+2348077777777";
    const orders: OrderRecordForReputation[] = [];

    // Create 5 orders from the exact same buyer
    for (let i = 1; i <= 5; i++) {
      orders.push({
        id: `wash_${i}`,
        sellerId: "s_1",
        buyerPhone,
        sellerPhone,
        sellerPayoutAccount: sellerPayout,
        amount: 20_000_000n,
        status: "Released",
        createdAt: new Date(`2026-09-0${i}T10:00:00Z`),
        releasedAt: new Date(`2026-09-0${i}T12:00:00Z`),
      });
    }

    const rep = computeReputation({
      sellerHandle: "loop_seller",
      sellerCreatedAt: new Date("2026-08-01T12:00:00Z"),
      kycTier: 0,
      orders,
      now: baseDate,
      minSampleSize: 10,
    });

    // Orders 1, 2, 3 allowed (prior counts 0, 1, 2 < 3)
    // Orders 4 and 5 flagged as wash loop (prior count >= 3)
    assert.equal(rep.flaggedOrdersCount, 2);
    assert.equal(rep.completedOrdersLifetime, 3);
  });

  it("helpers: volume bands and median calculation", () => {
    assert.equal(getVolumeBand(5_000_000n), "Under ₦100,000");
    assert.equal(getVolumeBand(25_000_000n), "₦100,000 - ₦500,000");
    assert.equal(getVolumeBand(100_000_000n), "₦500,000 - ₦2,000,000");
    assert.equal(getVolumeBand(500_000_000n), "₦2,000,000 - ₦10,000,000");
    assert.equal(getVolumeBand(2_000_000_000n), "₦10,000,000+");

    assert.equal(calculateMedian([]), null);
    assert.equal(calculateMedian([5]), 5);
    assert.equal(calculateMedian([10, 20, 30]), 20);
    assert.equal(calculateMedian([10, 20, 30, 40]), 25);
  });
});
