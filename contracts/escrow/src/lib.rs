//! lib.rs — Holdfast escrow contract.
//!
//! Implements the full order lifecycle as specified in the README:
//!   create_and_fund → mark_shipped → confirm_delivery | claim_auto_release
//!                                  → open_dispute → resolve_dispute
//!   create_and_fund → claim_refund  (if seller misses ship_by)
//!
//! INVARIANTS (must never be weakened):
//!   1. State is written before any token transfer in every function.
//!   2. For every terminal state, payouts sum exactly to order.amount.
//!   3. Fee rounds down (floor division). fee = amount * fee_bps / 10_000.
//!   4. Fee cap: fee_bps ≤ MAX_FEE_BPS (500 = 5%).
//!   5. Fees on payouts only; refunds are always fee-free.
//!   6. pause() blocks create_and_fund only; all settlement paths stay open.
//!   7. Terminal states (Released, Refunded, Resolved) are final.
//!   8. Every order write extends TTL to at least MAX_ORDER_LIFETIME_LEDGERS.
//!   9. Authorization uses require_auth() on the stored address, never the caller.

#![no_std]

mod errors;
mod events;
mod types;

#[cfg(test)]
mod test;

pub use errors::Error;
pub use types::{DataKey, Order, Status};

use soroban_sdk::{contract, contractimpl, token, Address, Env};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Hard cap on fee_bps. 500 = 5%. Never raise without a governance decision.
pub const MAX_FEE_BPS: i128 = 500;

/// Minimum review window: 1 hour.
pub const MIN_REVIEW_SECS: u64 = 3_600;

/// Maximum review window: 30 days.
pub const MAX_REVIEW_SECS: u64 = 30 * 24 * 3_600;

/// Storage TTL extension applied on every order write, in ledgers.
/// 5 seconds per ledger × 86_400 seconds/day × 400 days > any possible order lifetime.
/// 400 days at ~5s/ledger ≈ 6_912_000 ledgers. We use a round number above that.
pub const ORDER_TTL_LEDGERS: u32 = 7_000_000;

// ── TTL helper ────────────────────────────────────────────────────────────────

