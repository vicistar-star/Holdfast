# Contributing to Holdfast

Thank you for contributing to Holdfast! This guide provides everything you need to know to get started, set up your development environment, run tests, and submit reviewable pull requests.

---

## 1. Non-Negotiable Core Rules

Before modifying code, review the non-negotiable invariants defined in `README.md`:
1. **Order states**: Exactly `Funded`, `Shipped`, `Released`, `Refunded`, `Disputed`, `Resolved`. Do not add custom states.
2. **Contract functions**: Strictly match the README specification table. Do not add public contract methods without architectural approval.
3. **Conservation**: All payouts in terminal states must sum exactly to the funded order amount.
4. **State before transfer**: Update database and contract state before executing token transfers or partner payouts.
5. **No floating point money**: All monetary values are integer minor units (bigint in TypeScript, i128 in Rust).
6. **Append-only logs**: `order_events` is append-only. Never update or delete rows.
7. **No PII**: Never store raw BVN or NIN; store verification results and provider references only.
8. **No secrets in git**: Sponsor and keeper secrets in `.env` are strictly for local development.

---

## 2. Development Setup

### Prerequisites
- Node.js 20+ (Node 24 recommended)
- pnpm 9+ (`npm i -g pnpm`)
- Rust stable + `wasm32v1-none` target (`rustup target add wasm32v1-none`)
- Stellar CLI (`https://developers.stellar.org/docs/tools/cli`)
- Docker & Docker Compose (for local Postgres, Redis, MinIO)

### Fast Setup
```bash
# 1. Clone repository
git clone https://github.com/vicistar-star/Holdfast.git
cd Holdfast

# 2. Automated setup (copies .env.example, installs dependencies, adds wasm target)
make setup

# 3. Start local infrastructure (Postgres, Redis, MinIO)
make docker-up

# 4. Run database migrations and seed demo data
pnpm db:migrate
pnpm --filter @holdfast/db seed

# 5. Run all tests
make test
```

---

## 3. Workflow & Verification

Always run all test suites before pushing:
```bash
# Linting & Typechecking
pnpm lint
pnpm typecheck

# Contract tests & clippy
make contract-test
make contract-clippy

# TypeScript unit & integration tests
pnpm test
```

---

## 4. Pull Request Guidelines

1. **Small, atomic commits**: Follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).
2. **Write tests with the code**: Features without tests are not complete.
3. **CI Must Pass**: All CI checks (cargo test, clippy, lint, typecheck, integration tests, Playwright) must pass cleanly.
4. **Fill out the PR template**: Clearly explain what was done, what was tested, and how invariants are preserved.
