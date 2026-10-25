# Holdfast — Contract Specification

This document is the canonical reference for the Holdfast escrow contract.
It mirrors the README specification and adds implementation detail.

Source: `contracts/escrow/src/`  
Deployed (testnet): `CCXJ2656ZTAWW7QBZSXZFO6ZLU54I4RU2ND3Q3O454QYKVIAU3EP43B6`

---

## State table

| Status | Terminal? | Description |
|--------|-----------|-------------|
| `Funded` | No | Order created and funded. Seller must ship before `ship_by`. |
| `Shipped` | No | Seller shipped. Buyer's review window is running. |
| `Released` | **Yes** | Funds paid to seller (minus fee). |
| `Refunded` | **Yes** | Full amount returned to buyer. No fee charged. |
| `Disputed` | No | Buyer opened a dispute inside the review window. Funds frozen. |
| `Resolved` | **Yes** | Arbiter split the funds. Fee charged on seller share only. |

Terminal states are irreversible. No function may transition an order out of a terminal state.

---

## Function table

| Function | Caller | Preconditions | Effect |
|----------|--------|---------------|--------|
| `initialize(admin, arbiter, treasury, fee_bps, max_order_amount)` | Anyone (once) | Not already initialised, `fee_bps` ≤ 500, `max_order_amount` > 0 | Stores config. Rejects re-initialisation with `AlreadyInitialized`. |
| `create_and_fund(buyer, seller, token, amount, ship_by, review_secs) → u64` | Buyer | Not paused; `amount` > 0 and ≤ cap; `ship_by` > now; `review_secs` ∈ [3600, 2_592_000] | Transfers `amount` from buyer to contract. Stores order as `Funded`. Returns new order ID. |
| `mark_shipped(id)` | Seller (stored on order) | Status `Funded`; now ≤ `ship_by` | Sets `Shipped`, records `shipped_at = now`. |
| `confirm_delivery(id)` | Buyer (stored on order) | Status `Shipped` | Sets `Released`. Pays seller `amount - fee`, fee to treasury. |
| `claim_auto_release(id)` | Anyone | Status `Shipped`; now > `shipped_at + review_secs` | Same payout as `confirm_delivery`. |
| `claim_refund(id)` | Anyone | Status `Funded`; now > `ship_by` | Sets `Refunded`. Returns full `amount` to buyer. No fee. |
| `open_dispute(id)` | Buyer (stored on order) | Status `Shipped`; now ≤ `shipped_at + review_secs` | Sets `Disputed`. Funds frozen on-chain. |
| `resolve_dispute(id, buyer_share, seller_share)` | Arbiter (contract-level) | Status `Disputed`; `buyer_share + seller_share == amount`; both ≥ 0 | Sets `Resolved`. Pays buyer `buyer_share`, pays seller `seller_share - fee`, fee to treasury. Fee on seller share only. |
| `get_order(id) → Order` | Anyone | — | Returns the order or `NotFound`. |
| `set_fee_bps(fee_bps)` | Admin | `fee_bps` ∈ [0, 500] | Updates the platform fee. |
| `set_treasury(treasury)` | Admin | — | Updates the treasury address. |
| `pause()` | Admin | — | Sets `Paused = true`. Blocks `create_and_fund` only. |
| `unpause()` | Admin | — | Sets `Paused = false`. |

---

## Event table

Every state transition emits exactly one event. All events use the `#[contractevent]` macro.

| Event struct | Topics | Data fields |
|---|---|---|
| `FundedEvent` | `["order", "funded"]` | `id, buyer, seller, token, amount, ship_by` |
| `ShippedEvent` | `["order", "shipped"]` | `id, shipped_at` |
| `ReleasedEvent` | `["order", "released"]` | `id, to_seller, fee, how` (how = "confirmed" \| "auto") |
| `RefundedEvent` | `["order", "refunded"]` | `id, amount` |
| `DisputedEvent` | `["order", "disputed"]` | `id, opened_at` |
| `ResolvedEvent` | `["order", "resolved"]` | `id, buyer_share, seller_share, fee` |

