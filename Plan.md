# Holdfast: Project Plan

Escrow for Instagram and WhatsApp sellers, built on Stellar / Soroban, launching in Nigeria first.

**Plan version:** 1.0 (October 2026)
**Planning assumption:** a solo founder or a team of 2 to 3, working full time. If you are part time, multiply durations by roughly 2.

---

## 1. Goal and success criteria

### Goal
Prove that sellers in Nigerian DM commerce will use a payment link with escrow protection, and that buyers will pay through it, **before** investing in scale, audits, or licences.

### What "success" means at each stage

| Stage | Success looks like |
|---|---|
| Validation (Phase 0) | 20+ sellers interviewed, 5+ commit to a pilot, a payment partner and a lawyer confirm the model is workable |
| Testnet MVP (Phase 1) | Full order lifecycle works end to end on testnet, including refund, auto-release and dispute |
| Closed pilot (Phase 2) | 10 sellers, 100+ real orders, under 5% dispute rate, zero lost funds |
| Trust layer (Phase 3) | Sellers display the badge, and at least 30% of pilot orders come from repeat buyers or sellers |
| Scale decision (Phase 4) | Go/no-go on audit, mainnet stablecoin escrow, and licensing, based on pilot data |

### Non-goals for v1
- Courier or dispatch tracking integrations
- A dispute panel or any automated arbitration
- Native mobile apps
- Multi-country support
- Public token or governance

---

## 2. Guiding decisions

These are settled unless the evidence says otherwise. Reopen them only at a phase gate.

1. **Start with Mode A.** Naira rails held by a licensed partner, with Soroban as the state and reputation layer. Stablecoin escrow (Mode B/C) comes later.
2. **Human arbiter first.** You or a teammate resolves every dispute by hand.
3. **Small orders only.** Cap order values low and raise them as the track record grows.
4. **Users never see the chain.** Fees and reserves are sponsored. No wallets or XLM for users.
5. **Build the contract regardless of partner answers.** It is useful in every mode, and the work doesn't depend on licensing outcomes.
6. **Collect reputation data from day one**, and build the public badge later.

---

## 3. Phase overview

```
Phase 0  Validate and de-risk        Weeks 1-3
Phase 1  Testnet MVP                 Weeks 3-9     (overlaps Phase 0)
Phase 2  Closed pilot                Weeks 10-17
Phase 3  Trust layer                 Weeks 15-21   (overlaps Phase 2)
Phase 4  Scale decision              Weeks 22-26
```

Phase 0's legal and partner work runs in parallel with the contract build, because the contract does not depend on the answers.

---

## 4. Phase 0: Validate and de-risk (Weeks 1-3)

**Objective:** find out whether the business is possible before writing much code.

### 4.1 Customer discovery
- [ ] Interview 20+ Instagram/WhatsApp sellers (fashion, beauty, electronics, thrift, food, phones, fragrances)
- [ ] Interview 10+ frequent buyers
- [ ] Questions to answer:
  - How do they get paid today, and what goes wrong?
  - How often do scams, non-delivery, or "wrong item" disputes happen?
  - How do they ship (dispatch riders, bus parks, couriers, pickup)?
  - What order values are typical?
  - Would they pay a fee (and how much) for protection?
  - Would buyers pay through a link they haven't seen before?
- [ ] Recruit 5 to 10 pilot sellers who commit in writing (a message is fine)

### 4.2 Payment partner discovery
- [ ] Talk to at least three collection providers (for example Paystack, Flutterwave, Monnify, Squad, Korapay)
- [ ] Ask each:
  - Can you hold funds for a set period, or settle on instruction?
  - Do you support per-order virtual accounts and pay-by-transfer?
  - What are the fees, settlement times, and payout API limits?
  - What is your licence status and who is your settlement bank?
  - What do you require from us (KYC on sellers, contracts, minimums)?
- [ ] Record answers in `docs/partner-evaluation.md` with a scoring table
- [ ] Choose a primary and a backup partner

### 4.3 Legal
- [ ] Engage a Nigerian fintech lawyer
- [ ] Questions to answer:
  - Does Mode A (partner holds funds, we instruct) need our own licence?
  - What agreement structure with the partner is required?
  - What are our obligations under the data protection law for BVN/NIN-based KYC?
  - How should terms, refund policy, and dispute policy be written?
  - What is the position for Mode B/C given the 2026 SEC/CBN developments?
- [ ] Get the answers in writing, and file them in `docs/legal/`

