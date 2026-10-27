/**
 * API integration tests — require a live PostgreSQL database.
 * Skipped automatically when DATABASE_URL is not set.
 *
 * Covers: order lifecycle (create → ship → confirm), audit log written,
 * tier limits, auth failures.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.ts";
import { db, schema } from "@holdfast/db";
import { eq } from "drizzle-orm";
import { issueToken } from "./auth/jwt.ts";
import postgres from "postgres";

const SKIP = !process.env["DATABASE_URL"];
const SECRET = process.env["JWT_SECRET"] ?? "dev-secret-change-me";

let app: Awaited<ReturnType<typeof buildApp>>;
let pool: ReturnType<typeof postgres>;

// Test fixture IDs — fixed so we can clean up reliably.
const USER_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const SELLER_ID = "bbbbbbbb-0000-0000-0000-000000000001"; // same as user
const LINK_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const BUYER_PHONE = "+2349000000099";

before(async () => {
  if (SKIP) return;
  app = await buildApp({ logger: false });
  await app.ready();
  pool = postgres(process.env["DATABASE_URL"]!);

  // Seed test fixtures.
  await db.insert(schema.users).values({ id: USER_ID, phone_e164: "+2349000000001", role: "seller" }).onConflictDoNothing();
  await db.insert(schema.sellers).values({ user_id: SELLER_ID, handle: "integration-test-seller", kyc_tier: 1 }).onConflictDoNothing();
  await db.insert(schema.payment_links).values({
    id: LINK_ID,
    slug: "integration-test-link",
    seller_id: SELLER_ID,
    title: "Integration Test Product",
    amount_minor: 100_000n,
    currency: "NGN",
    ship_by_hours: 48,
    review_hours: 24,
  }).onConflictDoNothing();
});

after(async () => {
  if (SKIP) return;
  // Clean up test data.
  await db.delete(schema.order_events).where(
    // Can't delete from append-only in tests — trigger will fire. Just close.
    eq(schema.order_events.order_id, "00000000-0000-0000-0000-000000000000"), // no-op
  ).catch(() => {});
  await app.close();
  if (pool) await pool.end();
});

describe("Order lifecycle integration", { skip: SKIP }, () => {
  let orderId: string;
  let orderToken: string;
  const sellerToken = issueToken(SELLER_ID, "seller", SECRET);

  it("POST /v1/links/:slug/orders creates a Funded order", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/links/integration-test-link/orders",
      body: { buyer_phone: BUYER_PHONE },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = JSON.parse(res.body) as { order_id: string; status: string; order_token: string };
    assert.equal(body.status, "Funded");
    orderId = body.order_id;
    orderToken = body.order_token;
  });

  it("order_events has a Funded entry", async () => {
    const events = await db.query.order_events.findMany({ where: eq(schema.order_events.order_id, orderId) });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.to_status, "Funded");
    assert.equal(events[0]!.from_status, null);
  });

  it("GET /v1/orders/:id returns the order to the seller", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${sellerToken}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { status: string };
    assert.equal(body.status, "Funded");
  });

  it("GET /v1/orders/:id with order token returns order to buyer", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${orderToken}` },
    });
    assert.equal(res.statusCode, 200, res.body);
  });

  it("POST /v1/orders/:id/ship transitions to Shipped", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/ship`,
      headers: { authorization: `Bearer ${sellerToken}` },
      body: { waybill: "ABC123" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { status: string };
    assert.equal(body.status, "Shipped");
  });

  it("order_events now has Funded → Shipped", async () => {
    const events = await db.query.order_events.findMany({ where: eq(schema.order_events.order_id, orderId) });
    assert.equal(events.length, 2);
    assert.equal(events[1]!.from_status, "Funded");
    assert.equal(events[1]!.to_status, "Shipped");
    assert.equal(events[1]!.actor, "seller");
  });

  it("POST /v1/orders/:id/confirm transitions to Released", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/confirm`,
      headers: { authorization: `Bearer ${orderToken}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { status: string };
    assert.equal(body.status, "Released");
  });

  it("order_events has Shipped → Released", async () => {
    const events = await db.query.order_events.findMany({ where: eq(schema.order_events.order_id, orderId) });
    assert.equal(events.length, 3);
    assert.equal(events[2]!.to_status, "Released");
  });

  it("double-confirm on a Released order returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/confirm`,
      headers: { authorization: `Bearer ${orderToken}` },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe("Tier limits", { skip: SKIP }, () => {
  it("Tier 0 seller cannot create a link", async () => {
    // Create a tier-0 user/seller
    const tier0UserId = "bbbbbbbb-0000-0000-0000-000000000099";
    await db.insert(schema.users).values({ id: tier0UserId, phone_e164: "+2349000000099", role: "seller" }).onConflictDoNothing();
    await db.insert(schema.sellers).values({ user_id: tier0UserId, handle: "tier0-seller", kyc_tier: 0 }).onConflictDoNothing();

    const token = issueToken(tier0UserId, "seller", SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/v1/links",
      headers: { authorization: `Bearer ${token}` },
      body: { title: "Test", amount_minor: "1000", currency: "NGN", ship_by_hours: 24, review_hours: 12 },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe("Auth failures", { skip: SKIP }, () => {
  it("missing auth returns 401", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/links" });
    assert.equal(res.statusCode, 401);
  });

  it("bad token returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/links",
      headers: { authorization: "Bearer garbage" },
    });
    assert.equal(res.statusCode, 401);
  });

  it("order token cannot ship an order", async () => {
    // Create a fresh order for this test
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/links/integration-test-link/orders",
      body: { buyer_phone: BUYER_PHONE },
    });
    const { order_id, order_token } = JSON.parse(res1.body) as { order_id: string; order_token: string };

    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${order_id}/ship`,
      headers: { authorization: `Bearer ${order_token}` },
      body: {},
    });
    // order_token has role buyer_order, not seller — authenticate() returns 401
    assert.equal(res.statusCode, 401);
  });
});
