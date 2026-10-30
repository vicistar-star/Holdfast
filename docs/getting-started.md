# Holdfast — First 30 Minutes Getting Started Guide

Welcome to Holdfast! This hands-on guide walks you through setting up your local environment, running the full test suite, seeding demo data, and exploring the complete social commerce escrow lifecycle locally in under 30 minutes.

---

## Prerequisites (5 Minutes)

Ensure you have the following installed:
- **Node.js**: v20.0.0 or higher (`node -v`)
- **pnpm**: v9.0.0 or higher (`pnpm -v`)
- **Rust & Cargo**: stable toolchain with wasm target (`rustc -v`)
- **Stellar CLI**: (`stellar --version`)
- **Docker Compose**: (`docker compose version`)

---

## Step 1: Clone and Automated Setup (5 Minutes)

Clone the repository and run `make setup`:

```bash
git clone https://github.com/vicistar-star/Holdfast.git
cd Holdfast

make setup
```

### Expected Output
```text
pnpm install
...
Packages: +410
Done in 6.7s using pnpm v10.28.2
rustup target add wasm32v1-none 2>/dev/null || rustup target add wasm32-unknown-unknown
✓ setup complete
```

---

## Step 2: Spin Up Local Services & Run Migrations (5 Minutes)

Start PostgreSQL (port 5432), Redis (port 6379), and MinIO (port 9000):

```bash
make docker-up
```

Run database schema migrations and seed the database with demo fixtures:

```bash
pnpm db:migrate
pnpm --filter @holdfast/db seed
```

### Expected Output
```text
Seeding database…
✓ Seeding complete:
  - Demo Arbiter: ID 00000000-0000-0000-0000-000000000001 (+2348000000001)
  - Demo Seller:  @demo-seller (+2348000000002)
  - Demo Link:    slug "demo-link" (₦50,000)
  - Demo Orders:  6 orders seeded across all states (Funded -> Resolved)
```

---

## Step 3: Run All Tests (5 Minutes)

Execute both the Soroban smart contract tests and the TypeScript test suites:

```bash
make test
```

### Expected Output
```text
cargo test --manifest-path contracts/escrow/Cargo.toml
...
test result: ok. 58 passed; 0 failed; 0 ignored; finished in 1.03s

pnpm test
...
✔ Failure Injection & Resilience Tests
✔ Security Route Audit & Policy Verification
✔ Dispute Resolution Invariants
✔ StorageService (S3-compatible evidence storage)
ℹ tests 62
ℹ suites 24
ℹ pass 62
ℹ fail 0
```

---

## Step 4: Run the Local Stack & Demo Flow (10 Minutes)

Run the dedicated demo stack command:

```bash
pnpm dev:demo
```

This launches the API (port 3001), Web App (port 3000), and Worker, and outputs clickable local demo links:

```text
========================================================================
🚀 Holdfast Local Stack is Ready!
========================================================================

📦 Buyer Payment Link:
   http://localhost:3000/pay/demo-link

📱 Seller PWA Dashboard:
   http://localhost:3000/dashboard

🛡️ Admin Dispute Console:
   http://localhost:3000/admin

🏷️ Public Seller Reputation Profile:
   http://localhost:3000/sellers/demo-seller

✨ Public Accessible SVG Badge:
   http://localhost:3001/v1/sellers/demo-seller/badge.svg

📊 Operational Health & Metrics:
   http://localhost:3001/health
   http://localhost:3001/metrics
========================================================================
```

### Try the Flow:
1. **Buyer Checkout**: Navigate to `http://localhost:3000/pay/demo-link`, enter buyer phone `+2348011223344`, and click "Pay via Bank Transfer". Virtual account instructions will display.
2. **Seller Dashboard**: Open `http://localhost:3000/dashboard`, log in with `+2348000000002`, view active orders, and mark an order as "Shipped" with proof upload.
3. **Dispute Resolution**: Open `http://localhost:3000/admin`, select the disputed order `00000000-0000-0000-0001-000000000004`, inspect evidence, and submit a split resolution.
4. **Metrics**: Visit `http://localhost:3001/metrics` to inspect keeper lag, stuck orders, and sponsor balance.
