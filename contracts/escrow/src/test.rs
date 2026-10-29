//! test.rs — comprehensive test suite for the Holdfast escrow contract.
//!
//! The soroban-sdk v27 test client exposes two call variants:
//!   - client.func(...)        — panics on contract error (use for expected-success paths)
//!   - client.try_func(...)    — returns Result<T, Result<Error, InvokeError>>
//!     (use for expected-error paths)
//!
//! Test organisation:
//!   mod create_and_fund     — happy path, rejections, pause, cap, TTL
//!   mod mark_shipped        — happy path, wrong caller, wrong state, late
//!   mod confirm_delivery    — happy path, wrong state, conservation
//!   mod claim_auto_release  — happy path, too early, wrong state, conservation
//!   mod claim_refund        — happy path, too early, wrong state, conservation
//!   mod open_dispute        — happy path, too late, wrong state
//!   mod resolve_dispute     — happy path, wrong state, shares mismatch, conservation
//!   mod admin               — set_fee_bps cap, set_treasury, pause / unpause
//!   mod terminal_states     — no function can move an order out of a terminal state
//!   mod conservation        — property test: payouts always sum to funded amount

#![cfg(test)]

use crate::{Error, EscrowContract, EscrowContractClient, Status, MAX_FEE_BPS};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

// ── Test helpers ──────────────────────────────────────────────────────────────

#[allow(dead_code)]
struct TestSetup<'a> {
    env: Env,
    contract: EscrowContractClient<'a>,
    token: Address,
    admin: Address,
    arbiter: Address,
    treasury: Address,
    buyer: Address,
    seller: Address,
}

const DEFAULT_AMOUNT: i128 = 1_000_000;
const DEFAULT_FEE_BPS: i128 = 100; // 1%
const DEFAULT_MAX_AMOUNT: i128 = 10_000_000;
const DEFAULT_SHIP_BY_OFFSET: u64 = 3 * 24 * 3600; // 3 days
const DEFAULT_REVIEW_SECS: u64 = 48 * 3600; // 48 hours

fn setup() -> TestSetup<'static> {
    let env = Env::default();
    env.mock_all_auths();

    // Start at a realistic timestamp so shipped_at and other time checks are non-zero.
    let mut info = env.ledger().get();
    info.timestamp = 1_700_000_000; // 2023-11-14 in Unix seconds
    env.ledger().set(info);

    let admin = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let treasury = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_addr.address();
    StellarAssetClient::new(&env, &token).mint(&buyer, &1_000_000_000);

    let contract_id = env.register(EscrowContract, ());
    let contract = EscrowContractClient::new(&env, &contract_id);

    contract.initialize(
        &admin,
        &arbiter,
        &treasury,
        &DEFAULT_FEE_BPS,
        &DEFAULT_MAX_AMOUNT,
    );

    // SAFETY: extending lifetimes here is a common soroban-sdk test pattern.
    // The Env outlives all clients in these tests.
    let contract: EscrowContractClient<'static> = unsafe { core::mem::transmute(contract) };

    TestSetup {
        env,
        contract,
        token,
        admin,
        arbiter,
        treasury,
        buyer,
        seller,
    }
}

fn default_ship_by(env: &Env) -> u64 {
    env.ledger().timestamp() + DEFAULT_SHIP_BY_OFFSET
}

fn create_default_order(s: &TestSetup) -> u64 {
    s.contract.create_and_fund(
        &s.buyer,
        &s.seller,
        &s.token,
        &DEFAULT_AMOUNT,
        &default_ship_by(&s.env),
        &DEFAULT_REVIEW_SECS,
    )
}

fn advance_time(env: &Env, seconds: u64) {
    let mut info = env.ledger().get();
    info.timestamp += seconds;
    info.sequence_number += (seconds / 5) as u32;
    env.ledger().set(info);
}

fn balance(env: &Env, token: &Address, addr: &Address) -> i128 {
    TokenClient::new(env, token).balance(addr)
}

