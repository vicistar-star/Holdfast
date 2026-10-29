# Runbook: Soroban RPC Event Indexer & Backfill

## Overview

The Holdfast event indexer continuously polls Soroban RPC `getEvents` to index on-chain contract transitions into the Postgres `order_events` append-only audit log and update the `orders` projection table.

## Soroban RPC History-Window Limitation

Public Stellar and Soroban RPC nodes (such as `https://soroban-testnet.stellar.org`) maintain a **rolling history window** of recent ledgers (typically ~24 hours, or approximately 17,280 ledgers).

### Operational Constraints

1. **Continuous Operation**: The indexer worker must run continuously to keep pace with the chain tip and persist its cursor in `indexer_cursors`.
2. **Prolonged Outages (> 24 hours)**: If the indexer is offline longer than the RPC retention window, querying from the last saved ledger will return an error indicating that the requested ledger is outside the available history.
3. **Recovery Beyond the Window**: To backfill events older than the rolling window, switch `STELLAR_RPC_URL` temporarily to an archive-enabled Soroban RPC provider (or an archive instance / Hubble / SDF archive node) before triggering a backfill.

## Running the Backfill Command

To replay events from a specific start ledger:

```bash
# In apps/worker:
pnpm --filter @holdfast/worker backfill -- --start-ledger <START_LEDGER>
```

Or via direct script:

```bash
node --experimental-strip-types apps/worker/src/backfill.ts --start-ledger 5421000
```

### Idempotency & Safety Guarantees

- **No Duplication**: Replaying events already processed produces identical state; existing `(order_id, to_status, tx_hash)` entries are deduplicated.
- **Monotonic State Machine**: Terminal states (`Released`, `Refunded`, `Resolved`) cannot be regressed by replaying older events.
- **Append-only Compliance**: Existing `order_events` rows are never mutated or deleted.
