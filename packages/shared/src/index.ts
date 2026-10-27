/**
 * @holdfast/shared
 *
 * Exports:
 *  - OrderStatus, EscrowMode, TERMINAL_STATUSES
 *  - Money helpers: computeFee, assertConservation, formatMinorUnits, parseMinorUnits
 *  - State machine: transition()
 *  - Zod schemas for every API input/output
 */

// ── Order status ──────────────────────────────────────────────────────────────

/**
 * The six possible states of an escrow order, matching the on-chain Status enum
 * exactly. Do not add states without updating the contract and README.
 */
export type OrderStatus =
  | "Funded"
  | "Shipped"
  | "Released"
  | "Refunded"
  | "Disputed"
  | "Resolved";

export const ALL_ORDER_STATUSES: OrderStatus[] = [
  "Funded",
  "Shipped",
  "Released",
  "Refunded",
  "Disputed",
  "Resolved",
];

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "Released",
  "Refunded",
  "Resolved",
]);

// ── Escrow mode ───────────────────────────────────────────────────────────────

/** Mode A = local-currency rails; Mode B = on-chain USDC escrow (testnet only). */
export type EscrowMode = "A" | "B";

export function parseEscrowMode(raw: string | undefined): EscrowMode {
  if (raw === "B") return "B";
  return "A"; // default Mode A per README
}

// ── Money helpers ─────────────────────────────────────────────────────────────

/**
 * Compute the platform fee for a payout amount.
 *
 * Fee rounds DOWN (integer / BigInt division truncates toward zero).
 * This matches Rust i128 division in the contract — do not change the rounding
 * rule without updating both.
 *
 * @param amount  - Amount in minor units (non-negative integer).
 * @param feeBps  - Fee in basis points (0–500).
 */
export function computeFee(amount: bigint, feeBps: bigint): bigint {
  if (feeBps < 0n || feeBps > 500n) {
    throw new RangeError(`feeBps must be 0–500, got ${feeBps}`);
  }
  return (amount * feeBps) / 10_000n;
}

/**
 * Assert that payouts sum exactly to the funded amount (conservation invariant).
 * Throws if violated — used in tests and the reconciliation job.
 */
export function assertConservation(
  funded: bigint,
  ...payouts: bigint[]
): void {
  const sum = payouts.reduce((a, b) => a + b, 0n);
  if (sum !== funded) {
    throw new Error(
      `Conservation violated: funded=${funded}, payouts sum=${sum}`,
    );
  }
}

/**
 * Format a bigint minor-unit amount as a human-readable decimal string.
 * e.g. formatMinorUnits(500050n, 2) => "5000.50"
 *
 * @param amount     - Amount in minor units.
 * @param decimals   - Number of decimal places for the currency (e.g. 2 for NGN kobo).
 */
export function formatMinorUnits(amount: bigint, decimals: number): string {
  if (decimals < 0) throw new RangeError("decimals must be >= 0");
  if (decimals === 0) return amount.toString();
  const factor = 10n ** BigInt(decimals);
  const whole = amount / factor;
  const frac = amount % factor;
  return `${whole}.${String(frac).padStart(decimals, "0")}`;
}

/**
 * Parse a decimal string into minor units (bigint).
 * e.g. parseMinorUnits("5000.50", 2) => 500050n
 * Throws on invalid input. Never use for user-provided untrusted strings without
 * validating format first.
 */
export function parseMinorUnits(value: string, decimals: number): bigint {
  if (decimals < 0) throw new RangeError("decimals must be >= 0");
  const clean = value.trim();
  const dotIndex = clean.indexOf(".");
  if (dotIndex === -1) {
    return BigInt(clean) * 10n ** BigInt(decimals);
  }
  const whole = clean.slice(0, dotIndex);
  const frac = clean.slice(dotIndex + 1);
  if (frac.length > decimals) {
    throw new RangeError(
      `Too many decimal places: "${value}" has ${frac.length}, expected <= ${decimals}`,
    );
  }
  const fracPadded = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded);
}

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * The actions that drive order state transitions.
 * Each action maps to exactly one allowed (from, to) pair per the README.
 */
export type OrderAction =
  | "create_and_fund"    // -> Funded
  | "mark_shipped"       // Funded -> Shipped
  | "confirm_delivery"   // Shipped -> Released
  | "claim_auto_release" // Shipped -> Released  (permissionless, after review window)
  | "claim_refund"       // Funded  -> Refunded  (permissionless, after ship_by)
  | "open_dispute"       // Shipped -> Disputed
  | "resolve_dispute";   // Disputed -> Resolved

