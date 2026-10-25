//! types.rs — on-chain data types for the Holdfast escrow contract.
//!
//! These types mirror the README specification exactly.
//! Do not add states or fields without updating the README and docs/architecture.md.

use soroban_sdk::{contracttype, Address};

// ── Order status ──────────────────────────────────────────────────────────────

/// The six possible states of an escrow order.
///
/// Terminal states — Released, Refunded, Resolved — are final.
/// No function may transition an order out of a terminal state.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Funded,
    Shipped,
    Released,
    Refunded,
    Disputed,
    Resolved,
}

impl Status {
    /// Returns true if the status is terminal (no further transitions allowed).
    pub fn is_terminal(self) -> bool {
        matches!(self, Status::Released | Status::Refunded | Status::Resolved)
    }
}

// ── Order ─────────────────────────────────────────────────────────────────────

/// A single escrow order.
///
/// All monetary values are in the token's smallest unit (i128).
/// Timestamps are Unix seconds (u64), matching Soroban ledger timestamps.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Order {
    /// The buyer's Stellar address.
    pub buyer: Address,
    /// The seller's Stellar address.
    pub seller: Address,
    /// The SEP-41 token contract address (e.g. USDC). Used in Mode B only;
    /// in Mode A this field is present but transfers are off-chain.
    pub token: Address,
    /// Funded amount in the token's smallest unit. Must be > 0.
    pub amount: i128,
    /// Unix timestamp (seconds) by which the seller must call mark_shipped,
    /// or the buyer may claim a full refund.
    pub ship_by: u64,
    /// Duration in seconds of the buyer's review window after shipping.
    /// After this window, anyone may call claim_auto_release.
    pub review_secs: u64,
    /// Unix timestamp (seconds) when mark_shipped was called. 0 until shipped.
    pub shipped_at: u64,
    /// Current order status.
    pub status: Status,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

/// Keys for all persistent contract storage.
#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    /// Individual order, keyed by its sequential u64 ID.
    Order(u64),
    /// Monotonically increasing counter; next order ID = Counter + 1.
    Counter,
    /// Arbiter address (multisig). May call resolve_dispute.
    Arbiter,
    /// Admin address (multisig). May call admin functions and pause/unpause.
    Admin,
    /// Treasury address. Receives the platform fee on each payout.
    Treasury,
    /// Platform fee in basis points (0–500). Applied to seller payouts only.
    FeeBps,
    /// When true, create_and_fund is rejected. Settlement paths are unaffected.
    Paused,
    /// Maximum allowed amount per order in the token's smallest unit.
    MaxOrderAmount,
}
