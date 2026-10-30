# Runbook: Incorrect Payout or Reconciliation Mismatch

## Symptoms
- Alert: `reconciliation_mismatches_total > 0`.
- Entry in `reconciliation_issues` with issue type:
  - `AMOUNT_MISMATCH`
  - `MISSING_ORDER`
  - `PAYOUT_NOT_INITIATED`
- A seller or buyer reports receiving an incorrect transfer amount or no disbursement.

## Diagnosis Steps
1. **Query active reconciliation issues**:
   ```sql
   SELECT * FROM reconciliation_issues ORDER BY created_at DESC LIMIT 10;
   ```
2. **Inspect order financial calculations**:
   ```sql
   SELECT id, amount_minor, status FROM orders WHERE id = '<ORDER_ID>';
   SELECT * FROM payouts WHERE order_id = '<ORDER_ID>';
   SELECT * FROM order_events WHERE order_id = '<ORDER_ID>';
   ```
3. **Verify conservation invariant**:
   - Check if `payouts.amount_minor + fee_minor == orders.amount_minor`.
   - In dispute resolution, check if `buyer_share + seller_share == order.amount_minor` and fee was charged strictly on seller share.

## Fix
1. **If `PAYOUT_NOT_INITIATED` (e.g. keeper was killed mid-job)**:
   Trigger disbursement for the missing terminal order:
   ```bash
   pnpm --filter @holdfast/api exec node --experimental-strip-types -e "
     import { db, schema, eq } from '@holdfast/db';
     import { getPaymentProvider } from './src/payment/mockProvider.ts';
     // Re-trigger payout via provider with idempotent key
   "
   ```
2. **If `AMOUNT_MISMATCH` caused by partial transfer**:
   Verify with payment partner banking portal whether a network charge or surcharge caused truncation. File claim with partner support.
3. **Resolve issue record**:
   ```sql
   DELETE FROM reconciliation_issues WHERE id = '<ISSUE_ID>';
   ```

## How to Verify
1. Run the reconciliation job:
   ```bash
   pnpm --filter @holdfast/api exec node --experimental-strip-types -e "
     import { runReconciliation } from './src/jobs/reconciliation.ts';
     const res = await runReconciliation();
     console.log('Checked:', res.checked, 'Issues:', res.issues);
   "
   ```
   Ensure issues count returns 0.
2. Confirm `reconciliation_mismatches_total` metric is 0:
   ```bash
   curl -s http://localhost:3001/metrics | jq .reconciliation_mismatches_total
   ```