### 4.4 Business basics
- [ ] Decide the fee model (percentage with minimum, who pays)
- [ ] Rough unit economics: fee per order minus partner fees, payout fees, SMS/WhatsApp cost, and dispute cost
- [ ] Register the company if needed for partner onboarding
- [ ] Reserve the name, domain, and social handles

### Phase 0 exit gate
- [ ] At least 5 sellers committed to the pilot
- [ ] One payment partner willing to onboard us, with a clear answer on holding funds
- [ ] Legal opinion supports Mode A, or tells us what changes
- [ ] Unit economics are positive at the planned fee

**If the gate fails:** adjust the model (for example, move to a partner that does hold funds, or change who pays the fee) before continuing Phase 1 past the contract work.

---

## 5. Phase 1: Testnet MVP (Weeks 3-9)

**Objective:** the full order lifecycle works on testnet, with a human in the loop for disputes.

### 5.1 Smart contract (Weeks 3-5)

- [ ] Repo, workspace, CI (cargo test, lint) set up
- [ ] Define types, errors, events
- [ ] Implement:
  - [ ] `create_and_fund`
  - [ ] `mark_shipped`
  - [ ] `confirm_delivery`
  - [ ] `claim_auto_release`
  - [ ] `claim_refund`
  - [ ] `open_dispute`
  - [ ] `resolve_dispute`
  - [ ] Admin: `set_fee_bps`, `set_treasury`, `pause`, `unpause`
- [ ] TTL extension on every order write
- [ ] Order cap and fee cap enforced in code
- [ ] Tests:
  - [ ] Every transition, every rejection (wrong caller, wrong state, wrong time)
  - [ ] Time-based paths using ledger manipulation
  - [ ] Auth tests with and without signatures
  - [ ] Conservation property test (payouts always sum to funded amount)
  - [ ] Pause behaviour (blocks new orders, never blocks settlement)
- [ ] Deploy to testnet with a script
- [ ] Generate TypeScript bindings into `packages/contract-client`
- [ ] Write the design decisions into `docs/architecture.md`

**Exit:** all tests green, testnet deployment works from the CLI, bindings generated.

### 5.2 Backend core (Weeks 4-7)

- [ ] Monorepo setup: API, worker, shared packages
- [ ] Postgres schema and migrations (users, sellers, links, orders, order_events, evidence, disputes, payouts)
- [ ] Phone OTP auth
- [ ] Seller profile creation
- [ ] Payment link create/read
- [ ] Order state machine in the service layer, with the append-only `order_events` log
- [ ] Contract integration: build, simulate, submit transactions with the sponsor account
- [ ] Sponsor service: fee-bump, sponsored reserves, trustline creation, spending limits
- [ ] Payment partner adapter (sandbox first):
  - [ ] Create per-order payment instructions
  - [ ] Verified, idempotent webhooks
  - [ ] Payout and refund calls
  - [ ] Reconciliation job comparing partner records with our order table
- [ ] Keeper worker: refund on missed `ship_by`, auto-release after the review window
- [ ] Event indexer with a persisted cursor
- [ ] Notification worker (WhatsApp templates and SMS fallback)
- [ ] Evidence upload with SHA-256 hashing

### 5.3 Frontend (Weeks 6-9)

- [ ] Buyer pay page (mobile-first, light, works in in-app browsers)
- [ ] Order status page with confirm and dispute buttons
- [ ] Seller dashboard (PWA): create link, view orders, mark shipped, upload proof
- [ ] Admin console: dispute queue, case view, resolve form
- [ ] Clear copy for every state (what happens next, when funds release)

### 5.4 Integration and hardening (Weeks 8-9)

- [ ] End-to-end test script on testnet: happy path, refund, auto-release, dispute
- [ ] Failure injection: RPC down, partner webhook duplicated or out of order, keeper restart
- [ ] Basic monitoring and alerts: keeper lag, stuck orders, sponsor balance, webhook failures
- [ ] Seed data and a demo walkthrough
- [ ] Draft terms of service, refund policy, and dispute policy for lawyer review

### Phase 1 exit gate
- [ ] All four lifecycle paths pass end to end on testnet and sandbox
- [ ] No known state bug that could double-pay or strand a test order
- [ ] Reconciliation shows zero mismatches over a sustained test run
- [ ] Monitoring and alerts are working

---

## 6. Phase 2: Closed pilot (Weeks 10-17)

**Objective:** learn from real sellers and real money at low risk.

