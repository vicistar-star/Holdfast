/**
 * @holdfast/shared — unit tests
 *
 * Run: node --experimental-strip-types --test src/index.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeFee,
  assertConservation,
  parseEscrowMode,
  TERMINAL_STATUSES,
  formatMinorUnits,
  parseMinorUnits,
  transition,
  type TransitionContext,
} from "./index.ts";

// ── computeFee ────────────────────────────────────────────────────────────────

describe("computeFee", () => {
  it("computes 1% fee", () => assert.equal(computeFee(1_000_000n, 100n), 10_000n));
  it("rounds down", () => {
    assert.equal(computeFee(1n, 100n), 0n);
    assert.equal(computeFee(99n, 100n), 0n);
    assert.equal(computeFee(100n, 100n), 1n);
  });
  it("0 bps => 0 fee", () => assert.equal(computeFee(1_000_000n, 0n), 0n));
  it("max fee 500 bps = 5%", () => assert.equal(computeFee(1_000_000n, 500n), 50_000n));
  it("throws for negative bps", () => assert.throws(() => computeFee(1n, -1n), RangeError));
  it("throws for bps > 500", () => assert.throws(() => computeFee(1n, 501n), RangeError));

  // Cross-check vectors: fee = floor(amount * bps / 10000)
  const vectors: [bigint, bigint, bigint][] = [
    [10_000n, 100n, 100n],
    [10_001n, 100n, 100n],   // floor — not 100.01
    [9_999n, 100n, 99n],
    [500_000_000n, 250n, 12_500_000n],
  ];
  for (const [amount, bps, expected] of vectors) {
    it(`computeFee(${amount}, ${bps}) == ${expected}`, () => {
      assert.equal(computeFee(amount, bps), expected);
    });
  }
});

// ── assertConservation ────────────────────────────────────────────────────────

describe("assertConservation", () => {
  it("passes when payouts sum to funded", () => {
    assertConservation(1_000_000n, 990_000n, 10_000n);
  });
  it("throws when payouts do not sum", () => {
    assert.throws(() => assertConservation(1_000_000n, 990_000n, 9_999n), /Conservation violated/);
  });
  it("fee-free refund: single payout equals funded", () => {
    assertConservation(500_000n, 500_000n);
  });
  it("zero amount edge case", () => {
    assertConservation(0n, 0n);
  });
});

// ── formatMinorUnits / parseMinorUnits ────────────────────────────────────────

describe("formatMinorUnits", () => {
  it("formats kobo to naira", () => assert.equal(formatMinorUnits(500050n, 2), "5000.50"));
  it("pads fractional zeros", () => assert.equal(formatMinorUnits(100n, 2), "1.00"));
  it("zero decimals", () => assert.equal(formatMinorUnits(12345n, 0), "12345"));
  it("throws for negative decimals", () => assert.throws(() => formatMinorUnits(1n, -1), RangeError));
});

describe("parseMinorUnits", () => {
  it("parses decimal string", () => assert.equal(parseMinorUnits("5000.50", 2), 500050n));
  it("parses whole number", () => assert.equal(parseMinorUnits("5000", 2), 500000n));
  it("throws on too many decimals", () => {
    assert.throws(() => parseMinorUnits("5000.123", 2), RangeError);
  });
  it("round-trips with format", () => {
    const original = 123456789n;
    const formatted = formatMinorUnits(original, 2);
    assert.equal(parseMinorUnits(formatted, 2), original);
  });
});

// ── parseEscrowMode ───────────────────────────────────────────────────────────

describe("parseEscrowMode", () => {
  it("defaults to A", () => {
    assert.equal(parseEscrowMode(undefined), "A");
    assert.equal(parseEscrowMode(""), "A");
    assert.equal(parseEscrowMode("C"), "A");
  });
  it("returns B for 'B'", () => assert.equal(parseEscrowMode("B"), "B"));
});

// ── TERMINAL_STATUSES ─────────────────────────────────────────────────────────

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

// ── State machine ─────────────────────────────────────────────────────────────

const now = new Date("2026-01-15T12:00:00Z");
const future = new Date("2026-01-17T12:00:00Z"); // 2 days from now
const past = new Date("2026-01-13T12:00:00Z");   // 2 days ago

function ctx(overrides: Partial<TransitionContext>): TransitionContext {
  return {
    status: "Funded",
    action: "mark_shipped",
    actor: "seller",
    now,
    shipBy: future,
    reviewEnds: null,
    ...overrides,
  };
}

describe("transition — happy paths", () => {
  it("create_and_fund -> Funded (buyer)", () => {
    const r = transition(ctx({ action: "create_and_fund", actor: "buyer", status: "Funded" }));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.nextStatus, "Funded");
  });

  it("mark_shipped -> Shipped (seller, before ship_by)", () => {
    const r = transition(ctx({ status: "Funded", action: "mark_shipped", actor: "seller" }));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.nextStatus, "Shipped");
  });

  it("confirm_delivery -> Released (buyer)", () => {
    const r = transition(ctx({ status: "Shipped", action: "confirm_delivery", actor: "buyer" }));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.nextStatus, "Released");
  });

  it("claim_auto_release -> Released (anyone, after review window)", () => {
    const reviewEnds = past;
    const r = transition(ctx({
      status: "Shipped",
      action: "claim_auto_release",
      actor: "keeper",
      reviewEnds,
    }));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.nextStatus, "Released");
  });

  it("claim_refund -> Refunded (anyone, after ship_by)", () => {
    const r = transition(ctx({
      status: "Funded",
      action: "claim_refund",
      actor: "keeper",
      shipBy: past,
    }));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.nextStatus, "Refunded");
  });

  it("open_dispute -> Disputed (buyer, inside review window)", () => {
    const r = transition(ctx({
      status: "Shipped",
      action: "open_dispute",
      actor: "buyer",
      reviewEnds: future,
    }));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.nextStatus, "Disputed");
  });

  it("resolve_dispute -> Resolved (arbiter)", () => {
    const r = transition(ctx({
      status: "Disputed",
      action: "resolve_dispute",
      actor: "arbiter",
    }));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.nextStatus, "Resolved");
  });
});

describe("transition — wrong actor", () => {
  it("mark_shipped by buyer fails", () => {
    const r = transition(ctx({ action: "mark_shipped", actor: "buyer" }));
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, "WRONG_ACTOR");
  });
  it("confirm_delivery by seller fails", () => {
    const r = transition(ctx({ status: "Shipped", action: "confirm_delivery", actor: "seller" }));
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, "WRONG_ACTOR");
  });
  it("resolve_dispute by buyer fails", () => {
    const r = transition(ctx({ status: "Disputed", action: "resolve_dispute", actor: "buyer" }));
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, "WRONG_ACTOR");
  });
  it("open_dispute by seller fails", () => {
    const r = transition(ctx({ status: "Shipped", action: "open_dispute", actor: "seller", reviewEnds: future }));
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, "WRONG_ACTOR");
  });
});

describe("transition — wrong state", () => {
  const illegal: Array<[string, Partial<TransitionContext>]> = [
    ["mark_shipped in Shipped", { status: "Shipped", action: "mark_shipped", actor: "seller" }],
    ["confirm_delivery in Funded", { status: "Funded", action: "confirm_delivery", actor: "buyer" }],
    ["open_dispute in Funded", { status: "Funded", action: "open_dispute", actor: "buyer" }],
    ["claim_refund in Shipped", { status: "Shipped", action: "claim_refund", actor: "keeper", shipBy: past }],
    ["resolve_dispute in Funded", { status: "Funded", action: "resolve_dispute", actor: "arbiter" }],
    ["mark_shipped in Released", { status: "Released", action: "mark_shipped", actor: "seller" }],
    ["mark_shipped in Refunded", { status: "Refunded", action: "mark_shipped", actor: "seller" }],
    ["mark_shipped in Disputed", { status: "Disputed", action: "mark_shipped", actor: "seller" }],
    ["mark_shipped in Resolved", { status: "Resolved", action: "mark_shipped", actor: "seller" }],
    ["open_dispute in Disputed", { status: "Disputed", action: "open_dispute", actor: "buyer", reviewEnds: future }],
    ["open_dispute in Released", { status: "Released", action: "open_dispute", actor: "buyer", reviewEnds: future }],
  ];

  for (const [name, overrides] of illegal) {
    it(`rejects: ${name}`, () => {
      const r = transition(ctx(overrides));
      assert.ok(!r.ok, `Expected error for: ${name}`);
      if (!r.ok) assert.equal(r.error.code, "WRONG_STATE");
    });
  }
});

describe("transition — time-based guards", () => {
  it("mark_shipped fails after ship_by deadline", () => {
    const r = transition(ctx({ action: "mark_shipped", actor: "seller", shipBy: past }));
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, "WINDOW_CLOSED");
  });

  it("claim_auto_release fails while review window is open", () => {
    const r = transition(ctx({
      status: "Shipped",
      action: "claim_auto_release",
      actor: "keeper",
      reviewEnds: future,
    }));
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, "WINDOW_OPEN");
  });

  it("claim_refund fails before ship_by deadline", () => {
    const r = transition(ctx({ action: "claim_refund", actor: "keeper", shipBy: future }));
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, "DEADLINE_NOT_PASSED");
  });

  it("open_dispute fails after review window closes", () => {
    const r = transition(ctx({
      status: "Shipped",
      action: "open_dispute",
      actor: "buyer",
      reviewEnds: past,
    }));
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.error.code, "WINDOW_CLOSED");
  });
});