The event indexer consumes these to build seller reputation and mirror state to Postgres.

---

## Error codes

| Code | Name | When |
|------|------|------|
| 1 | `NotFound` | Order ID does not exist |
| 2 | `WrongState` | Order is not in the required state for this function |
| 3 | `Unauthorized` | Caller is not the required role |
| 4 | `Paused` | Contract is paused; `create_and_fund` blocked |
| 5 | `AmountInvalid` | Amount ≤ 0, or a dispute share is negative |
| 6 | `DeadlineInvalid` | `ship_by` ≤ now at time of `create_and_fund` |
| 7 | `CapExceeded` | Amount > `max_order_amount` |
| 8 | `WindowClosed` | Action requires a window that has already closed |
| 9 | `WindowOpen` | Action requires a window that has not yet closed |
| 10 | `SharesMismatch` | `buyer_share + seller_share ≠ order.amount` |
| 11 | `FeeTooHigh` | `fee_bps` > 500 |
| 12 | `AlreadyInitialized` | `initialize` called more than once |
| 13 | `ReviewSecsInvalid` | `review_secs` outside [3600, 2_592_000] |

---

## Rounding rule

Fee computation: `fee = amount * fee_bps / 10_000`

Division uses **floor (truncation toward zero)**, matching Rust `i128` division and JavaScript `BigInt` division. The remainder — at most 1 unit — stays with the payee (seller on release, buyer on refund since refunds are fee-free).

This rule is implemented identically in:
- `contracts/escrow/src/lib.rs` (Rust `i128` division)
- `packages/shared/src/index.ts` (`computeFee` using `BigInt` division)

Any change to the rounding rule must update both files simultaneously.

**Conservation check:** for every terminal state, `(to_seller + fee)` or `(buyer_share + net_seller + fee)` always equals `order.amount`. This is verified by the property test in `test.rs` (conservation module, 13 parameterised cases).

---

## TTL policy

Every write to an `Order` persistent storage entry calls `extend_ttl` with:

```
threshold = ORDER_TTL_LEDGERS = 7_000_000
extend_to = ORDER_TTL_LEDGERS = 7_000_000
```

At ~5 seconds per ledger, `7_000_000` ledgers ≈ **405 days**, which exceeds any possible combination of `ship_by` + `review_secs` within the configured bounds.

This guarantees that storage archival can never strand funds. The TTL is extended on every write (create, ship, settle) so it always counts from the last activity.

---

## Storage layout

| Key type | Scope | Contents |
|----------|-------|----------|
| `DataKey::Order(u64)` | Persistent | Full `Order` struct |
| `DataKey::Counter` | Instance | Next order ID counter |
| `DataKey::Admin` | Instance | Admin address |
| `DataKey::Arbiter` | Instance | Arbiter address |
| `DataKey::Treasury` | Instance | Treasury address |
| `DataKey::FeeBps` | Instance | Current fee in basis points |
| `DataKey::Paused` | Instance | Pause flag (bool) |
| `DataKey::MaxOrderAmount` | Instance | Per-order cap |

Instance storage is not subject to archival TTL concerns (it lives with the contract).
Only `Order` entries use persistent storage and require explicit TTL extension.

---

## Review window bounds

| Bound | Value | Reason |
|-------|-------|--------|
| `MIN_REVIEW_SECS` | 3,600 (1 hour) | Minimum time for a buyer to check delivery |
| `MAX_REVIEW_SECS` | 2,592,000 (30 days) | Longest practical delivery + inspection window |

These are compile-time constants. Changes require a contract redeployment.

---

## Open decisions (see docs/decisions.md)

- **Arbiter timeout**: no timeout implemented. Disputes without arbiter action remain frozen.
- **Upgradeability**: contract is immutable. No upgrade mechanism.
- **Partial release**: all-or-nothing. No partial delivery path.
