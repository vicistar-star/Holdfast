# Runbook: Keeper Service Down or Unresponsive

## Symptoms
- Alert: `keeper_lag_seconds > 900` (overdue orders past `ship_by` or `review_ends` are not transitioning).
- Orders remain in `Funded` state past their `ship_by` deadline without triggering `claim_refund`.
- Orders remain in `Shipped` state past `review_ends` without triggering `claim_auto_release`.
- BullMQ worker logs stop emitting heartbeat or job completion messages.

## Diagnosis Steps
1. **Check process status**:
   ```bash
   ps aux | grep -i keeper
   docker compose -f infra/docker-compose.yml ps
   ```
2. **Inspect BullMQ queue depth**:
   Check Redis queue lengths for `keeper` and `keeper-dlq`:
   ```bash
   redis-cli LLEN "bull:keeper:wait"
   redis-cli LLEN "bull:keeper:failed"
   redis-cli LLEN "bull:keeper-dlq:wait"
   ```
3. **Inspect worker error logs**:
   ```bash
   journalctl -u holdfast-worker -n 100 --no-pager
   ```
   Look for uncaught exceptions, database connection pool exhaustion (`ECONNREFUSED`), or payment partner API errors.

## Fix
1. **Restart Keeper Worker**:
   ```bash
   # If running via systemd:
   sudo systemctl restart holdfast-worker
   # If running via docker compose:
   docker compose -f infra/docker-compose.yml restart worker
   ```
2. **Trigger manual sweep / drain backlog**:
   If BullMQ queue is backed up or keeper was offline for an extended window:
   ```bash
   pnpm --filter @holdfast/worker exec node --experimental-strip-types -e "
     import { KeeperService } from './src/keeper.ts';
     const keeper = new KeeperService();
     await keeper.runScan();
   "
   ```
3. **Dead Letter Queue (DLQ) Remediation**:
   Inspect jobs in `keeper-dlq`. Once the root cause (e.g. partner timeout) is resolved, retry DLQ jobs.

## How to Verify
1. Query metrics endpoint:
   ```bash
   curl -s http://localhost:3001/metrics | jq .keeper_lag_seconds
   ```
   Verify `keeper_lag_seconds` returns to 0.
2. Verify pending overdue orders transitioned:
   ```sql
   SELECT count(*) FROM orders WHERE status = 'Funded' AND ship_by < NOW();
   ```
   Expected result: `0`.
