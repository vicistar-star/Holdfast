# Holdfast — Failure Injection and Resilience Specification

This document details the expected behaviour, failure recovery mechanisms, and invariant guarantees for each of the eight critical failure scenarios in Holdfast.

---

## Non-Negotiable Invariants Under Failure

1. **State Machine Integrity**: An order can only transition through the strict state machine: `Funded` -> `Shipped` -> `Released` / `Refunded` / `Disputed` -> `Resolved`. No failure can cause an order to skip states, regress states, or enter an undefined state.
2. **State Before Transfer (Rule 8)**: State is always written to the database or contract storage before external transfer or partner payout instructions are issued.
3. **Conservation of Funds (Rule 7)**: For every terminal state, payouts plus fee sum exactly to the funded amount.
4. **Append-Only Audit Log (Rule 11)**: `order_events` is append-only.
5. **Idempotency Everywhere**: All webhook handlers, keeper jobs, and indexer poll loops must be safe to replay repeatedly without duplicate side-effects.

---

## 1. Soroban RPC Unavailable or Slow

### Expected Behaviour
- **Simulation Failure**: If the Soroban RPC node is down, unreachable, returns HTTP 503, or times out during `simulateTransaction`, the call throws a simulation error. No transaction envelope is assembled, no funds move, and no state change is committed.
- **Submission Failure**: If the RPC node drops connections during `sendTransaction`, the operation throws.
- **Client Safety**: The API and worker catch RPC errors and retry with exponential backoff.
- **Stranded State Prevention**: No database status is updated until transaction inclusion is verified. The order remains in its previous valid state.

### Proof
- `apps/api/src/resilience.test.ts` exercises simulated RPC network drops and verifies clean error propagation and untouched state.

---

## 2. Submitted Transaction Not Found in Mempool / Polling Timeout

### Expected Behaviour
- When `sendTransaction` succeeds and returns a transaction hash, the client polls `getTransaction(hash)` up to 30 times (60 seconds).
- If the transaction is evicted from the mempool or the node fails to return a final status (`NOT_FOUND`), the client throws:
  `Transaction not confirmed after polling: <hash>`
- The transaction hash is captured in logs and job metadata.
- The order status in the application database remains un-transitioned until confirmation. Subsequent keeper or indexer runs inspect the chain status by hash before deciding whether to resubmit or advance.

### Proof
- Tested in `apps/api/src/resilience.test.ts`: mock RPC server simulating `NOT_FOUND` across all polling attempts throws a timeout error without altering order status.

---

## 3. Partner Webhook Duplicates, Reordering, and Delays

### Expected Behaviour
- **Duplicates**: The `webhook_events` table enforces a unique constraint on `(provider, event_id)`. When a duplicate webhook arrives (e.g. partner retry), the database unique constraint catches it. The API logs `Duplicate webhook ignored` and returns HTTP 200 `{ ok: true, duplicate: true }`. No secondary state transitions or payouts occur.
- **Reordering**: If a payment webhook arrives out of order or for an order that has already moved to a terminal state (`Released`, `Refunded`, `Resolved`), the handler checks the current order status. It logs `Delayed or reordered webhook arrived for terminal order`, marks the event processed, and does not alter the order status.
- **Delays**: If a payment confirmation webhook arrives after a keeper auto-refund has already executed, the terminal state guard blocks state regression, and any amount discrepancy is recorded in `reconciliation_issues`.
- **Amount Mismatches**: If the webhook reports an amount differing from `order.amount_minor`, the webhook creates an `AMOUNT_MISMATCH` entry in `reconciliation_issues` for operator attention.

### Proof
- Tested in `apps/api/src/resilience.test.ts` with repeated deliveries, out-of-order terminal state delivery, and amount mismatch payloads.

---

## 4. Keeper Killed Mid-Job