/** Who is performing the action. */
export type Actor = "buyer" | "seller" | "arbiter" | "keeper" | "system";

export interface TransitionContext {
  status: OrderStatus;
  action: OrderAction;
  actor: Actor;
  now: Date;
  shipBy: Date;
  reviewEnds: Date | null; // set after mark_shipped
}

export type TransitionError =
  | { code: "WRONG_STATE"; message: string }
  | { code: "WRONG_ACTOR"; message: string }
  | { code: "WINDOW_CLOSED"; message: string }
  | { code: "WINDOW_OPEN"; message: string }
  | { code: "DEADLINE_NOT_PASSED"; message: string };

export type TransitionResult =
  | { ok: true; nextStatus: OrderStatus }
  | { ok: false; error: TransitionError };

/**
 * Pure state-machine transition function.
 *
 * Given the current order context, returns either the next status or a typed error.
 * No side effects — callers write to the DB and emit events.
 *
 * Transitions are exactly those defined in the README state machine. Any unlisted
 * (from, action) pair is a WRONG_STATE error.
 */
export function transition(ctx: TransitionContext): TransitionResult {
  const { status, action, actor, now, shipBy, reviewEnds } = ctx;

  switch (action) {
    case "create_and_fund":
      // Only valid from "no order" — represented here as transitioning to Funded
      // from a fresh order (called by system/buyer before any status exists).
      // The API layer calls this only when creating a new order.
      if (actor !== "buyer" && actor !== "system") {
        return wrong("WRONG_ACTOR", `create_and_fund requires buyer or system, got ${actor}`);
      }
      // No prior status check needed — API ensures this is called only once.
      return ok("Funded");

    case "mark_shipped":
      if (status !== "Funded") return wrongState(status, action);
      if (actor !== "seller") return wrong("WRONG_ACTOR", `mark_shipped requires seller, got ${actor}`);
      if (now > shipBy) return wrong("WINDOW_CLOSED", "ship_by deadline has passed");
      return ok("Shipped");

    case "confirm_delivery":
      if (status !== "Shipped") return wrongState(status, action);
      if (actor !== "buyer") return wrong("WRONG_ACTOR", `confirm_delivery requires buyer, got ${actor}`);
      return ok("Released");

    case "claim_auto_release":
      // Permissionless — any actor allowed.
      if (status !== "Shipped") return wrongState(status, action);
      if (!reviewEnds) return wrong("WRONG_STATE", "reviewEnds not set");
      if (now <= reviewEnds) return wrong("WINDOW_OPEN", "review window has not closed yet");
      return ok("Released");

    case "claim_refund":
      // Permissionless — any actor allowed.
      if (status !== "Funded") return wrongState(status, action);
      if (now <= shipBy) return wrong("DEADLINE_NOT_PASSED", "ship_by deadline has not passed yet");
      return ok("Refunded");

    case "open_dispute":
      if (status !== "Shipped") return wrongState(status, action);
      if (actor !== "buyer") return wrong("WRONG_ACTOR", `open_dispute requires buyer, got ${actor}`);
      if (!reviewEnds) return wrong("WRONG_STATE", "reviewEnds not set");
      if (now > reviewEnds) return wrong("WINDOW_CLOSED", "review window has closed; cannot dispute");
      return ok("Disputed");

    case "resolve_dispute":
      if (status !== "Disputed") return wrongState(status, action);
      if (actor !== "arbiter") return wrong("WRONG_ACTOR", `resolve_dispute requires arbiter, got ${actor}`);
      return ok("Resolved");
  }
}

function ok(nextStatus: OrderStatus): TransitionResult {
  return { ok: true, nextStatus };
}

function wrong(
  code: TransitionError["code"],
  message: string,
): TransitionResult {
  return { ok: false, error: { code, message } as TransitionError };
}

function wrongState(status: OrderStatus, action: OrderAction): TransitionResult {
  return wrong(
    "WRONG_STATE",
    `Action '${action}' is not valid in state '${status}'`,
  );
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

import { z } from "zod";

// Reusable primitives
const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, "Must be E.164 format, e.g. +2348012345678");

const slug = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric and hyphens");

/** Positive bigint encoded as a decimal string in JSON (no floats). */
const moneyString = z
  .string()
  .regex(/^\d+$/, "Money must be a non-negative integer string")
  .transform((v) => BigInt(v));

const kycTier = z.number().int().min(0).max(3);

// ── Auth ──────────────────────────────────────────────────────────────────────

export const OtpRequestSchema = z.object({
  phone: phone,
});
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  phone: phone,
  code: z.string().length(6).regex(/^\d+$/),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const AuthTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;

