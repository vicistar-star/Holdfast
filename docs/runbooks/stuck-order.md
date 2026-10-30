# Runbook: Stuck Order Investigation & Recovery

## Symptoms
- Alert: `stuck_orders_count > 0` (an order is in a non-terminal state older than 14 days).
- Buyer or seller reports an order that has not progressed and has no pending actions.
- Order is in `Disputed` state for an extended duration without arbiter review.

## Diagnosis Steps
1. **Fetch complete order timeline and audit events**:
   ```sql
   SELECT * FROM orders WHERE id = '<ORDER_ID>';
   SELECT * FROM order_events WHERE order_id = '<ORDER_ID>' ORDER BY created_at ASC;
   ```
2. **Determine blocker by state**:
   - `Funded`: Has `ship_by` passed? Check why keeper hasn't triggered `claim_refund`.
   - `Shipped`: Has `review_ends` passed? Is there an active row in `disputes`?
   - `Disputed`: Inspect evidence in `evidence` table; check why arbiter has not signed resolution.
3. **Check payouts and partner transaction status**:
   ```sql
   SELECT * FROM payouts WHERE order_id = '<ORDER_ID>';
   SELECT * FROM webhook_events WHERE payload::text LIKE '%<ORDER_ID>%' OR payload::text LIKE '%<PAYMENT_REF>%';
   ```

## Fix
1. **If seller missed shipping deadline**:
   Trigger keeper settlement:
   ```bash
   pnpm --filter @holdfast/worker exec node --experimental-strip-types -e "
     import { KeeperService } from './src/keeper.ts';
     const keeper = new KeeperService();
     await keeper.settleRefund('<ORDER_ID>');
   "
   ```
2. **If review window elapsed without dispute**:
   Trigger auto-release settlement:
   ```bash
   pnpm --filter @holdfast/worker exec node --experimental-strip-types -e "
     import { KeeperService } from './src/keeper.ts';
     const keeper = new KeeperService();
     await keeper.settleAutoRelease('<ORDER_ID>');
   "
   ```
3. **If dispute is awaiting resolution**:
   Log into the arbiter dispute console at `http://localhost:3000/admin`, review evidence, and submit split payout resolution.

## How to Verify
1. Verify the order has reached a valid terminal state (`Released`, `Refunded`, `Resolved`):
   ```sql
   SELECT status FROM orders WHERE id = '<ORDER_ID>';
   ```
2. Verify conservation of funds:
   ```sql
   SELECT sum(amount_minor) FROM payouts WHERE order_id = '<ORDER_ID>';
   ```
   Must equal original `orders.amount_minor`.