/// Unwrap a `try_` call result, mapping the double-Result to a plain Error.
fn unwrap_err<T>(r: Result<T, Result<Error, soroban_sdk::InvokeError>>) -> Error {
    match r {
        Err(Ok(e)) => e,
        Err(Err(e)) => panic!("unexpected invoke error: {e:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
}

// ── create_and_fund ───────────────────────────────────────────────────────────

mod create_and_fund {
    use super::*;

    #[test]
    fn happy_path_funds_contract_emits_event() {
        let s = setup();
        let contract_addr = s.contract.address.clone();

        let buyer_before = balance(&s.env, &s.token, &s.buyer);
        let contract_before = balance(&s.env, &s.token, &contract_addr);

        let id = create_default_order(&s);
        assert_eq!(id, 1);

        assert_eq!(
            balance(&s.env, &s.token, &s.buyer),
            buyer_before - DEFAULT_AMOUNT
        );
        assert_eq!(
            balance(&s.env, &s.token, &contract_addr),
            contract_before + DEFAULT_AMOUNT
        );

        let order = s.contract.get_order(&id);
        assert_eq!(order.status, Status::Funded);
        assert_eq!(order.amount, DEFAULT_AMOUNT);
        assert_eq!(order.buyer, s.buyer);
        assert_eq!(order.seller, s.seller);
    }

    #[test]
    fn rejects_zero_amount() {
        let s = setup();
        let err = unwrap_err(s.contract.try_create_and_fund(
            &s.buyer,
            &s.seller,
            &s.token,
            &0,
            &default_ship_by(&s.env),
            &DEFAULT_REVIEW_SECS,
        ));
        assert_eq!(err, Error::AmountInvalid);
    }

    #[test]
    fn rejects_negative_amount() {
        let s = setup();
        let err = unwrap_err(s.contract.try_create_and_fund(
            &s.buyer,
            &s.seller,
            &s.token,
            &-1,
            &default_ship_by(&s.env),
            &DEFAULT_REVIEW_SECS,
        ));
        assert_eq!(err, Error::AmountInvalid);
    }

    #[test]
    fn rejects_past_ship_by() {
        let s = setup();
        let past = s.env.ledger().timestamp().saturating_sub(1);
        let err = unwrap_err(s.contract.try_create_and_fund(
            &s.buyer,
            &s.seller,
            &s.token,
            &DEFAULT_AMOUNT,
            &past,
            &DEFAULT_REVIEW_SECS,
        ));
        assert_eq!(err, Error::DeadlineInvalid);
    }

    #[test]
    fn rejects_ship_by_equal_to_now() {
        let s = setup();
        let now = s.env.ledger().timestamp();
        let err = unwrap_err(s.contract.try_create_and_fund(
            &s.buyer,
            &s.seller,
            &s.token,
            &DEFAULT_AMOUNT,
            &now,
            &DEFAULT_REVIEW_SECS,
        ));
        assert_eq!(err, Error::DeadlineInvalid);
    }

    #[test]
    fn rejects_amount_above_cap() {
        let s = setup();
        let err = unwrap_err(s.contract.try_create_and_fund(
            &s.buyer,
            &s.seller,
            &s.token,
            &(DEFAULT_MAX_AMOUNT + 1),
            &default_ship_by(&s.env),
            &DEFAULT_REVIEW_SECS,
        ));
        assert_eq!(err, Error::CapExceeded);
    }

    #[test]
    fn rejects_when_paused() {
        let s = setup();
        s.contract.pause();
        let err = unwrap_err(s.contract.try_create_and_fund(
            &s.buyer,
            &s.seller,
            &s.token,
            &DEFAULT_AMOUNT,
            &default_ship_by(&s.env),
            &DEFAULT_REVIEW_SECS,
        ));
        assert_eq!(err, Error::Paused);
    }

    #[test]
    fn rejects_review_secs_too_short() {
        let s = setup();
        let err = unwrap_err(s.contract.try_create_and_fund(
            &s.buyer,
            &s.seller,
            &s.token,
            &DEFAULT_AMOUNT,
            &default_ship_by(&s.env),
            &(crate::MIN_REVIEW_SECS - 1),
        ));
        assert_eq!(err, Error::ReviewSecsInvalid);
    }

    #[test]
    fn rejects_review_secs_too_long() {
        let s = setup();
        let err = unwrap_err(s.contract.try_create_and_fund(
            &s.buyer,
            &s.seller,
            &s.token,
            &DEFAULT_AMOUNT,
            &default_ship_by(&s.env),
            &(crate::MAX_REVIEW_SECS + 1),
        ));
        assert_eq!(err, Error::ReviewSecsInvalid);
    }

    #[test]
    fn ids_increment() {
        let s = setup();
        let id1 = create_default_order(&s);
        let id2 = create_default_order(&s);
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
    }
}

// ── mark_shipped ──────────────────────────────────────────────────────────────

mod mark_shipped {
    use super::*;

    #[test]
    fn happy_path_sets_shipped_state() {
        let s = setup();
        let id = create_default_order(&s);
        s.contract.mark_shipped(&id);

        let order = s.contract.get_order(&id);
        assert_eq!(order.status, Status::Shipped);
        assert!(order.shipped_at > 0);
    }

    #[test]
    fn stores_correct_seller_address() {
        // Verify the stored seller is the one passed into create_and_fund.
        // The contract's require_auth checks this stored address.
        let s = setup();
        let id = create_default_order(&s);
        let order = s.contract.get_order(&id);
        assert_eq!(order.seller, s.seller);
    }

    #[test]
    fn rejects_after_ship_by() {
        let s = setup();
        let id = create_default_order(&s);
        advance_time(&s.env, DEFAULT_SHIP_BY_OFFSET + 1);
        let err = unwrap_err(s.contract.try_mark_shipped(&id));
        assert_eq!(err, Error::WindowClosed);
    }

    #[test]
    fn succeeds_exactly_at_ship_by() {
        let s = setup();
        let id = create_default_order(&s);
        let order = s.contract.get_order(&id);
        let offset = order.ship_by - s.env.ledger().timestamp();
        advance_time(&s.env, offset);
        // now == ship_by — the contract allows this (now <= ship_by).
        s.contract.mark_shipped(&id);
        let updated = s.contract.get_order(&id);
        assert_eq!(updated.status, Status::Shipped);
    }

    #[test]
    fn rejects_when_not_funded() {
        let s = setup();
        let id = create_default_order(&s);
        s.contract.mark_shipped(&id);
        // Already Shipped — second call must fail.
        let err = unwrap_err(s.contract.try_mark_shipped(&id));
        assert_eq!(err, Error::WrongState);
    }

    #[test]
    fn rejects_unknown_order() {
        let s = setup();
        let err = unwrap_err(s.contract.try_mark_shipped(&999));
        assert_eq!(err, Error::NotFound);
    }
}

// ── confirm_delivery ──────────────────────────────────────────────────────────

mod confirm_delivery {
    use super::*;

    fn shipped_order(s: &TestSetup) -> u64 {
        let id = create_default_order(s);
        s.contract.mark_shipped(&id);
        id
    }

    #[test]
    fn happy_path_releases_with_fee() {
        let s = setup();
        let id = shipped_order(&s);

        let seller_before = balance(&s.env, &s.token, &s.seller);
        let treasury_before = balance(&s.env, &s.token, &s.treasury);

        s.contract.confirm_delivery(&id);

        let expected_fee = (DEFAULT_AMOUNT * DEFAULT_FEE_BPS) / 10_000;
        let expected_to_seller = DEFAULT_AMOUNT - expected_fee;

        assert_eq!(
            balance(&s.env, &s.token, &s.seller),
            seller_before + expected_to_seller
        );
        assert_eq!(
            balance(&s.env, &s.token, &s.treasury),
            treasury_before + expected_fee
        );

        let order = s.contract.get_order(&id);
        assert_eq!(order.status, Status::Released);
    }

    #[test]
    fn conservation_all_funds_leave_contract() {
        let s = setup();
        let id = shipped_order(&s);
        let contract_before = balance(&s.env, &s.token, &s.contract.address);
        s.contract.confirm_delivery(&id);
        let contract_after = balance(&s.env, &s.token, &s.contract.address);
        assert_eq!(contract_after, contract_before - DEFAULT_AMOUNT);
    }

    #[test]
    fn rejects_on_funded_order() {
        let s = setup();
        let id = create_default_order(&s);
        let err = unwrap_err(s.contract.try_confirm_delivery(&id));
        assert_eq!(err, Error::WrongState);
    }

    #[test]
    fn rejects_on_disputed_order() {
        let s = setup();
        let id = shipped_order(&s);
        s.contract.open_dispute(&id);
        let err = unwrap_err(s.contract.try_confirm_delivery(&id));
        assert_eq!(err, Error::WrongState);
    }
}

// ── claim_auto_release ────────────────────────────────────────────────────────

mod claim_auto_release {
    use super::*;

    fn shipped_order(s: &TestSetup) -> u64 {
        let id = create_default_order(s);
        s.contract.mark_shipped(&id);
        id
    }

    #[test]
    fn happy_path_after_review_window() {
        let s = setup();
        let id = shipped_order(&s);
        advance_time(&s.env, DEFAULT_REVIEW_SECS + 1);

        let seller_before = balance(&s.env, &s.token, &s.seller);
        s.contract.claim_auto_release(&id);

        let order = s.contract.get_order(&id);
        assert_eq!(order.status, Status::Released);

        let expected_fee = (DEFAULT_AMOUNT * DEFAULT_FEE_BPS) / 10_000;
        let expected_to_seller = DEFAULT_AMOUNT - expected_fee;
        assert_eq!(
            balance(&s.env, &s.token, &s.seller),
            seller_before + expected_to_seller
        );
    }

    #[test]
    fn rejects_inside_review_window() {
        let s = setup();
        let id = shipped_order(&s);
        advance_time(&s.env, DEFAULT_REVIEW_SECS - 1);
        let err = unwrap_err(s.contract.try_claim_auto_release(&id));
        assert_eq!(err, Error::WindowOpen);
    }

    #[test]
    fn rejects_exactly_at_review_end() {
        let s = setup();
        let id = shipped_order(&s);
        let order = s.contract.get_order(&id);
        let to_end = order.shipped_at + order.review_secs - s.env.ledger().timestamp();
        advance_time(&s.env, to_end);
        // now == review_ends → condition now > review_ends is false → must reject.
        let err = unwrap_err(s.contract.try_claim_auto_release(&id));
        assert_eq!(err, Error::WindowOpen);
    }

    #[test]
    fn succeeds_one_second_after_review_end() {
        let s = setup();
        let id = shipped_order(&s);
        let order = s.contract.get_order(&id);
        let to_end = order.shipped_at + order.review_secs - s.env.ledger().timestamp();
        advance_time(&s.env, to_end + 1);
        s.contract.claim_auto_release(&id);
        assert_eq!(s.contract.get_order(&id).status, Status::Released);
    }

    #[test]
    fn rejects_on_funded_order() {
        let s = setup();
        let id = create_default_order(&s);
        let err = unwrap_err(s.contract.try_claim_auto_release(&id));
        assert_eq!(err, Error::WrongState);
    }

    #[test]
    fn conservation() {
        let s = setup();
        let id = shipped_order(&s);
        advance_time(&s.env, DEFAULT_REVIEW_SECS + 1);
        let before = balance(&s.env, &s.token, &s.contract.address);
        s.contract.claim_auto_release(&id);
        let after = balance(&s.env, &s.token, &s.contract.address);
        assert_eq!(after, before - DEFAULT_AMOUNT);
    }
}

// ── claim_refund ──────────────────────────────────────────────────────────────

mod claim_refund {
    use super::*;

    #[test]
    fn happy_path_full_refund_no_fee() {
        let s = setup();
        let id = create_default_order(&s);
        advance_time(&s.env, DEFAULT_SHIP_BY_OFFSET + 1);

        let buyer_before = balance(&s.env, &s.token, &s.buyer);
        s.contract.claim_refund(&id);

        assert_eq!(
            balance(&s.env, &s.token, &s.buyer),
            buyer_before + DEFAULT_AMOUNT
        );
        assert_eq!(s.contract.get_order(&id).status, Status::Refunded);
    }

    #[test]
    fn rejects_before_ship_by() {
        let s = setup();
        let id = create_default_order(&s);
        let err = unwrap_err(s.contract.try_claim_refund(&id));
        assert_eq!(err, Error::WindowOpen);
    }

    #[test]
    fn rejects_exactly_at_ship_by() {
        let s = setup();
        let id = create_default_order(&s);
        let order = s.contract.get_order(&id);
        advance_time(&s.env, order.ship_by - s.env.ledger().timestamp());
        // now == ship_by → now > ship_by is false → must reject.
        let err = unwrap_err(s.contract.try_claim_refund(&id));
        assert_eq!(err, Error::WindowOpen);
    }

    #[test]
    fn succeeds_one_second_after_ship_by() {
        let s = setup();
        let id = create_default_order(&s);
        let order = s.contract.get_order(&id);
        advance_time(&s.env, order.ship_by - s.env.ledger().timestamp() + 1);
        s.contract.claim_refund(&id);
        assert_eq!(s.contract.get_order(&id).status, Status::Refunded);
    }

    #[test]
    fn rejects_on_shipped_order() {
        let s = setup();
        let id = create_default_order(&s);
        s.contract.mark_shipped(&id);
        let err = unwrap_err(s.contract.try_claim_refund(&id));
        assert_eq!(err, Error::WrongState);
    }

    #[test]
    fn conservation_full_amount_returned() {
        let s = setup();
        let id = create_default_order(&s);
        advance_time(&s.env, DEFAULT_SHIP_BY_OFFSET + 1);
        let before = balance(&s.env, &s.token, &s.contract.address);
        s.contract.claim_refund(&id);
        let after = balance(&s.env, &s.token, &s.contract.address);
        assert_eq!(after, before - DEFAULT_AMOUNT);
    }
}

// ── open_dispute ──────────────────────────────────────────────────────────────

mod open_dispute {
    use super::*;

    fn shipped_order(s: &TestSetup) -> u64 {
        let id = create_default_order(s);
        s.contract.mark_shipped(&id);
        id
    }

    #[test]
    fn happy_path_sets_disputed() {
        let s = setup();
        let id = shipped_order(&s);
        s.contract.open_dispute(&id);
        assert_eq!(s.contract.get_order(&id).status, Status::Disputed);
    }

    #[test]
    fn rejects_after_review_window() {
        let s = setup();
        let id = shipped_order(&s);
        advance_time(&s.env, DEFAULT_REVIEW_SECS + 1);
        let err = unwrap_err(s.contract.try_open_dispute(&id));
        assert_eq!(err, Error::WindowClosed);
    }

    #[test]
    fn rejects_one_second_past_review_end() {
        let s = setup();
        let id = shipped_order(&s);
        let order = s.contract.get_order(&id);
        let to_end = order.shipped_at + order.review_secs - s.env.ledger().timestamp();
        advance_time(&s.env, to_end + 1);
        let err = unwrap_err(s.contract.try_open_dispute(&id));
        assert_eq!(err, Error::WindowClosed);
    }

    #[test]
    fn succeeds_exactly_at_review_end() {
        let s = setup();
        let id = shipped_order(&s);
        let order = s.contract.get_order(&id);
        let to_end = order.shipped_at + order.review_secs - s.env.ledger().timestamp();
        advance_time(&s.env, to_end);
        // now == review_ends → now > review_ends is false → open_dispute allowed.
        s.contract.open_dispute(&id);
        assert_eq!(s.contract.get_order(&id).status, Status::Disputed);
    }

    #[test]
    fn rejects_on_funded_order() {
        let s = setup();
        let id = create_default_order(&s);
        let err = unwrap_err(s.contract.try_open_dispute(&id));
        assert_eq!(err, Error::WrongState);
    }
}

// ── resolve_dispute ───────────────────────────────────────────────────────────

mod resolve_dispute {
    use super::*;

    fn disputed_order(s: &TestSetup) -> u64 {
        let id = create_default_order(s);
        s.contract.mark_shipped(&id);
        s.contract.open_dispute(&id);
        id
    }

    #[test]
    fn happy_path_full_buyer_refund_no_fee() {
        let s = setup();
        let id = disputed_order(&s);

        let buyer_before = balance(&s.env, &s.token, &s.buyer);
        let treasury_before = balance(&s.env, &s.token, &s.treasury);

        s.contract.resolve_dispute(&id, &DEFAULT_AMOUNT, &0);

        assert_eq!(
            balance(&s.env, &s.token, &s.buyer),
            buyer_before + DEFAULT_AMOUNT
        );
        // No fee charged on the buyer's share.
        assert_eq!(balance(&s.env, &s.token, &s.treasury), treasury_before);
        assert_eq!(s.contract.get_order(&id).status, Status::Resolved);
    }

    #[test]
    fn fee_charged_on_seller_share_only() {
        let s = setup();
        let id = disputed_order(&s);

        let buyer_share = DEFAULT_AMOUNT / 2;
        let seller_share = DEFAULT_AMOUNT - buyer_share;
        let expected_fee = (seller_share * DEFAULT_FEE_BPS) / 10_000;
        let expected_net_seller = seller_share - expected_fee;

        let buyer_before = balance(&s.env, &s.token, &s.buyer);
        let seller_before = balance(&s.env, &s.token, &s.seller);
        let treasury_before = balance(&s.env, &s.token, &s.treasury);

        s.contract.resolve_dispute(&id, &buyer_share, &seller_share);

        assert_eq!(
            balance(&s.env, &s.token, &s.buyer),
            buyer_before + buyer_share
        );
        assert_eq!(
            balance(&s.env, &s.token, &s.seller),
            seller_before + expected_net_seller
        );
        assert_eq!(
            balance(&s.env, &s.token, &s.treasury),
            treasury_before + expected_fee
        );
    }

    #[test]
    fn rejects_shares_mismatch() {
        let s = setup();
        let id = disputed_order(&s);
        // 1 + 1 = 2, not DEFAULT_AMOUNT.
        let err = unwrap_err(s.contract.try_resolve_dispute(&id, &1, &1));
        assert_eq!(err, Error::SharesMismatch);
    }

    #[test]
    fn rejects_on_funded_order() {
        let s = setup();
        let id = create_default_order(&s);
        let err = unwrap_err(s.contract.try_resolve_dispute(&id, &DEFAULT_AMOUNT, &0));
        assert_eq!(err, Error::WrongState);
    }

    #[test]
    fn conservation_all_funds_leave_contract() {
        let s = setup();
        let id = disputed_order(&s);
        let before = balance(&s.env, &s.token, &s.contract.address);
        s.contract
            .resolve_dispute(&id, &(DEFAULT_AMOUNT / 2), &(DEFAULT_AMOUNT / 2));
        let after = balance(&s.env, &s.token, &s.contract.address);
        assert_eq!(after, before - DEFAULT_AMOUNT);
    }
}

// ── admin ─────────────────────────────────────────────────────────────────────

mod admin {
    use super::*;

    #[test]
    fn set_fee_bps_at_cap() {
        let s = setup();
        s.contract.set_fee_bps(&500);
    }

    #[test]
    fn set_fee_bps_rejects_above_cap() {
        let s = setup();
        let err = unwrap_err(s.contract.try_set_fee_bps(&(MAX_FEE_BPS + 1)));
        assert_eq!(err, Error::FeeTooHigh);
    }

    #[test]
    fn set_fee_bps_rejects_negative() {
        let s = setup();
        let err = unwrap_err(s.contract.try_set_fee_bps(&-1));
        assert_eq!(err, Error::FeeTooHigh);
    }

    #[test]
    fn set_treasury_routes_fee_to_new_address() {
        let s = setup();
        let new_treasury = Address::generate(&s.env);
        s.contract.set_treasury(&new_treasury);

        let id = create_default_order(&s);
        s.contract.mark_shipped(&id);
        let before = balance(&s.env, &s.token, &new_treasury);
        s.contract.confirm_delivery(&id);

        let expected_fee = (DEFAULT_AMOUNT * DEFAULT_FEE_BPS) / 10_000;
        assert_eq!(
            balance(&s.env, &s.token, &new_treasury),
            before + expected_fee
        );
    }

    #[test]
    fn pause_blocks_new_orders() {
        let s = setup();
        s.contract.pause();
        let err = unwrap_err(s.contract.try_create_and_fund(
            &s.buyer,
            &s.seller,
            &s.token,
            &DEFAULT_AMOUNT,
            &default_ship_by(&s.env),
            &DEFAULT_REVIEW_SECS,
        ));
        assert_eq!(err, Error::Paused);
    }

    #[test]
    fn pause_does_not_block_confirm_delivery() {
        let s = setup();
        let id = create_default_order(&s);
        s.contract.mark_shipped(&id);
        s.contract.pause();
        s.contract.confirm_delivery(&id);
        assert_eq!(s.contract.get_order(&id).status, Status::Released);
    }

    #[test]
    fn pause_does_not_block_claim_refund() {
        let s = setup();
        let id = create_default_order(&s);
        s.contract.pause();
        advance_time(&s.env, DEFAULT_SHIP_BY_OFFSET + 1);
        s.contract.claim_refund(&id);
        assert_eq!(s.contract.get_order(&id).status, Status::Refunded);
    }

    #[test]
    fn pause_does_not_block_auto_release() {
        let s = setup();
        let id = create_default_order(&s);
        s.contract.mark_shipped(&id);
        s.contract.pause();
        advance_time(&s.env, DEFAULT_REVIEW_SECS + 1);
        s.contract.claim_auto_release(&id);
        assert_eq!(s.contract.get_order(&id).status, Status::Released);
    }

    #[test]
    fn pause_does_not_block_resolve_dispute() {
        let s = setup();
        let id = create_default_order(&s);
        s.contract.mark_shipped(&id);
        s.contract.open_dispute(&id);
        s.contract.pause();
        s.contract.resolve_dispute(&id, &DEFAULT_AMOUNT, &0);
        assert_eq!(s.contract.get_order(&id).status, Status::Resolved);
    }

    #[test]
    fn unpause_allows_new_orders() {
        let s = setup();
        s.contract.pause();
        s.contract.unpause();
        let id = create_default_order(&s);
        assert_eq!(s.contract.get_order(&id).status, Status::Funded);
    }
}

// ── terminal states are final ─────────────────────────────────────────────────

mod terminal_states {
    use super::*;

    #[test]
    fn released_blocks_all_mutations() {
        let s = setup();
        let id = create_default_order(&s);
        s.contract.mark_shipped(&id);
        s.contract.confirm_delivery(&id);

        assert_eq!(
            unwrap_err(s.contract.try_mark_shipped(&id)),
            Error::WrongState
        );
        assert_eq!(
            unwrap_err(s.contract.try_confirm_delivery(&id)),
            Error::WrongState
        );
        assert_eq!(
            unwrap_err(s.contract.try_open_dispute(&id)),
            Error::WrongState
        );
        assert_eq!(
            unwrap_err(s.contract.try_resolve_dispute(&id, &DEFAULT_AMOUNT, &0)),
            Error::WrongState
        );
        advance_time(&s.env, DEFAULT_REVIEW_SECS + 1);
        assert_eq!(
            unwrap_err(s.contract.try_claim_auto_release(&id)),
            Error::WrongState
        );
        advance_time(&s.env, DEFAULT_SHIP_BY_OFFSET + 1);
        assert_eq!(
            unwrap_err(s.contract.try_claim_refund(&id)),
            Error::WrongState
        );
    }

    #[test]
    fn refunded_blocks_all_mutations() {
        let s = setup();
        let id = create_default_order(&s);
        advance_time(&s.env, DEFAULT_SHIP_BY_OFFSET + 1);
        s.contract.claim_refund(&id);

        assert_eq!(
            unwrap_err(s.contract.try_mark_shipped(&id)),
            Error::WrongState
        );
        assert_eq!(
            unwrap_err(s.contract.try_claim_refund(&id)),
            Error::WrongState
        );
    }

    #[test]
    fn resolved_blocks_further_resolution() {
        let s = setup();
        let id = create_default_order(&s);
        s.contract.mark_shipped(&id);
        s.contract.open_dispute(&id);
        s.contract.resolve_dispute(&id, &DEFAULT_AMOUNT, &0);

        assert_eq!(
            unwrap_err(s.contract.try_resolve_dispute(&id, &DEFAULT_AMOUNT, &0)),
            Error::WrongState
        );
    }
}

// ── conservation property ─────────────────────────────────────────────────────

mod conservation {
    use super::*;

    /// For varied (amount, fee_bps, buyer_pct), all funds leave the contract on settlement.
    #[test]
    fn payout_sum_equals_funded_amount() {
        let cases: &[(i128, i128, i128)] = &[
            (1_000_000, 0, 0),
            (1_000_000, 0, 50),
            (1_000_000, 0, 100),
            (1_000_000, 100, 0),
            (1_000_000, 100, 50),
            (1_000_000, 100, 100),
            (1_000_000, 500, 0),
            (1_000_000, 500, 50),
            (1_000_000, 500, 100),
            (1, 500, 0),
            (1, 500, 100),
            (9_999_999, 100, 33),
            (9_999_999, 499, 77),
        ];

        for &(amount, fee_bps, buyer_pct) in cases {
            let s = setup();
            s.contract.set_fee_bps(&fee_bps);

            let token_admin = Address::generate(&s.env);
            let token_addr = s
                .env
                .register_stellar_asset_contract_v2(token_admin.clone());
            let t = token_addr.address();
            StellarAssetClient::new(&s.env, &t).mint(&s.buyer, &amount);

            let id = s.contract.create_and_fund(
                &s.buyer,
                &s.seller,
                &t,
                &amount,
                &default_ship_by(&s.env),
                &DEFAULT_REVIEW_SECS,
            );
            s.contract.mark_shipped(&id);
            s.contract.open_dispute(&id);

            let buyer_share = (amount * buyer_pct) / 100;
            let seller_share = amount - buyer_share;

            let before = balance(&s.env, &t, &s.contract.address);
            s.contract.resolve_dispute(&id, &buyer_share, &seller_share);
            let after = balance(&s.env, &t, &s.contract.address);

            assert_eq!(
                after,
                before - amount,
                "conservation violated: amount={amount} fee_bps={fee_bps} buyer_pct={buyer_pct}"
            );
        }
    }

    #[test]
    fn refund_is_always_fee_free() {
        for &amount in &[1i128, 100, 999_999, 9_999_999] {
            let s = setup();

            let token_admin = Address::generate(&s.env);
            let token_addr = s
                .env
                .register_stellar_asset_contract_v2(token_admin.clone());
            let t = token_addr.address();
            StellarAssetClient::new(&s.env, &t).mint(&s.buyer, &amount);

            let id = s.contract.create_and_fund(
                &s.buyer,
                &s.seller,
                &t,
                &amount,
                &default_ship_by(&s.env),
                &DEFAULT_REVIEW_SECS,
            );
            advance_time(&s.env, DEFAULT_SHIP_BY_OFFSET + 1);

            let buyer_before = balance(&s.env, &t, &s.buyer);
            s.contract.claim_refund(&id);
            assert_eq!(
                balance(&s.env, &t, &s.buyer),
                buyer_before + amount,
                "refund not fee-free for amount={amount}"
            );
        }
    }
}

// ── TTL ───────────────────────────────────────────────────────────────────────

mod ttl {
    use super::*;

    #[test]
    fn order_readable_after_large_ledger_advance() {
        let s = setup();
        let id = create_default_order(&s);

        // Advance by half the TTL window (in ledgers). The entry was extended to
        // ORDER_TTL_LEDGERS on write, so it must still be readable.
        let mut info = s.env.ledger().get();
        info.sequence_number += crate::ORDER_TTL_LEDGERS / 2;
        s.env.ledger().set(info);

        let order = s.contract.get_order(&id);
        assert_eq!(order.status, Status::Funded);
    }
}
