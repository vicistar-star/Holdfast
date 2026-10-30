# Holdfast — Smart Contract Self-Review & Pre-Audit Checklist

> [!IMPORTANT]
> **Pre-Audit Checklist Notice**: This document is an internal engineering self-review and pre-audit checklist. It is **NOT** a replacement for a formal external security audit by an accredited smart contract auditing firm. An external audit is strictly mandatory before mainnet deployment and before real customer funds are handled.

---

## 1. Scope & Verification Target

- **Contract**: `contracts/escrow/src/lib.rs` (and associated modules: `errors.rs`, `events.rs`, `types.rs`)
- **SDK**: `soroban-sdk` v27.0.6
- **Architecture**: Single-contract escrow managing orders, timeouts, dispute freezing, and fee deductions.

---

## 2. Invariant Review Matrix

| # | Master Prompt Invariant | Code Verification | Verdict |
|---|---|---|---|
| **1** | **Exact 6 Order States**: `Funded`, `Shipped`, `Released`, `Refunded`, `Disputed`, `Resolved` | Verified in `types.rs` `Status` enum. Exactly 6 variants exist. No other states or sub-states are permitted. | PASS |
| **2** | **Contract Functions Exactly Match Spec**: `create_and_fund`, `mark_shipped`, `confirm_delivery`, `claim_auto_release`, `claim_refund`, `open_dispute`, `resolve_dispute`, `get_order`, `pause`, `unpause`, admin setters. | Verified in `EscrowContract` trait implementation in `lib.rs`. | PASS |
| **3** | **Atomic Create & Fund**: `create_and_fund` creates and funds in one call. | Creates `Order` struct and transfers token from buyer in same function. No standalone `Created` state exists. | PASS |
| **4** | **Permissionless Settlements**: `claim_auto_release` and `claim_refund` must be callable by any address. | Neither function calls `require_auth()` on the caller; both verify only ledger timestamp and order status. | PASS |
| **5** | **Pause Behavior**: `pause` blocks only new orders; settlement paths stay open. | Checked: `env.storage().instance().get(&DataKey::Paused)` is queried only in `create_and_fund`. `confirm_delivery`, `claim_auto_release`, `claim_refund`, and `resolve_dispute` do NOT check paused state. | PASS |
| **6** | **Fee Semantics**: Fees on payouts only; refunds fee-free; fee charged on seller share only in disputes; capped in code. | - `compute_payout` floor-divides fee.<br>- `claim_refund` refunds full `order.amount` with 0 fee.<br>- `resolve_dispute` calculates fee only on `seller_share`.<br>- `MAX_FEE_BPS` = 500 (5%) hard-coded in contract. | PASS |
| **7** | **Conservation of Funds**: Sum of payouts equals funded amount exactly. | - In `confirm_delivery` & `claim_auto_release`: `to_seller + fee == order.amount`.<br>- In `claim_refund`: `order.amount` to buyer.<br>- In `resolve_dispute`: `buyer_share + seller_share == order.amount`, and `seller_share = net_seller + fee`. | PASS |
| **8** | **State Before Transfer**: Order state is committed to storage before any token transfer. | In every mutating function (`create_and_fund`, `mark_shipped`, `confirm_delivery`, `claim_auto_release`, `claim_refund`, `open_dispute`, `resolve_dispute`), `env.storage().persistent().set(&key, &order)` precedes all `token_client.transfer` calls. | PASS |
| **9** | **Storage TTL Extension**: Every write extends storage TTL. | `extend_order_ttl(&env, &key)` is invoked on every write to `DataKey::Order(id)`, extending TTL to 7,000,000 ledgers (~400 days). | PASS |
| **10** | **Integer Money**: All monetary amounts are integer minor units (i128). | All token amounts, shares, and fees are typed as `i128`. No floating-point operations exist. | PASS |

---

## 3. Function-by-Function Critical Analysis

### 3.1 `initialize`
- **Logic**: Sets admin, arbiter, treasury, fee_bps, and max_order_amount.
- **Check**: Guarded by `AlreadyInitialized` check on `DataKey::Admin`.
- **Finding**: Cannot be re-initialized. Admin address cannot be overwritten.