### 6.1 Pre-launch
- [ ] Partner production onboarding complete (contracts signed, production keys issued)
- [ ] Legal sign-off on terms, refund policy, dispute policy, privacy notice
- [ ] Seller KYC live with a provider, tier 0 to tier 1 working
- [ ] Payout account verification (name match against KYC)
- [ ] Order cap set low (for example ₦20,000 to ₦50,000 per order) and a daily payout cap per seller
- [ ] Longer payout holds for new sellers
- [ ] On-call routine and runbooks written: keeper down, partner outage, stuck order, wrong payout
- [ ] Support channel for pilot users (a WhatsApp number monitored daily)
- [ ] Decide what runs on mainnet vs testnet for the pilot:
  - **Mode A:** real naira through the partner, with contract events on testnet or mainnet (decide based on audit status and legal advice)

### 6.2 Pilot rollout
- [ ] Week 10: onboard 3 sellers, watch every order manually
- [ ] Week 11-12: grow to 10 sellers
- [ ] Weekly check-in with every seller (call or message)
- [ ] Review every order, every dispute, and every support request personally

### 6.3 What to measure

| Metric | Why it matters |
|---|---|
| Link views to payment conversion | Do buyers trust the page? |
| Payment to shipped time | Are sellers responsive? |
| Confirmed vs auto-released share | Do buyers engage or ignore? |
| Dispute rate and reasons | The core quality signal |
| Time to resolve a dispute | Arbiter workload and fairness |
| Refund rate (missed ship-by) | Seller reliability |
| Repeat seller usage | Is it worth the fee to them? |
| Off-platform bypass signals | Sellers sharing account details to skip the fee |
| Cost per order | Partner, messaging, and support cost |
| Support tickets per 100 orders | Where the product is confusing |

### 6.4 Learn and adjust
- [ ] Write dispute precedents after every case
- [ ] Refine the dispute policy and the review/ship windows by delivery type
- [ ] Fix the top three friction points each week
- [ ] Keep a pilot log in `docs/pilot-log.md`

### Phase 2 exit gate
- [ ] 100+ real orders completed
- [ ] Dispute rate under 5% and every dispute resolved within the target time
- [ ] No lost, stuck, or double-paid funds
- [ ] At least 6 of 10 sellers still active after 4 weeks
- [ ] At least 3 sellers say they would pay or already pay the fee knowingly

**If the gate fails:** pause growth. Fix the specific failure (trust, shipping, fee, partner reliability), then rerun a smaller pilot.

---

## 7. Phase 3: Trust layer (Weeks 15-21)

**Objective:** turn the data from the pilot into the feature that makes sellers stay.

- [ ] Reputation computation from indexed events:
  - [ ] Completed orders, volume band, dispute rate, disputes lost
  - [ ] Median time to ship, median response time
  - [ ] Minimum sample size, smoothing for small samples, recency weighting
- [ ] Public seller profile page (`/s/{handle}`)
- [ ] Shareable SVG badge endpoint for Instagram bios and WhatsApp profiles
- [ ] Separate "Verified" marker (KYC) from performance indicators
- [ ] Seller tier upgrades from track record (higher caps, shorter holds)
- [ ] Evidence improvements: guided photo/video prompts at shipping
- [ ] Published dispute policy page and a "how Holdfast protects you" page for buyers
- [ ] Referral flow: buyers see "sell with Holdfast" after a good experience
- [ ] Review anti-gaming measures: self-dealing detection, repeat buyer-seller loops, fake orders

### Phase 3 exit gate
- [ ] Sellers actively share the badge
- [ ] Measurable lift in link conversion for sellers with a badge
- [ ] No successful gaming of the score found in review

---

## 8. Phase 4: Scale decision (Weeks 22-26)

**Objective:** decide what to invest in next, using pilot evidence.

### Decisions to make

| Decision | Inputs |
|---|---|
| Commission an external contract audit? | Is on-chain custody (Mode B/C) worth it, based on pilot demand and legal advice |
| Move to Mode B/C (USDC escrow)? | Demand from crypto-native users, conversion costs, SEC/CBN rules by then |
| Seek a CBN sandbox slot or own licence? | Volume, legal advice, cost vs partnering |
| Raise funding? | Pilot metrics, unit economics, growth path |
| Expand to more sellers or categories? | Dispute rate by category, support load |
| Automate parts of dispute handling? | Dispute volume and precedent quality |
| Add courier tracking? | Which dispatch and courier options are reliable enough |
| Second country? | Partner and ramp availability, regulation, language |

