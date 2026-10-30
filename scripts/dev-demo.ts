/**
 * scripts/dev-demo.ts
 *
 * Starts the Holdfast stack and prints ready-to-test seeded demo URLs.
 */
import { spawn } from "node:child_process";

function printBanner() {
  console.log(`
========================================================================
🚀 Holdfast Local Stack & Demo Links
========================================================================

📦 Buyer Payment Link (Checkout flow):
   http://localhost:3000/pay/demo-link

📱 Seller PWA Dashboard (Manage orders & shipping proof):
   http://localhost:3000/dashboard

🛡️ Admin Dispute Console (Arbitration & evidence review):
   http://localhost:3000/admin

🏷️ Public Seller Reputation Profile:
   http://localhost:3000/sellers/demo-seller

✨ Server-Rendered Accessible SVG Badge:
   http://localhost:3001/v1/sellers/demo-seller/badge.svg

📊 Operational Health & Real-Time Metrics:
   http://localhost:3001/health
   http://localhost:3001/metrics
   http://localhost:3001/v1/admin/metrics

Seeded Test Credentials:
- Seller Phone:  +2348000000002 (@demo-seller)
- Buyer Phone:   +2348000000099
- Arbiter Phone: +2348000000001 (Admin)
========================================================================
Starting backend API, web dashboard, and background worker...
`);
}

printBanner();

// If invoked in dry-run or verification mode, exit cleanly
if (process.argv.includes("--print-only")) {
  process.exit(0);
}

const child = spawn("pnpm", ["dev"], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    ESCROW_MODE: process.env["ESCROW_MODE"] ?? "A",
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
