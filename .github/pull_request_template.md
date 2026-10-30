## Description
<!-- Provide a clear, concise summary of the changes introduced by this pull request. -->

## Changes Made
- 

## Invariant Compliance Checklist
- [ ] Order states remain strictly: `Funded`, `Shipped`, `Released`, `Refunded`, `Disputed`, `Resolved` (no new states added)
- [ ] Contract methods strictly match the specification table in `README.md`
- [ ] Conservation of funds preserved: payouts sum exactly to order amount across all terminal paths
- [ ] State updated before token transfer / payout instructions in all mutating functions (Rule 8)
- [ ] Storage TTL extended on every contract write
- [ ] Monetary amounts represented strictly as integer minor units (never floats)
- [ ] `order_events` remains append-only (no update or delete queries)
- [ ] No raw BVN, NIN, or ID documents stored or logged
- [ ] No real secrets or private keys committed

## Verification & Tests Executed
<!-- List the exact commands run and paste test results proving this PR works. -->
```bash
make test
pnpm lint
pnpm typecheck
```

## Related Issues / Decision Records
<!-- Reference relevant issues or docs/decisions.md entries -->
Fixes #
