/**
 * packages/db integration tests.
 *
 * These tests require a live PostgreSQL database. They are skipped automatically
 * when DATABASE_URL is not set or the DB is unreachable.
 *
 * Run locally:
 *   DATABASE_URL=postgresql://holdfast:holdfast@localhost:5432/holdfast \
 *     node --experimental-strip-types --test src/db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema.ts";

const DATABASE_URL = process.env["DATABASE_URL"];
const SKIP = !DATABASE_URL;

// Shared pool used across all tests in this file.
let pool: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(async () => {
  if (SKIP) return;
  pool = postgres(DATABASE_URL);
  db = drizzle(pool, { schema });
});

after(async () => {
  if (SKIP) return;
  await pool.end();
});

describe("order_events append-only enforcement", { skip: SKIP }, () => {
  const orderId = "ffffffff-ffff-ffff-ffff-000000000001";
  const userId = "ffffffff-ffff-ffff-ffff-000000000002";
  const linkId = "ffffffff-ffff-ffff-ffff-000000000004";
  let eventId: number;

  before(async () => {
    // Create minimal fixtures so FKs are satisfied.
    await db.insert(schema.users).values({
      id: userId,
      phone_e164: "+2340000000001",
      role: "seller",
    }).onConflictDoNothing();

    await db.insert(schema.sellers).values({
      user_id: userId,
      handle: "test-append-only",
      kyc_tier: 1,
    }).onConflictDoNothing();

    await db.insert(schema.payment_links).values({
      id: linkId,
      slug: "test-append-only-slug",
      seller_id: userId,
      title: "Test",
      amount_minor: 100n,
      currency: "NGN",
      ship_by_hours: 24,
      review_hours: 12,
    }).onConflictDoNothing();

    await db.insert(schema.orders).values({
      id: orderId,
      link_id: linkId,
      buyer_phone: "+2340000000099",
      seller_id: userId,
      amount_minor: 100n,
      currency: "NGN",
      status: "Funded",
      ship_by: new Date(Date.now() + 86400000),
    }).onConflictDoNothing();

    // Insert a real event.
    const rows = await db.insert(schema.order_events).values({
      order_id: orderId,
      from_status: null,
      to_status: "Funded",
      actor: "system",
    }).returning({ id: schema.order_events.id });

    eventId = rows[0]!.id;
  });

  it("INSERT succeeds", () => {
    // If we got here, the before() hook worked.
    assert.ok(eventId > 0);
  });

  it("UPDATE is rejected by the trigger", async () => {
    await assert.rejects(
      () =>
        db.execute(
          sql`UPDATE order_events SET actor = 'hacked' WHERE id = ${eventId}`,
        ),
      /append-only/i,
    );
  });

  it("DELETE is rejected by the trigger", async () => {
    await assert.rejects(
      () =>
        db.execute(sql`DELETE FROM order_events WHERE id = ${eventId}`),
      /append-only/i,
    );
  });
});
