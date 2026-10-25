# contracts/escrow

Holdfast escrow contract — Soroban / Rust.

Implements the full order lifecycle as specified in the [README](../../README.md).

---

## Quick start

### Prerequisites

- Rust stable with `wasm32v1-none` target:
  ```bash
  rustup target add wasm32v1-none
  ```
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli) (v28+):
  ```bash
  stellar --version
  ```

### Run tests

```bash
cargo test
```

Expected output: `58 passed; 0 failed`.

### Build WASM

```bash
cargo build --target wasm32v1-none --release
# Output: target/wasm32v1-none/release/escrow.wasm
```

### Deploy to testnet

From the repo root:

```bash
./scripts/deploy-testnet.sh
```

This will:
1. Build the WASM.
2. Create testnet identities (`deployer`, `arbiter`, `treasury`) if they don't exist.
3. Fund `deployer` via Friendbot.
4. Deploy the contract.
5. Call `initialize` with the identity addresses.
6. Print the contract ID to add to `.env`.

---

## Source layout

| File | Purpose |
|------|---------|
| `src/lib.rs` | Contract entry point, all public functions |
| `src/types.rs` | `Status`, `Order`, `DataKey` — mirrors README exactly |
| `src/errors.rs` | `Error` enum with one code per failure mode |
| `src/events.rs` | `#[contractevent]` types and publisher functions |
| `src/test.rs` | Full test suite (58 tests) |

---

## State machine

```
Funded → Shipped          mark_shipped (seller, before ship_by)
Funded → Refunded         claim_refund (anyone, after ship_by)
Shipped → Released        confirm_delivery (buyer)
Shipped → Released        claim_auto_release (anyone, after review window)
Shipped → Disputed        open_dispute (buyer, inside review window)
Disputed → Resolved       resolve_dispute (arbiter)
```

Terminal states — **Released**, **Refunded**, **Resolved** — are final.

---

## Invariants

Every invariant in `docs/architecture.md` applies here. Key ones:

- State is written before any token transfer.
- For every terminal state, payouts sum exactly to `order.amount`.
- Fee rounds down: `fee = amount * fee_bps / 10_000`.
- `fee_bps` is capped at 500 (5%) in code.
- `pause()` blocks `create_and_fund` only — settlement paths always stay open.
- Every order write extends TTL to `ORDER_TTL_LEDGERS` (≥ 400 days at 5 s/ledger).

---

## Notes for production

- The contract is **immutable** — there is no upgrade mechanism. See `docs/decisions.md`.
- The arbiter is a **multisig account with hardware keys**. Never deploy with a single-signer arbiter for real funds.
- Deploy behind the mainnet checklist in the README — no real funds until an external audit is complete.
