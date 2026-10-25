//! events.rs — on-chain event types for the Holdfast escrow contract.
//!
//! Uses the #[contractevent] macro (soroban-sdk v27+).
//! Every order state transition emits exactly one event via `.publish(&env)`.
//! The indexer consumes these to build seller reputation and mirror state into Postgres.
//!
//! All payloads exactly match the README specification.

use soroban_sdk::{contractevent, Address, Env, Symbol};

// ── Event types ───────────────────────────────────────────────────────────────

/// Emitted by create_and_fund.
#[contractevent(topics = ["order", "funded"])]
pub struct FundedEvent {
    pub id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub token: Address,
    pub amount: i128,
    pub ship_by: u64,
}

/// Emitted by mark_shipped.
#[contractevent(topics = ["order", "shipped"])]
pub struct ShippedEvent {
    pub id: u64,
    pub shipped_at: u64,
}

/// Emitted by confirm_delivery and claim_auto_release.
/// `how` is "confirmed" or "auto".
#[contractevent(topics = ["order", "released"])]
pub struct ReleasedEvent {
    pub id: u64,
    pub to_seller: i128,
    pub fee: i128,
    pub how: Symbol,
}

/// Emitted by claim_refund.
#[contractevent(topics = ["order", "refunded"])]
pub struct RefundedEvent {
    pub id: u64,
    pub amount: i128,
}

/// Emitted by open_dispute.
#[contractevent(topics = ["order", "disputed"])]
pub struct DisputedEvent {
    pub id: u64,
    pub opened_at: u64,
}

/// Emitted by resolve_dispute.
#[contractevent(topics = ["order", "resolved"])]
pub struct ResolvedEvent {
    pub id: u64,
    pub buyer_share: i128,
    pub seller_share: i128,
    pub fee: i128,
}

// ── How a release was triggered ───────────────────────────────────────────────

pub enum ReleaseHow {
    Confirmed,
    Auto,
}

// ── Publisher functions ───────────────────────────────────────────────────────

pub fn funded(
    env: &Env,
    id: u64,
    buyer: &Address,
    seller: &Address,
    token: &Address,
    amount: i128,
    ship_by: u64,
) {
    FundedEvent {
        id,
        buyer: buyer.clone(),
        seller: seller.clone(),
        token: token.clone(),
        amount,
        ship_by,
    }
    .publish(env);
}

pub fn shipped(env: &Env, id: u64, shipped_at: u64) {
    ShippedEvent { id, shipped_at }.publish(env);
}

pub fn released(env: &Env, id: u64, to_seller: i128, fee: i128, how: ReleaseHow) {
    let how_sym = match how {
        ReleaseHow::Confirmed => Symbol::new(env, "confirmed"),
        ReleaseHow::Auto => Symbol::new(env, "auto"),
    };
    ReleasedEvent {
        id,
        to_seller,
        fee,
        how: how_sym,
    }
    .publish(env);
}

pub fn refunded(env: &Env, id: u64, amount: i128) {
    RefundedEvent { id, amount }.publish(env);
}

pub fn disputed(env: &Env, id: u64, opened_at: u64) {
    DisputedEvent { id, opened_at }.publish(env);
}

pub fn resolved(env: &Env, id: u64, buyer_share: i128, seller_share: i128, fee: i128) {
    ResolvedEvent {
        id,
        buyer_share,
        seller_share,
        fee,
    }
    .publish(env);
}