### 3.2 `create_and_fund`
- **Logic**: Allocates incremental order ID, verifies deadlines and review periods, checks pause, requires buyer auth, stores order, transfers funds.
- **Check**: Validates `amount > 0`, `amount <= max_order_amount`, `ship_by > now`, and `review_secs in [3600, 2592000]`.
- **Finding**: Counter increment is atomic; state saved before token transfer.

### 3.3 `mark_shipped`
- **Logic**: Transitions status from `Funded` to `Shipped`.
- **Check**: Requires seller authorization (`order.seller.require_auth()`). Validates `now <= order.ship_by`.
- **Finding**: If seller misses `ship_by`, function rejects with `WindowClosed`, leaving refund open for the buyer.

### 3.4 `confirm_delivery`
- **Logic**: Transitions status from `Shipped` to `Released`.
- **Check**: Requires buyer authorization (`order.buyer.require_auth()`).
- **Finding**: Computes payout and fee; transfers net to seller and fee to treasury.

### 3.5 `claim_auto_release`
- **Logic**: Permissionless auto-release after `shipped_at + review_secs`.
- **Check**: Uses `saturating_add` for timestamp calculation to prevent overflow. Rejects with `WindowOpen` if `now <= review_ends`.
- **Finding**: Completely permissionless; allows keepers or sellers to unlock funds without buyer interaction.

### 3.6 `claim_refund`
- **Logic**: Permissionless refund if seller fails to ship before `ship_by`.
- **Check**: Rejects if `now <= order.ship_by`. Full amount returned to buyer with 0 fee.
- **Finding**: Protects buyer against abandoned orders.

### 3.7 `open_dispute`
- **Logic**: Buyer opens dispute within review window (`now <= shipped_at + review_secs`).
- **Check**: Requires buyer authorization. Freezes order in `Disputed` state.
- **Finding**: Blocks subsequent calls to `confirm_delivery` and `claim_auto_release`.

### 3.8 `resolve_dispute`
- **Logic**: Arbiter splits funds between buyer and seller.
- **Check**: Requires arbiter authorization (`arbiter.require_auth()`). Asserts `buyer_share + seller_share == order.amount` and both non-negative.
- **Finding**: Conservation strictly enforced; fee applies strictly to `seller_share`.

### 3.9 Admin Setters: `set_fee_bps`, `set_treasury`, `pause`, `unpause`
- **Check**: All admin functions require `admin.require_auth()`. `set_fee_bps` enforces `fee_bps <= MAX_FEE_BPS` (500).

---

## 4. Pre-Audit Observations & Items for Audit Scope

1. **Arbiter Key Rotation (`set_arbiter`)**:
   - *Observation*: The contract currently has `set_fee_bps` and `set_treasury`, but no `set_arbiter` function.
   - *Implication*: If the arbiter key is rotated or migrated to a new multisig, the contract cannot update the arbiter address without redeploying.
   - *Recommendation*: Recommend presenting this design choice to the external auditor. If arbiter rotation is desired, an admin setter `set_arbiter(new_arbiter)` should be added behind admin auth.
2. **Dynamic Fee Application on Dispute Resolution**:
   - *Observation*: `resolve_dispute` fetches `FeeBps` from instance storage at the time of resolution rather than snapshotting fee bps at order creation.
   - *Implication*: If the platform admin modifies `fee_bps`, orders opened under the previous fee will be resolved using the new fee.
   - *Recommendation*: Since fees are capped at 5% and changes are rare, this is acceptable for v1, but the external auditor should review whether order-level fee locking is desirable.
3. **Arbiter Unresponsiveness**:
   - *Observation*: Disputed orders have no automated expiration timeout; funds remain locked until the arbiter signs.
   - *Decision*: This is an intentional product design decision recorded in `docs/decisions.md` (no automated fund movement without explicit human decision).
4. **Token Contract Assumption**:
   - *Observation*: The contract interacts with Stellar standard token contracts via `token::Client`.
   - *Implication*: Malicious custom tokens that revert or re-enter could disrupt settlement. For v1, Holdfast exclusively supports official partner stablecoins (e.g. circle USDC on Stellar).