### Work
- [ ] Pilot retrospective document
- [ ] Updated unit economics and 12-month plan
- [ ] If proceeding with on-chain custody:
  - [ ] Audit scoping and quotes, audit scheduled
  - [ ] Multisig and hardware-key setup for arbiter and admin
  - [ ] KMS/HSM for sponsor and keeper keys
  - [ ] Bug bounty design
  - [ ] Mainnet checklist from the README completed

---

## 9. Workstreams and ownership

If you are solo, this is your task order. If you have a team, it's the split.

| Workstream | Owner (suggested) | Key deliverables |
|---|---|---|
| Contract and chain | Rust/Soroban engineer | Contract, tests, deployment scripts, bindings, audit liaison |
| Backend and integrations | Backend engineer | API, workers, partner and KYC adapters, reconciliation |
| Frontend and product | Full-stack / designer | Pay page, dashboard, admin console, copy |
| Operations and disputes | Founder | Arbiter role, support, policies, partner relationships |
| Legal and compliance | Lawyer (external) | Opinions, terms, agreements, data protection |

---

## 10. Dependencies

| Dependency | Needed by | Risk if late | Mitigation |
|---|---|---|---|
| Payment partner agreement | Start of Phase 2 | Pilot can't take real money | Start talks in Week 1, keep a backup partner |
| Legal opinion | Phase 2 pre-launch | Launch blocked, or legal exposure | Engage a lawyer in Week 1 |
| WhatsApp template approval | Phase 1 integration | Delayed notifications | Apply early, use SMS as fallback |
| KYC provider onboarding | Phase 2 pre-launch | Can't verify sellers | Sandbox first, apply for production early |
| Sellers willing to pilot | Phase 2 | No data | Recruit during discovery |
| Stellar RPC provider | Phase 1 | Indexer gaps | Choose a provider with adequate history, persist cursor |
| Audit slot | Before any on-chain custody | Mainnet delay | Book early once Phase 4 decision is made |

---

## 11. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| 1 | No licensed partner will hold funds for us | Medium | High | Talk to several early, consider alternate structures, adjust before building integrations | Founder |
| 2 | Regulatory change or enforcement during pilot | Medium | High | Lawyer on retainer, small scale, partner-led custody, track SEC/CBN updates | Founder |
| 3 | Sellers fake shipping evidence | High | Medium | KYC tiers, caps, payout holds, evidence hashing, seller dispute history | Backend |
| 4 | Buyers falsely claim non-delivery | Medium | Medium | Shipping proof required, dispute only in the window, buyer dispute tracking | Ops |
| 5 | Dispute volume overwhelms the arbiter | Medium | Medium | Small order caps, slow rollout, clear policy, templates for common cases | Ops |
| 6 | Keeper or indexer failure leaves orders stuck | Medium | High | Permissionless timeouts, alerts, runbooks, redundancy | Backend |
| 7 | Contract bug locks or loses funds | Low (testnet), High impact | High | Extensive tests, no on-chain custody until audited, caps, pause | Contract |
| 8 | Sponsor account drained or key leaked | Low | High | Spending limits, KMS/HSM, alerts, minimal balance | Backend |
| 9 | Sellers bypass the platform after the first order | High | Medium | Make the badge and buyer protection worth the fee, track repeat pairs | Product |
| 10 | Buyers don't trust an unknown payment page | High | High | Seller-introduced links, clear branding, visible protections, name on page | Product |
| 11 | In-app browser quirks break the pay page | Medium | Medium | Test on real devices, keep the page light, avoid exotic APIs | Frontend |
| 12 | Partner outage blocks payouts | Medium | Medium | Backup partner, status page, communication templates | Backend |
| 13 | Personal data breach | Low | High | Minimal data, encryption, access controls, no raw ID storage | Backend |
| 14 | Unit economics don't work | Medium | High | Validate in Phase 0, adjust fee model, reduce messaging cost | Founder |
| 15 | Founder bandwidth (solo) | High | Medium | Cut scope, use hosted services, focus on one workstream per week | Founder |

---

## 12. Budget estimate (rough, planning only)

Costs vary a lot. Use this as a checklist of what to price, not as quotes.