### Expected Behaviour
- Per Rule 8, `KeeperService` executes its state update in Postgres (`Funded` -> `Refunded` or `Shipped` -> `Released`) before initiating the partner payout.
- If the keeper process is abruptly terminated (e.g. `SIGKILL`, container OOM, spot instance termination) after the database update but before the payout API call completes:
  1. **On Keeper Restart**: BullMQ or the periodic scanner re-picks up the order. `settleRefund` / `settleAutoRelease` inspects current order status. Because the status is already `Refunded` / `Released`, it returns `skipped: true, reason: already_<status>` without repeating state updates or throwing.
  2. **Reconciliation Job**: The daily/hourly `runReconciliation` job checks all orders in `Released`, `Refunded`, or `Resolved` states. Any order missing a corresponding entry in `schema.payouts` is flagged with `PAYOUT_NOT_INITIATED` in `reconciliation_issues`, enabling automated retry or operator remediation.

### Proof
- Tested in `apps/api/src/resilience.test.ts` and `apps/worker/src/keeper.test.ts`.

---

## 5. Indexer Restarted / Replaying History

### Expected Behaviour
- The `EventIndexerService` maintains its high-water mark in the `indexer_cursors` table (`last_ledger`, `cursor`).
- When restarted after a crash, it fetches the persisted cursor and resumes polling from `startLedger = last_ledger`.
- If an overlap causes events to be re-read:
  1. **Event Deduplication**: The indexer queries `order_events` for the order and skips any event where `(to_status == toStatus && tx_hash == event.txHash)`.
  2. **Monotonic Progression Guard**: `canAdvanceStatus(currentStatus, toStatus)` enforces that terminal states (`Released`, `Refunded`, `Resolved`) can never be overwritten by earlier events (`Funded`, `Shipped`), and `Disputed` cannot regress to `Funded`.
- Order projection is guaranteed never to regress or lose consistency.

### Proof
- Tested in `apps/worker/src/indexer.test.ts` and `apps/api/src/resilience.test.ts`.

---

## 6. Postgres Connection Loss Mid-Transaction

### Expected Behaviour
- All multi-table mutations (e.g. updating `orders` and appending to `order_events`) occur within an atomic `db.transaction(async (tx) => { ... })`.
- If the connection drops, times out, or closes mid-transaction:
  * PostgreSQL rolls back the uncommitted transaction.
  * No partial writes occur (e.g., status updated without an audit row, or vice versa).
  * Fastify returns HTTP 500; background jobs fail and are scheduled for exponential retry by BullMQ.
  * Invariant: `order_events` and `orders.status` remain 100% in sync.

### Proof
- Tested in `apps/api/src/resilience.test.ts` simulating transaction rollback on connection interruption.

---

## 7. Sponsor Balance / Budget Exhausted

### Expected Behaviour
- `SponsorService` enforces a strict daily quota (`perAccountDailyStroops`) and a low-balance threshold (`lowBalanceAlertStroops`).
- If an account attempts to exceed its daily fee budget, `SponsorService.checkBudget()` throws `Sponsor budget exhausted for account <id>`.
- If total sponsor balance falls below threshold, the `onLowBalance` hook alerts ops immediately.
- The failure occurs **before** any unsponsored transaction is broadcast to the Stellar network, preventing partial or stranded states.

### Proof
- Tested in `apps/api/src/resilience.test.ts` and `apps/api/src/day4.test.ts`.

---

## 8. Evidence Storage (S3 / MinIO) Down

### Expected Behaviour
- When a user uploads evidence via `POST /v1/orders/:id/evidence/upload`, the file stream is piped directly into `StorageService.uploadStream()`.
- If the S3/MinIO service is down, unreachable, or returns 500:
  * The streaming pipeline errors and terminates immediately.
  * The database transaction inserting into `schema.evidence` is never reached.
  * No corrupt SHA-256 hash or dead object reference is saved in Postgres.
  * The API responds with an error, prompting the client to retry.

### Proof
- Tested in `apps/api/src/resilience.test.ts` and `apps/api/src/storage/s3Client.test.ts`.
