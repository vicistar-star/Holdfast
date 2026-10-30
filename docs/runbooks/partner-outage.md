# Runbook: Payment / KYC Partner Outage

## Symptoms
- Alert: `webhook_failures_total` spike or partner API returning 5xx / connection timeouts.
- Buyers report failure generating bank transfer instructions on checkout links.
- Payouts or refunds fail with `EHOSTUNREACH` or `ETIMEDOUT`.
- Seller bank verification or KYC checks hang in `pending`.

## Diagnosis Steps
1. **Check partner status page**:
   Check Paystack, Flutterwave, Monnify, Squad, or Smile ID status pages.
2. **Review application outbound network logs**:
   ```bash
   grep -i "partner_error" /var/log/holdfast/api.log
   ```
3. **Inspect reconciliation backlog**:
   ```sql
   SELECT issue_type, count(*) FROM reconciliation_issues GROUP BY issue_type;
   ```

## Fix
1. **Activate backup payment partner (Mode A)**:
   If the primary partner is experiencing a prolonged outage (> 1 hour), update `PAYMENT_PROVIDER_PRIMARY` in `.env` to the designated backup provider:
   ```bash
   export PAYMENT_PROVIDER_PRIMARY="flutterwave" # or squad / monnify
   sudo systemctl restart holdfast-api
   ```
2. **Buffer and retry failed payouts**:
   All failed payout requests in `payouts` retain their unique `idempotency_key`. BullMQ will retry with exponential backoff.
3. **Queue incoming webhooks**:
   Ensure edge load balancers or proxy servers return HTTP 200 or 503 according to partner retry policies to preserve incoming webhook retries.

## How to Verify
1. Generate a test payment link and verify new virtual accounts resolve:
   ```bash
   curl -s -X POST http://localhost:3001/v1/auth/otp/request -d '{"phone": "+2348000000099"}' -H "Content-Type: application/json"
   ```
2. Run reconciliation sweep after partner recovery:
   ```bash
   pnpm --filter @holdfast/api exec node --experimental-strip-types -e "
     import { runReconciliation } from './src/jobs/reconciliation.ts';
     const res = await runReconciliation();
     console.log('Reconciliation result:', res);
   "
   ```
