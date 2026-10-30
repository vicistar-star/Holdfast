# Holdfast — Threat Model & Security Specification

This document defines the security architecture, threat model, mitigation strategies, and residual risks for Holdfast, using the product specification and Nigerian DM commerce environment as the baseline.

---

## 1. System Overview & Trust Boundaries

Holdfast is an escrow platform for social commerce (Instagram and WhatsApp) sellers, launching in Nigeria first.

```
[ Buyer (WhatsApp/Web) ] <─── HTTPS ───> [ Fastify API / Next.js Web ]
                                                   │
                ┌──────────────────────────────────┴──────────────────────────────────┐
                │                                                                     │
                ▼                                                                     ▼
      [ PostgreSQL + Redis ]                                               [ Payment Partner Rails ]
      - Strict state machine                                               - Virtual accounts (Mode A)
      - Append-only audit log                                              - Escrow holding
      - Encrypted credentials                                              - Bank disbursements
                │                                                                     │
                ▼                                                                     ▼
      [ Stellar / Soroban ]                                                [ KYC / Identity Rails ]
      - Mode A: state & reputation                                         - Phone OTP
      - Mode B: USDC escrow                                                - ID/BVN lookup references
      - Sponsored transactions                                             - Bank account name match
```

### Trust Zones
1. **Public Zone**: Untrusted web/mobile clients (buyers and sellers interacting via browser/PWA).
2. **Application Core**: Fastify API, BullMQ background workers (keeper, indexer), and Postgres/Redis data stores.
3. **Partner Rails**: Licensed payment partners (Paystack, Flutterwave, Monnify, Squad, Korapay) and KYC providers (Smile ID, Dojah, Prembly).
4. **Decentralized Layer**: Stellar Network and Soroban smart contract instances.

---

## 2. Protected Assets

| Asset | Description | Sensitivity |
|---|---|---|
| **Customer Funds** | Fiat balances (NGN) held in partner escrow accounts or USDC locked in Soroban contracts | High (Direct financial loss) |
| **Arbiter Signing Key** | Ed25519 key authorized to execute `resolve_dispute` and distribute disputed escrow funds | Critical (Can divert disputed balances) |
| **Admin Signing Key** | Stellar key authorized to pause, unpause, and adjust fees | High (Can disrupt operations) |
| **Sponsor & Keeper Keys**| Stellar keypairs funding gas/reserve sponsorship and automating permissionless timeouts | Medium (Gas draining risk) |
| **Partner Webhook Secrets** | Shared HMAC keys (`PAYMENT_WEBHOOK_SECRET`) authenticating payment and payout events | High (Can trigger fake order funding) |
| **User Identity & PII** | Phone numbers, verified payout bank details, and provider verification references | High (Privacy & regulatory compliance) |
| **Evidence Media** | Photos, videos, and waybill receipts stored in S3/MinIO evidence storage | Medium (Integrity of dispute arbitration) |
| **Audit Logs** | Immutable `order_events` table documenting every state transition | Critical (Forensics & financial reconciliation) |

---

## 3. Threat Actors

- **Malicious / Mule Sellers**: Criminals setting up disposable accounts or burner shops to harvest funds without delivering goods.
- **Fraudulent Buyers**: Buyers who receive legitimate goods but falsely claim non-delivery or open frivolous disputes.
- **Collusive Rings**: Buyer and seller collaborating to game reputation scores or exploit promotional referral loops.
- **External Network Attackers**: Attackers attempting brute-force slug enumeration, OTP interception, SQL injection, path traversal, or DoS.
- **Compromised Insider**: A rogue administrator or arbiter attempting unauthorized fund diversion.

---

## 4. Threat Matrix & Mitigations

### 4.1 Commerce & Fraud Threats

| Threat | Impact | Implemented Mitigation |
|---|---|---|
| **Empty Box / Fake Waybill** | Buyer loses funds | 1. Progressive seller KYC tiers (Tier 0–3).<br>2. Payout caps on new sellers with extended holding windows.<br>3. Shipping evidence (photos, tracking receipts) required.<br>4. Streaming SHA-256 hash validation on upload. |
| **False Non-Delivery Claim** | Seller loses payout | 1. Dispute opening strictly bounded by `shipped_at + review_secs`.<br>2. Human arbiter inspects shipping receipt and courier confirmation.<br>3. Buyer-side dispute history tracking to detect serial disputers. |
| **Mule Accounts & Fake Names** | Fraudulent seller eludes recovery | 1. Payout account bank verification requires fuzzy name matching against verified KYC identity.<br>2. Account name mismatches block payout registration. |
| **Off-Platform Circumvention** | Fee evasion | 1. High value proposition: public trust badge and dispute guarantee.<br>2. Automated reputation scoring rewarding verified transaction history. |

### 4.2 Application & Infrastructure Threats

| Threat | Impact | Implemented Mitigation |
|---|---|---|
| **Webhook Forgery / Replay** | Unauthorized order funding | 1. HMAC-SHA256 signature verification with `crypto.timingSafeEqual`.<br>2. `webhook_events` enforces a UNIQUE constraint on `(provider, event_id)` for guaranteed idempotency.<br>3. Terminal state guards reject out-of-order mutations. |
| **Slug Enumeration / Bot Probing** | Link harvesting / DoS | 1. Nanoid-based high-entropy link slugs.<br>2. In-memory and Redis rate limiting on order creation, OTP, and evidence endpoints. |
| **Path Traversal in Evidence Upload** | Arbitrary file overwrite | 1. Strict filename sanitization (`replace(/[^a-zA-Z0-9._-]/g, "_")`).<br>2. Path resolution validation ensuring all storage keys reside strictly inside the sandboxed evidence directory.<br>3. MIME-type allowlist and 25 MB stream ceiling. |
| **Sponsor Pool Drainage** | Service interruption on-chain | 1. Per-account daily stroops spend budget (`perAccountDailyStroops`).<br>2. Automated `onLowBalance` alerting when sponsor balance drops below safety reserve. |
| **PII Leakage in Logs** | Regulatory infraction (NDPR) | 1. Structured JSON logging via pino with automatic PII masking (phone numbers, account numbers, secrets).<br>2. No raw BVN or NIN stored in database. |
| **SQL Injection** | Database compromise | 1. Strict typed queries with Drizzle ORM parameterization.<br>2. Zero raw unsanitized SQL string concatenation. |

---

## 5. Dependency Audit & Supply Chain Security

Holdfast routinely audits all ecosystem dependencies:
- **TypeScript**: `pnpm audit` scans Node packages. Known advisories in transitive packages (such as Next.js preview or bundler tools) are isolated to frontend rendering and strictly prohibited from handling signing keys.
- **Rust**: `cargo audit` scans the Soroban smart contract crate tree against the RustSec Advisory Database.
  - *Identified Advisory*: `crypto-bigint 0.5.5` (pulled transitively via `soroban-env-host` 27.0.1). Soroban contract execution is fully deterministically sandboxed in WASM by the Stellar Host environment, mitigating host-level timing attacks.

---

## 6. Residual Risks & Pre-Mainnet Requirements

1. **Formal Smart Contract Audit**: An independent third-party audit of `contracts/escrow` is non-negotiable prior to locking real funds.
2. **KMS / HSM Key Storage**: In development, local keys are used; in staging and production, arbiter and sponsor keys MUST reside in AWS KMS or a certified HSM.
3. **Partner License Due Diligence**: Nigerian banking partner licenses and virtual asset regulatory updates must be continually reviewed before activating live naira rails.
