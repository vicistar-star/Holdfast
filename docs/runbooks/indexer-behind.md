# Runbook: Soroban RPC Indexer Lagging Behind Chain Tip

## Symptoms
- Alert: `indexer_lag_ledgers > 50` (the indexer is more than ~4 minutes behind current ledger).
- On-chain transactions (such as mark_shipped or dispute opened) are not reflected in the database orders projection or user UI.
- Log message: `RPC history window expired` or `getEvents failed`.

## Diagnosis Steps
1. **Query current indexer cursor in Postgres**:
   ```sql
   SELECT * FROM indexer_cursors WHERE id = 'default';
   ```
2. **Fetch latest ledger from Soroban RPC**:
   ```bash
   curl -s -X POST $STELLAR_RPC_URL -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | jq .result.sequence
   ```
3. **Compare delta**:
   Calculate `latestLedger - last_ledger`.
   If delta > 17,280 ledgers (~24 hours), the public RPC rolling retention window has closed.

## Fix
1. **If lag is within retention window (< 24 hours)**:
   Trigger batch polling or restart the indexer process:
   ```bash
   sudo systemctl restart holdfast-indexer
   ```
2. **If lag exceeds retention window (> 24 hours)**:
   Point `STELLAR_RPC_URL` temporarily to an archive RPC node (e.g., Hubble, SDF archive node, or private validator archive), and initiate backfill:
   ```bash
   pnpm --filter @holdfast/worker backfill -- --start-ledger <LAST_SAVED_LEDGER>
   ```
3. Once backfill reaches current ledger, point `STELLAR_RPC_URL` back to standard RPC node and resume continuous polling.

## How to Verify
1. Verify `indexer_lag_ledgers` metric:
   ```bash
   curl -s http://localhost:3001/metrics | jq .indexer_lag_ledgers
   ```
   Ensure lag drops below 5.
2. Verify recent on-chain test transaction appears in `order_events`:
   ```sql
   SELECT * FROM order_events WHERE note->>'on_chain_event' = 'true' ORDER BY created_at DESC LIMIT 5;
   ```
