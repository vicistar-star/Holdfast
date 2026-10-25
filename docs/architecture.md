# Holdfast — Architecture

This document restates the system architecture from the README and records the
invariants that every contributor must preserve.

---

## System overview

```
Clients (Next.js)          Backend (Fastify / Node)       Stellar
─────────────────          ────────────────────────       ───────
Buyer pay page        →    API                       →    Soroban RPC
Seller dashboard      →    ├─ Postgres (system of record)      │
Admin console         →    ├─ Redis / BullMQ queues            ↓
                           ├─ Keeper worker            Escrow contract
                           ├─ Event indexer            (state machine)
                           ├─ Notification worker
                           └─ Sponsor service

Partners: payment provider, KYC provider, WhatsApp/SMS
Storage:  S3-compatible (evidence with SHA-256 hashes)
```

**Design principles (from README)**

1. The contract owns the rules; Postgres owns the queries.
2. Time-based actions (`claim_auto_release`, `claim_refund`) are permissionless — a
   dead keeper can never strand funds.
3. Users never touch the chain — fees and reserves are sponsored.
4. Everything is idempotent — webhooks, keeper submissions, and indexer reads can be
   retried safely.
5. Start small and stay human — low order caps, KYC-tiered sellers, human arbiter.

---

## Escrow modes

| Mode | Who holds funds | Contract role |
|------|----------------|---------------|
| A (v1 default) | Licensed payment partner | State transitions + reputation source |
| B (testnet only until audited) | Soroban contract (USDC) | Full trust-minimised custody |

Mode is selected via `ESCROW_MODE=A\|B` in `.env`.

---

## Order state machine

States: `Funded → Shipped → Released`  
                 `→ Disputed → Resolved`  
       `Funded → Refunded`

```
[*] → Funded         create_and_fund (buyer)
Funded → Shipped     mark_shipped (seller, before ship_by)
Funded → Refunded    claim_refund (anyone, after ship_by)
Shipped → Released   confirm_delivery (buyer)
                     claim_auto_release (anyone, after review window)
Shipped → Disputed   open_dispute (buyer, inside review window)
Disputed → Resolved  resolve_dispute (arbiter)
Released → [*]
Refunded → [*]
Resolved → [*]
```

Terminal states — **Released**, **Refunded**, **Resolved** — are final. No function
may transition an order out of a terminal state.

---

## Roles

| Role | Identified by | Permitted actions |
|------|--------------|-------------------|
| Buyer | Address on order | `confirm_delivery`, `open_dispute` |
| Seller | Address on order | `mark_shipped` |
| Arbiter | Contract-level address (multisig) | `resolve_dispute` |
| Admin | Contract-level address (multisig) | `set_fee_bps`, `set_treasury`, `pause`, `unpause` |
| Anyone | Any address | `claim_auto_release`, `claim_refund`, read functions |

---

## Invariants (non-negotiable)

These must not be weakened by any change to the contract or backend.

1. **State before transfers.** In every contract function, state is written to its
   final value before any token transfer is made.
2. **Conservation.** For every terminal state, the sum of all payouts equals the
   funded amount exactly. No money is created or destroyed.
3. **Fee rounding.** Fee rounds down (integer division). The remainder goes to the
   seller (or buyer on refund — refunds are fee-free). Formula: `fee = amount * fee_bps / 10_000`.
4. **Fee cap.** `fee_bps` is capped at 500 (5%) in contract code. `set_fee_bps`
   rejects values above this.
5. **Fees on payouts only.** Refunds are always fee-free. In dispute resolution, the
   fee is charged on the seller's share only.
6. **Pause never traps funds.** `pause()` blocks `create_and_fund` only. Every
   settlement function (`confirm_delivery`, `claim_auto_release`, `claim_refund`,
   `resolve_dispute`) remains callable while paused.
7. **Terminal states are final.** No contract function may transition an order out
   of Released, Refunded, or Resolved.
8. **TTL extension.** Every order write extends the storage entry's TTL to at least
   the maximum possible order lifetime, so archival can never strand funds.
9. **Authorization.** Every role check calls `require_auth()` on the address stored
   in the order or contract state — never on a caller-supplied address.
10. **Integer money.** All amounts are `i128` on-chain and `bigint` in TypeScript.
    No floats are used for monetary values anywhere.
11. **Append-only audit log.** `order_events` rows are never updated or deleted.
12. **No raw identity data.** BVN, NIN, and ID document data are never stored. Only
    verification results and provider references are kept.

---

## Off-chain services

| Service | Purpose | Failure mode |
|---------|---------|-------------|
| Keeper | Submits `claim_refund` and `claim_auto_release` on time | Permissionless — anyone can call; keeper failure delays but doesn't trap |
| Event indexer | Polls Soroban RPC, writes `order_events`, updates `orders` projection | Must run continuously; cursor persisted; provider must retain adequate history |
| Sponsor | Pays Stellar fees and reserves, creates USDC trustlines | Key in KMS/HSM in production; spending limits enforced |
| Notification worker | WhatsApp + SMS order event messages | SMS fallback; failure is non-blocking for settlement |

---

## Package layout

```
holdfast/
├── contracts/escrow/          Soroban contract (Rust)
├── apps/api/                  Fastify API (TypeScript)
├── apps/web/                  Next.js — pay page, seller PWA, admin console
├── apps/worker/               Keeper, indexer, notifications, sponsor
├── packages/contract-client/  Typed TypeScript wrapper for the contract
├── packages/db/               Drizzle schema + migrations
├── packages/shared/           Types, money helpers, validation
├── infra/                     docker-compose, Terraform (later)
├── docs/                      Architecture, decisions, runbooks
└── scripts/                   deploy-testnet.sh, seed.ts
```