| Item | Phase | Notes |
|---|---|---|
| Legal (fintech counsel) | 0, 2 | Opinion, terms, partner agreement review |
| Company registration | 0 | If not already done |
| Hosting, database, Redis, storage | 1+ | Small at pilot scale |
| Stellar sponsor account funding | 1+ | XLM for fees and reserves, small at pilot scale |
| WhatsApp and SMS | 1+ | Per-message cost, depends on volume and templates |
| KYC checks | 2 | Per-verification cost |
| Payment partner fees | 2 | Per transaction, usually passed through in the fee |
| Monitoring and error tracking | 1+ | Free or low tiers at first |
| Domain, email, design assets | 0 | Small |
| Smart contract audit | 4 | Largest single item, defer until the decision |
| Bug bounty reserve | 4+ | After audit |
| Dispute and support time | 2+ | Your time or a part-time hire |

---

## 13. Milestone calendar

| Week | Milestone |
|---|---|
| 1 | Discovery interviews start, lawyer engaged, partner talks begin, repo created |
| 2 | 10+ interviews done, partner shortlist scored |
| 3 | **Phase 0 gate.** Contract implementation starts |
| 5 | Contract complete with tests on testnet |
| 7 | Backend lifecycle complete on sandbox, keeper and indexer running |
| 9 | **Phase 1 gate.** Pay page, dashboard, and admin console working end to end |
| 10 | First 3 pilot sellers live |
| 12 | 10 sellers live |
| 14 | Mid-pilot review, policy updates |
| 17 | **Phase 2 gate.** 100+ orders, dispute and fund-safety review |
| 19 | Public profiles and badge live |
| 21 | **Phase 3 gate** |
| 26 | **Phase 4 decision.** Audit, mode, licensing, funding |

---

## 14. Weekly operating rhythm

- **Monday:** review last week's metrics, disputes, and incidents. Pick the week's top three goals.
- **Daily:** check keeper lag, stuck orders, webhook failures, sponsor balance, and the dispute queue.
- **Wednesday:** one seller conversation and one buyer conversation, even during build phases.
- **Friday:** demo what shipped, update `docs/pilot-log.md`, update the risk register, and decide what to cut or defer.
- **Monthly:** reconcile partner statements against the order table, review costs, and review legal or regulatory updates.

---

## 15. Definition of done

A feature is done only when all of these are true:

- [ ] Works on testnet and sandbox end to end
- [ ] Has automated tests for the happy path and the main failure paths
- [ ] Emits the right events and audit log entries
- [ ] Has monitoring or alerting if it can fail silently
- [ ] Has user-facing copy that explains the state and next step
- [ ] Is documented in `docs/` if it changes behaviour or operations
- [ ] Doesn't weaken any invariant (conservation, finality of terminal states, pause never trapping funds)

---

## 16. Incident and fund-safety rules

These apply from the first real naira.

1. **A stuck or wrong payment is a Sev-1.** Stop other work until it's understood.
2. **Pause new orders first, investigate second.** Settlement paths stay open.
3. **Reconcile daily** during the pilot: partner balance vs held orders vs payouts.
4. **Two-person rule** for any manual payout, refund, or arbiter resolution above a threshold, once there are two people.
5. **Tell affected users quickly** with a plain explanation and a timeline.
6. **Write a short post-incident note** for every Sev-1 or Sev-2 and add a regression test.

---

## 17. Immediate next actions (this week)

1. [ ] Create the repo (`holdfast`), add the README and this plan
2. [ ] Book 10 seller interviews and write the interview script
3. [ ] Email or call three payment providers with the "can you hold funds?" question
4. [ ] Contact two Nigerian fintech lawyers and book a first call
5. [ ] Set up the Rust workspace and write the contract types, errors, and the first two tests (`create_and_fund`, `mark_shipped`)
6. [ ] Generate a testnet deployer identity and confirm you can deploy a trivial contract
7. [ ] Start the WhatsApp Business account and template application
8. [ ] Open `docs/decisions.md` and record the open questions from the README (arbiter timeout, fee model, price convention, upgradeability)

---

## 18. Decision log (maintain as you go)

| Date | Decision | Alternatives considered | Reason | Revisit when |
|---|---|---|---|---|
| | Mode A first | Mode B first | Lower cost, lighter regulation | After pilot |
| | Human arbiter | Panel / automation | Learn rules first | Dispute volume grows |
| | Custodial wallets in v1 | Passkey wallets | Faster to ship | Phase 3+ |
| | Buyer confirmation + timer | Courier tracking | Tracking unreliable | Reliable partners found |

Add a row every time a significant choice is made.
