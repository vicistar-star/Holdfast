/**
 * Seed script — creates a demo seller, a payment link, and one order in
 * every possible status. Safe to re-run (uses INSERT ... ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node --experimental-strip-types src/seed.ts
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://holdfast:holdfast@localhost:5432/holdfast";

const pool = postgres(DATABASE_URL);
const db = drizzle(pool, { schema });

async function seed() {
  console.log("Seeding database…");

  // ── Demo arbiter user ──────────────────────────────────────────────────────
  await db
    .insert(schema.users)
    .values({
      id: "00000000-0000-0000-0000-000000000001",
      phone_e164: "+2348000000001",
      role: "arbiter",
    })
    .onConflictDoNothing();

  // ── Demo seller user ───────────────────────────────────────────────────────
  await db
    .insert(schema.users)
    .values({
      id: "00000000-0000-0000-0000-000000000002",
      phone_e164: "+2348000000002",
      role: "seller",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.sellers)
    .values({
      user_id: "00000000-0000-0000-0000-000000000002",
      handle: "demo-seller",
      kyc_tier: 1,
      payout_ref: "demo-payout-ref",
    })
    .onConflictDoNothing();

  // ── Demo payment link ──────────────────────────────────────────────────────
  await db
    .insert(schema.payment_links)
    .values({
      id: "00000000-0000-0000-0000-000000000010",
      slug: "demo-link",
      seller_id: "00000000-0000-0000-0000-000000000002",
      title: "Demo Product",
      amount_minor: 5000000n, // ₦50,000 in kobo
      currency: "NGN",
      ship_by_hours: 48,
      review_hours: 24,
    })
    .onConflictDoNothing();

  // ── One order per status ───────────────────────────────────────────────────
  const statuses = [
    "Funded",
    "Shipped",
    "Released",
    "Refunded",
    "Disputed",
    "Resolved",
  ] as const;

  const now = new Date();
  const shipBy = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  for (const [i, status] of statuses.entries()) {
    const orderId = `00000000-0000-0000-0001-${String(i).padStart(12, "0")}`;

    await db
      .insert(schema.orders)
      .values({
        id: orderId,
        link_id: "00000000-0000-0000-0000-000000000010",
        buyer_phone: "+2348000000099",
        seller_id: "00000000-0000-0000-0000-000000000002",
        amount_minor: 5000000n,
        currency: "NGN",
        status,
        ship_by: shipBy.toISOString(),
        shipped_at:
          ["Shipped", "Released", "Disputed", "Resolved"].includes(status)
            ? now.toISOString()
            : null,
        review_ends:
          ["Shipped", "Released", "Disputed", "Resolved"].includes(status)
            ? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
            : null,
      })
      .onConflictDoNothing();

    // Write the initial order_event for each order.
    const existing = await db
      .select({ id: schema.order_events.id })
      .from(schema.order_events)
      .where(sql`order_id = ${orderId}`)
      .limit(1);

    if (existing.length === 0) {
      await db.insert(schema.order_events).values({
        order_id: orderId,
        from_status: null,
        to_status: "Funded",
        actor: "system",
        note: { seeded: true },
      });

      // Add a second event for orders past Funded.
      if (status !== "Funded") {
        await db.insert(schema.order_events).values({
          order_id: orderId,
          from_status: "Funded",
          to_status: status,
          actor: "seller",
          note: { seeded: true },
        });
      }
    }
  }

  console.log("Seed complete.");
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
