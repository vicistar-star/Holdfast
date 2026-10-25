/**
 * shared package tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeFee,
  assertConservation,
  parseEscrowMode,
  TERMINAL_STATUSES,
} from "./index.ts";

describe("computeFee", () => {
  it("computes 1% fee correctly", () => {
    assert.equal(computeFee(1_000_000n, 100n), 10_000n);
  });

  it("rounds down (floor division)", () => {
    // 1 * 100 / 10_000 = 0.01 → floors to 0
    assert.equal(computeFee(1n, 100n), 0n);
    // 99 * 100 / 10_000 = 0.99 → floors to 0
    assert.equal(computeFee(99n, 100n), 0n);
    // 100 * 100 / 10_000 = 1.0 → exactly 1
    assert.equal(computeFee(100n, 100n), 1n);
  });

  it("returns 0 for 0 bps", () => {
    assert.equal(computeFee(1_000_000n, 0n), 0n);
  });

  it("computes max fee (500 bps = 5%)", () => {
    assert.equal(computeFee(1_000_000n, 500n), 50_000n);
  });

  it("throws for negative feeBps", () => {
    assert.throws(() => computeFee(1_000_000n, -1n), /RangeError/);
  });

  it("throws for feeBps above 500", () => {
    assert.throws(() => computeFee(1_000_000n, 501n), /RangeError/);
  });
});

describe("assertConservation", () => {
  it("passes when payouts sum to funded amount", () => {
    assertConservation(1_000_000n, 990_000n, 10_000n);
  });

  it("throws when payouts do not sum", () => {
    assert.throws(
      () => assertConservation(1_000_000n, 990_000n, 9_999n),
      /Conservation violated/,
    );
  });

  it("passes for a zero-fee refund", () => {
    assertConservation(500_000n, 500_000n);
  });
});

describe("parseEscrowMode", () => {
  it("returns A by default", () => {
    assert.equal(parseEscrowMode(undefined), "A");
    assert.equal(parseEscrowMode(""), "A");
    assert.equal(parseEscrowMode("C"), "A");
  });

  it("returns B only for exactly 'B'", () => {
    assert.equal(parseEscrowMode("B"), "B");
  });
});

describe("TERMINAL_STATUSES", () => {
  it("contains Released, Refunded, Resolved", () => {
    assert.ok(TERMINAL_STATUSES.has("Released"));
    assert.ok(TERMINAL_STATUSES.has("Refunded"));
    assert.ok(TERMINAL_STATUSES.has("Resolved"));
  });

  it("does not contain non-terminal statuses", () => {
    assert.ok(!TERMINAL_STATUSES.has("Funded"));
    assert.ok(!TERMINAL_STATUSES.has("Shipped"));
    assert.ok(!TERMINAL_STATUSES.has("Disputed"));
  });
});
