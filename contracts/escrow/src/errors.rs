//! errors.rs — contract error codes for the Holdfast escrow contract.
//!
//! Every error has a distinct numeric code so callers can match on it programmatically.
//! Keep codes stable — changing a code is a breaking change for clients.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    /// Order ID does not exist.
    NotFound = 1,
    /// The order is not in the required state for this operation.
    WrongState = 2,
    /// The caller is not authorised to perform this action.
    Unauthorized = 3,
    /// The contract is paused; new orders are not accepted.
    Paused = 4,
    /// The amount is zero or otherwise invalid (e.g. negative).
    AmountInvalid = 5,
    /// The ship_by timestamp is in the past or otherwise invalid.
    DeadlineInvalid = 6,
    /// The order amount exceeds the configured per-order cap.
    CapExceeded = 7,
    /// The action cannot be performed yet (time condition not met).
    WindowClosed = 8,
    /// The review window is still open; the action requires it to have ended.
    WindowOpen = 9,
    /// buyer_share + seller_share does not equal order.amount in resolve_dispute.
    SharesMismatch = 10,
    /// The requested fee_bps exceeds the hard-coded maximum (500 = 5%).
    FeeTooHigh = 11,
    /// The contract has already been initialised.
    AlreadyInitialized = 12,
    /// The review_secs value is outside the allowed bounds.
    ReviewSecsInvalid = 13,
}