// ── Sellers ───────────────────────────────────────────────────────────────────

export const CreateSellerSchema = z.object({
  handle: slug,
  business_name: z.string().min(1).max(120),
});
export type CreateSeller = z.infer<typeof CreateSellerSchema>;

export const SellerResponseSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  kyc_tier: kycTier,
  created_at: z.string(),
});
export type SellerResponse = z.infer<typeof SellerResponseSchema>;

export const SetPayoutAccountSchema = z.object({
  account_number: z.string().min(10).max(20),
  bank_code: z.string().min(3).max(10),
});
export type SetPayoutAccount = z.infer<typeof SetPayoutAccountSchema>;

export const ReputationResponseSchema = z.object({
  handle: z.string(),
  kyc_tier: kycTier,
  completed_orders: z.number().int(),
  dispute_rate: z.number().nullable(),
  median_ship_hours: z.number().nullable(),
  sample_size: z.number().int(),
});
export type ReputationResponse = z.infer<typeof ReputationResponseSchema>;

// ── Payment links ─────────────────────────────────────────────────────────────

export const CreateLinkSchema = z.object({
  title: z.string().min(1).max(200),
  amount_minor: moneyString,
  currency: z.string().length(3),
  ship_by_hours: z.number().int().min(1).max(720),
  review_hours: z.number().int().min(1).max(168),
  expires_at: z.string().datetime().optional(),
});
export type CreateLink = z.infer<typeof CreateLinkSchema>;

export const LinkResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  amount_minor: z.string(), // bigint serialised as string
  currency: z.string(),
  ship_by_hours: z.number(),
  review_hours: z.number(),
  expires_at: z.string().nullable(),
  seller: z.object({ handle: z.string(), kyc_tier: kycTier }),
});
export type LinkResponse = z.infer<typeof LinkResponseSchema>;

// ── Orders ────────────────────────────────────────────────────────────────────

export const CreateOrderSchema = z.object({
  buyer_phone: phone,
});
export type CreateOrder = z.infer<typeof CreateOrderSchema>;

export const OrderResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "Funded",
    "Shipped",
    "Released",
    "Refunded",
    "Disputed",
    "Resolved",
  ]),
  amount_minor: z.string(),
  currency: z.string(),
  ship_by: z.string(),
  shipped_at: z.string().nullable(),
  review_ends: z.string().nullable(),
  created_at: z.string(),
});
export type OrderResponse = z.infer<typeof OrderResponseSchema>;

export const ShipOrderSchema = z.object({
  waybill: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});
export type ShipOrder = z.infer<typeof ShipOrderSchema>;

export const OpenDisputeSchema = z.object({
  reason: z.enum([
    "not_received",
    "not_as_described",
    "damaged",
    "other",
  ]),
  note: z.string().max(1000).optional(),
});
export type OpenDispute = z.infer<typeof OpenDisputeSchema>;

export const UploadEvidenceMetaSchema = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(100),
  sha256: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]+$/),
  size_bytes: z.number().int().positive(),
});
export type UploadEvidenceMeta = z.infer<typeof UploadEvidenceMetaSchema>;

// ── Seller tier limits (configurable) ─────────────────────────────────────────

export interface TierLimits {
  /** Maximum amount per single order in minor units. 0 = cannot receive payments. */
  max_order_minor: bigint;
  /** Maximum daily payout in minor units. */
  max_daily_payout_minor: bigint;
  /** Hours to hold a payout before releasing to the partner. */
  payout_hold_hours: number;
}

/**
 * Per-tier limits matching README "Seller tiers (illustrative, configurable)".
 * These are defaults; override via environment config in production.
 */
export const DEFAULT_TIER_LIMITS: Record<number, TierLimits> = {
  0: {
    max_order_minor: 0n,         // Tier 0 cannot receive payments
    max_daily_payout_minor: 0n,
    payout_hold_hours: 0,
  },
  1: {
    max_order_minor: 5_000_000n,   // ₦50,000
    max_daily_payout_minor: 20_000_000n, // ₦200,000
    payout_hold_hours: 72,
  },
  2: {
    max_order_minor: 50_000_000n,  // ₦500,000
    max_daily_payout_minor: 200_000_000n,
    payout_hold_hours: 24,
  },
  3: {
    max_order_minor: 500_000_000n, // ₦5,000,000
    max_daily_payout_minor: 2_000_000_000n,
    payout_hold_hours: 0,
  },
};

export function getTierLimits(tier: number): TierLimits {
  return DEFAULT_TIER_LIMITS[tier] ?? DEFAULT_TIER_LIMITS[0]!;
}
