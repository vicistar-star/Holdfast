/**
 * @holdfast/shared
 *
 * Shared types, money helpers, and validation used across all packages.
 * Money is always stored and transmitted as integers in minor units (e.g. kobo for NGN).
 * No floats are ever used for monetary values.
 */

// ── Order status ──────────────────────────────────────────────────────────────

/**
 * The six possible states of an escrow order, mirroring the on-chain Status enum.
 * Terminal states: Released, Refunded, Resolved — no transitions out of these.
 */
export type OrderStatus =
  | "Funded"
  | "Shipped"
  | "Released"
  | "Refunded"
  | "Disputed"
  | "Resolved";

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "Released",
  "Refunded",
  "Resolved",
]);

// ── Money helpers ─────────────────────────────────────────────────────────────

/**
 * Compute the platform fee for a payout amount.
 * Fee rounds DOWN (integer division). The remainder stays with the payee.
 * This matches the contract's rounding rule — do not change without updating both.
 *
 * @param amount  - Amount in minor units (must be a non-negative integer)
 * @param feeBps  - Fee in basis points (e.g. 100 = 1%). Must be 0–500.
 * @returns fee in minor units (rounded down)
 */
export function computeFee(amount: bigint, feeBps: bigint): bigint {
  if (feeBps < 0n || feeBps > 500n) {
    throw new RangeError(`feeBps must be 0–500, got ${feeBps}`);
  }
  // Division truncates toward zero in both JS BigInt and Rust i128, so rounding is consistent.
  return (amount * feeBps) / 10_000n;
}

/**
 * Assert that payouts sum exactly to the funded amount (conservation invariant).
 * Throws if violated — call this in tests and reconciliation jobs.
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

// ── Escrow mode ───────────────────────────────────────────────────────────────

/**
 * Mode A: local-currency rails; licensed partner holds funds; contract is state+reputation only.
 * Mode B: on-chain USDC escrow via Soroban contract (testnet only until audited).
 */
export type EscrowMode = "A" | "B";

export function parseEscrowMode(raw: string | undefined): EscrowMode {
  if (raw === "B") return "B";
  return "A"; // default to Mode A
}
