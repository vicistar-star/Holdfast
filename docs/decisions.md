# Holdfast — Design Decisions

This file records every open question and every significant design choice.
Add a row to the decision log whenever a material choice is made.
Open questions must not be silently decided in code — implement the simplest
reversible option behind config, and record the assumption here.

---

## Open questions from the README

### Arbiter timeout

**Status: open**

If the arbiter never resolves a dispute, what happens?

Options: (a) default split after N days, (b) escalation to a second arbiter,
(c) funds remain frozen indefinitely.

**Current implementation assumption:** funds remain frozen until the arbiter acts.
There is no on-chain timeout. This is the simplest and most conservative option —
no funds move without an explicit human decision.

ASSUMPTION: no arbiter timeout. The product risk is that disputes can be
permanently frozen if the arbiter key is lost. Mitigated in v1 by a multisig
arbiter with hardware keys and a clear key-recovery procedure. Revisit when
dispute volume grows or if a timeout becomes a legal requirement.

---

### Upgradeability

**Status: open**

Should the contract be upgradeable (easier to fix bugs) or immutable (stronger
trust guarantees)?

**Current implementation assumption:** the contract is immutable. No upgrade
mechanism is implemented. This is the simpler option and avoids introducing an
upgrade-authority trust assumption before an audit.

ASSUMPTION: immutable contract for v1. If a critical bug is found, the mitigation
is to pause the contract and deploy a new one — existing orders must be settled
manually if they are in a non-terminal state. Revisit before mainnet if the audit
recommends an upgrade path.

---

### Partial release

**Status: open**

Should buyers be able to accept part of an order (partial delivery), or is
the order all-or-nothing?

**Current implementation assumption:** all-or-nothing. A buyer either confirms
full delivery or opens a dispute. Partial release would require a new state and
new functions. Revisit based on pilot feedback.

---

### Price convention in Mode B

**Status: open**

In on-chain USDC escrow (Mode B), should prices be quoted in USD (seller's naira
payout varies) or should the local-currency value be locked at payment time
(seller's USD value varies)?

**Current implementation assumption:** Mode B is not live. This question will be
decided before Mode B launches. Do not implement a convention until the decision
is made.

---

### Fee model

**Status: open**

Percentage with a minimum? Who pays — seller, buyer, or split?

**Current implementation assumption:** percentage fee, paid from the seller's
payout (fee deducted at release or from seller share at dispute resolution).
Refunds are always fee-free. Fee in basis points, configurable via `set_fee_bps`,
capped at 500 bps (5%) in code. There is no minimum per-order fee in v1.
Revisit based on unit economics from the pilot.

---

### Buyer identity

**Status: open**

How much verification, if any, should buyers need above a certain order size?

**Current implementation assumption:** buyers provide only a phone number (OTP
verified). No ID check for buyers in v1. Revisit if buyer-side fraud becomes
a pattern in the pilot.

---

## Decision log

| Date | Decision | Alternatives | Reason | Revisit when |
|------|----------|--------------|--------|--------------|
| 2026-10-25 | Mode A first | Mode B first | Lower regulatory risk, no stablecoin legs, faster to ship | After pilot data |
| 2026-10-25 | Human arbiter only | Panel, automation | Learn dispute rules before automating | Dispute volume grows |
| 2026-10-25 | Custodial wallets in v1 | Passkey wallets | Faster to ship; users never see the chain | Phase 3+ |
| 2026-10-25 | Immutable contract (no upgrade mechanism) | Upgradeable with governance | Simpler trust model before audit | Before mainnet |
| 2026-10-25 | No arbiter timeout | Default split, escalation | Most conservative; no funds move without human sign-off | Legal requirement or dispute volume |
| 2026-10-25 | All-or-nothing orders | Partial release | Simpler state machine; revisit from pilot | Pilot feedback |
| 2026-10-25 | Fee rounds down (floor division) | Round half-up, ceiling | Matches Rust i128 truncation; consistent across TS and contract | Any fee model change |
| 2026-10-25 | Fee charged on seller payout only; refunds are fee-free | Fee on both sides | README rule 6; aligns incentive with delivery | Product decision |
| 2026-10-27 | webhook_events table added (not in README schema) | Rely on application-level dedup | DB UNIQUE on (provider, event_id) is the simplest safe idempotency guarantee; survives restarts and race conditions | Never — this is a hard requirement |
| 2026-10-27 | reconciliation_issues table added (not in README schema) | Log-only reconciliation | Structured table enables dashboards, alerting, and audit queries without log parsing | If a different reconciliation architecture is chosen |
| 2026-10-27 | JWT implemented with Node crypto (no @fastify/jwt) | @fastify/jwt plugin | Plugin not in lockfile; avoiding new installs to keep the build fast; HS256 with timingSafeEqual is correct and reviewable | If RS256 or rotating keys are needed |
| 2026-10-27 | OTP store in-memory for v1 dev | Redis TTL key | Simpler; single-process dev only. Redis store is the production path — implement before multi-process deploy | Before horizontal scale |
| 2026-10-27 | LocalDevKeyStore uses AES-256-GCM with env master key | KMS from day 1 | KMS stub requires AWS credentials; local dev must work offline. KmsKeyStore stub is present and throws loudly | Before any staging/production deploy |
| 2026-10-27 | Buyer access via signed order token (no buyer account) | Require buyer account creation | README: "No buyer account needed". Order token scoped to one order, expires in 24h | If buyer accounts are added |
| 2026-10-27 | Mock payment provider only; no real partner endpoints | Stub real endpoints | README: never fabricate partner API details. Real adapters added when partner agreements are signed | When a real partner is confirmed |
| 2026-10-29 | indexer_cursors table added (not in README schema) | File or memory cursor | Persisting RPC cursor in Postgres survives worker restarts and guarantees at-least-once event processing | Never — required for crash recovery |
| 2026-10-29 | notification_deliveries table added (not in README schema) | In-memory dedup cache | DB unique index on dedup_key guarantees that no recipient is notified twice for the same event | Never — required for idempotency |
| 2026-10-29 | MinIO in docker-compose for S3-compatible dev storage | Local filesystem storage | MinIO implements real AWS S3 API; exercises identical S3 client code across dev, test, and production | Before production deployment |
| 2026-10-29 | OTP_DEV_ECHO flag in dev/test | SMS provider in test | Permits deterministic e2e automation in dev/test without leaking OTP in production | Production |
| 2026-10-29 | Second-approver check is config-flagged on dispute resolve | Multi-user approval workflow | Simple, reversible option behind SECOND_APPROVER_THRESHOLD_MINOR per prompt and README | When dispute volume demands multi-role sign-off |
| 2026-10-29 | Playwright E2E with network routing mocks | Full backend live stack in E2E | Deterministic test execution against production Next.js build; decouples browser testing from ephemeral external services | When staging env is provisioned |
| 2026-10-29 | Seller token persisted to localStorage with offline banner | In-memory only state | Enables installable PWA behavior across mobile page reloads while alerting seller when offline | Never — core PWA requirement |
| 2026-10-29 | Server-rendered dynamic SVG badges at /badge/:handle.svg | Client-side Canvas/DOM image | Instant cacheable badge embedding for seller Instagram/WhatsApp links with zero external asset dependencies | Never — optimized for fast load |