/// Extend the persistent storage TTL for an order key.
///
/// Called on every write to an Order entry so archival can never strand funds.
/// `threshold` is the minimum remaining TTL before an extension is applied.
/// We set both to ORDER_TTL_LEDGERS so the entry is always extended to the full window.
fn extend_order_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, ORDER_TTL_LEDGERS, ORDER_TTL_LEDGERS);
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    // ── Initialisation ────────────────────────────────────────────────────────

    /// Initialise the contract. Must be called once, immediately after deployment.
    ///
    /// Sets the admin, arbiter, treasury, initial fee, and per-order cap.
    /// Subsequent calls are rejected with AlreadyInitialized.
    pub fn initialize(
        env: Env,
        admin: Address,
        arbiter: Address,
        treasury: Address,
        fee_bps: i128,
        max_order_amount: i128,
    ) -> Result<(), Error> {
        // Reject re-initialisation.
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }

        if !(0..=MAX_FEE_BPS).contains(&fee_bps) {
            return Err(Error::FeeTooHigh);
        }

        if max_order_amount <= 0 {
            return Err(Error::AmountInvalid);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Arbiter, &arbiter);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage()
            .instance()
            .set(&DataKey::MaxOrderAmount, &max_order_amount);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::Counter, &0u64);

        Ok(())
    }

    // ── Order lifecycle ───────────────────────────────────────────────────────

    /// Create an escrow order and fund it in a single call.
    ///
    /// Transfers `amount` tokens from `buyer` into the contract.
    /// Returns the new order ID.
    ///
    /// Preconditions:
    ///   - contract is not paused
    ///   - amount > 0
    ///   - amount ≤ max_order_amount
    ///   - ship_by > now
    ///   - review_secs within [MIN_REVIEW_SECS, MAX_REVIEW_SECS]
    pub fn create_and_fund(
        env: Env,
        buyer: Address,
        seller: Address,
        token: Address,
        amount: i128,
        ship_by: u64,
        review_secs: u64,
    ) -> Result<u64, Error> {
        // Check pause first so the error is clear.
        let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        if paused {
            return Err(Error::Paused);
        }

        // Validate inputs.
        if amount <= 0 {
            return Err(Error::AmountInvalid);
        }

        let max_order_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxOrderAmount)
            .unwrap_or(i128::MAX);
        if amount > max_order_amount {
            return Err(Error::CapExceeded);
        }

        let now = env.ledger().timestamp();
        if ship_by <= now {
            return Err(Error::DeadlineInvalid);
        }

        if !(MIN_REVIEW_SECS..=MAX_REVIEW_SECS).contains(&review_secs) {
            return Err(Error::ReviewSecsInvalid);
        }

        // Require buyer authorisation.
        buyer.require_auth();

        // Allocate order ID.
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Counter)
            .unwrap_or(0u64);
        let next_id = id + 1;
        env.storage().instance().set(&DataKey::Counter, &next_id);

        // Build and persist the order BEFORE any token transfer (state before effects).
        let order = Order {
            buyer: buyer.clone(),
            seller: seller.clone(),
            token: token.clone(),
            amount,
            ship_by,
            review_secs,
            shipped_at: 0,
            status: Status::Funded,
        };
        let key = DataKey::Order(next_id);
        env.storage().persistent().set(&key, &order);
        extend_order_ttl(&env, &key);

        // Transfer funds from buyer to contract.
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, env.current_contract_address(), &amount);

        // Emit event.
        events::funded(&env, next_id, &buyer, &seller, &token, amount, ship_by);

        Ok(next_id)
    }

    /// Mark an order as shipped.
    ///
    /// Caller must be the seller stored on the order.
    /// Order must be Funded and now ≤ ship_by.
    pub fn mark_shipped(env: Env, id: u64) -> Result<(), Error> {
        let key = DataKey::Order(id);
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if order.status != Status::Funded {
            return Err(Error::WrongState);
        }

        let now = env.ledger().timestamp();
        if now > order.ship_by {
            // ship_by has passed; only claim_refund is valid now.
            return Err(Error::WindowClosed);
        }

        // Require the stored seller's authorisation.
        order.seller.require_auth();

        // Update state before any effects.
        order.status = Status::Shipped;
        order.shipped_at = now;
        env.storage().persistent().set(&key, &order);
        extend_order_ttl(&env, &key);

        events::shipped(&env, id, now);

        Ok(())
    }

    /// Confirm delivery of the order.
    ///
    /// Caller must be the buyer stored on the order.
    /// Order must be in Shipped state.
    /// Pays seller (amount - fee) and fee to treasury.
    pub fn confirm_delivery(env: Env, id: u64) -> Result<(), Error> {
        let key = DataKey::Order(id);
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if order.status != Status::Shipped {
            return Err(Error::WrongState);
        }

        // Require the stored buyer's authorisation.
        order.buyer.require_auth();

        let (to_seller, fee) = compute_payout(&env, order.amount);

        // Update state before transfers.
        order.status = Status::Released;
        env.storage().persistent().set(&key, &order);
        extend_order_ttl(&env, &key);

        // Execute transfers.
        pay_out(&env, &order.token, &order.seller, to_seller, fee);

        events::released(&env, id, to_seller, fee, events::ReleaseHow::Confirmed);

        Ok(())
    }

    /// Auto-release funds to the seller after the review window has closed.
    ///
    /// Permissionless: any address may call this once conditions are met.
    /// Order must be Shipped, now > shipped_at + review_secs, and not disputed.
    pub fn claim_auto_release(env: Env, id: u64) -> Result<(), Error> {
        let key = DataKey::Order(id);
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if order.status != Status::Shipped {
            return Err(Error::WrongState);
        }

        let now = env.ledger().timestamp();
        let review_ends = order.shipped_at.saturating_add(order.review_secs);
        if now <= review_ends {
            return Err(Error::WindowOpen);
        }

        let (to_seller, fee) = compute_payout(&env, order.amount);

        // Update state before transfers.
        order.status = Status::Released;
        env.storage().persistent().set(&key, &order);
        extend_order_ttl(&env, &key);

        pay_out(&env, &order.token, &order.seller, to_seller, fee);

        events::released(&env, id, to_seller, fee, events::ReleaseHow::Auto);

        Ok(())
    }

    /// Claim a full refund when the seller has missed the ship_by deadline.
    ///
    /// Permissionless: any address may call this once conditions are met.
    /// Order must be Funded, now > ship_by. No fee is charged.
    pub fn claim_refund(env: Env, id: u64) -> Result<(), Error> {
        let key = DataKey::Order(id);
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if order.status != Status::Funded {
            return Err(Error::WrongState);
        }

        let now = env.ledger().timestamp();
        if now <= order.ship_by {
            // ship_by hasn't passed yet.
            return Err(Error::WindowOpen);
        }

        // Update state before transfer (refund is fee-free).
        order.status = Status::Refunded;
        env.storage().persistent().set(&key, &order);
        extend_order_ttl(&env, &key);

        let token_client = token::Client::new(&env, &order.token);
        token_client.transfer(&env.current_contract_address(), &order.buyer, &order.amount);

        events::refunded(&env, id, order.amount);

        Ok(())
    }

    /// Open a dispute during the review window.
    ///
    /// Caller must be the buyer stored on the order.
    /// Order must be Shipped, now ≤ shipped_at + review_secs.
    /// Freezes funds on-chain until the arbiter resolves.
    pub fn open_dispute(env: Env, id: u64) -> Result<(), Error> {
        let key = DataKey::Order(id);
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if order.status != Status::Shipped {
            return Err(Error::WrongState);
        }

        let now = env.ledger().timestamp();
        let review_ends = order.shipped_at.saturating_add(order.review_secs);
        if now > review_ends {
            // Review window has closed; buyer should have confirmed or let it auto-release.
            return Err(Error::WindowClosed);
        }

        order.buyer.require_auth();

        // Update state before any effects.
        order.status = Status::Disputed;
        env.storage().persistent().set(&key, &order);
        extend_order_ttl(&env, &key);

        events::disputed(&env, id, now);

        Ok(())
    }

    /// Resolve a dispute as the arbiter.
    ///
    /// Caller must be the contract-level arbiter address.
    /// Order must be Disputed.
    /// buyer_share + seller_share must equal order.amount exactly (conservation).
    /// Fee is charged on seller_share only. Refunds (buyer_share) are fee-free.
    pub fn resolve_dispute(
        env: Env,
        id: u64,
        buyer_share: i128,
        seller_share: i128,
    ) -> Result<(), Error> {
        let key = DataKey::Order(id);
        let mut order: Order = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if order.status != Status::Disputed {
            return Err(Error::WrongState);
        }

        // Shares must sum exactly to the funded amount.
        if buyer_share + seller_share != order.amount {
            return Err(Error::SharesMismatch);
        }

        // Both shares must be non-negative.
        if buyer_share < 0 || seller_share < 0 {
            return Err(Error::AmountInvalid);
        }

        // Require arbiter authorisation using the stored address.
        let arbiter: Address = env.storage().instance().get(&DataKey::Arbiter).unwrap();
        arbiter.require_auth();

        // Fee is charged on the seller share only (fee-free for the buyer's portion).
        let fee_bps: i128 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let fee = (seller_share * fee_bps) / 10_000;
        let net_seller = seller_share - fee;

        // Update state before transfers.
        order.status = Status::Resolved;
        env.storage().persistent().set(&key, &order);
        extend_order_ttl(&env, &key);

        // Execute transfers.
        let token_client = token::Client::new(&env, &order.token);

        if buyer_share > 0 {
            token_client.transfer(&env.current_contract_address(), &order.buyer, &buyer_share);
        }
        if net_seller > 0 {
            token_client.transfer(&env.current_contract_address(), &order.seller, &net_seller);
        }
        if fee > 0 {
            let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
            token_client.transfer(&env.current_contract_address(), &treasury, &fee);
        }

        events::resolved(&env, id, buyer_share, net_seller, fee);

        Ok(())
    }

    // ── Read functions ────────────────────────────────────────────────────────

    /// Return the order for a given ID, or an error if not found.
    pub fn get_order(env: Env, id: u64) -> Result<Order, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Order(id))
            .ok_or(Error::NotFound)
    }

    // ── Admin functions ───────────────────────────────────────────────────────

    /// Update the platform fee. Rejects values above MAX_FEE_BPS.
    pub fn set_fee_bps(env: Env, fee_bps: i128) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if !(0..=MAX_FEE_BPS).contains(&fee_bps) {
            return Err(Error::FeeTooHigh);
        }

        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        Ok(())
    }

    /// Update the treasury address.
    pub fn set_treasury(env: Env, treasury: Address) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        env.storage().instance().set(&DataKey::Treasury, &treasury);
        Ok(())
    }

    /// Pause the contract. Blocks create_and_fund; settlement paths stay open.
    pub fn pause(env: Env) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    /// Unpause the contract.
    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Compute the seller payout and fee for a given amount.
///
/// Fee rounds DOWN (floor division / integer truncation).
/// This matches Rust i128 division semantics and the TypeScript BigInt division rule.
/// The rounding rule is documented in docs/decisions.md.
///
/// Conservation: to_seller + fee == amount always.
fn compute_payout(env: &Env, amount: i128) -> (i128, i128) {
    let fee_bps: i128 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
    let fee = (amount * fee_bps) / 10_000;
    let to_seller = amount - fee;
    (to_seller, fee)
}

/// Transfer `to_seller` to the seller and `fee` to the treasury.
/// No-ops for zero amounts so we avoid zero-value token transfers.
fn pay_out(env: &Env, token: &Address, seller: &Address, to_seller: i128, fee: i128) {
    let token_client = token::Client::new(env, token);
    let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();

    if to_seller > 0 {
        token_client.transfer(&env.current_contract_address(), seller, &to_seller);
    }
    if fee > 0 {
        token_client.transfer(&env.current_contract_address(), &treasury, &fee);
    }
}
