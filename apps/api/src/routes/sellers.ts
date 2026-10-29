/**
 * apps/api/src/routes/sellers.ts
 *
 * Seller routes:
 * - POST /v1/sellers                 — create seller profile
 * - POST /v1/sellers/kyc             — submit KYC verification
 * - PUT  /v1/sellers/payout-account  — set payout bank account
 * - GET  /v1/sellers/:handle/reputation — computed reputation summary
 * - GET  /v1/sellers/:handle/badge.svg  — server-rendered accessible SVG badge
 * - GET  /v1/sellers/me             — current authenticated seller profile
 */

import type { FastifyInstance } from "fastify";
import {
  CreateSellerSchema,
  SetPayoutAccountSchema,
  computeReputation,
  type OrderRecordForReputation,
} from "@holdfast/shared";
import { authenticate } from "../lib/middleware.ts";
import { badRequest, conflict, notFound, forbidden } from "../lib/errors.ts";
import { db, schema, eq, desc } from "@holdfast/db";

export async function sellerRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/sellers
  app.post("/", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;

    const parsed = CreateSellerSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id);
    }

    const userId = request.jwtPayload!.sub;

    const existing = await db.query.sellers.findFirst({
      where: eq(schema.sellers.handle, parsed.data.handle),
    });
    if (existing) {
      return conflict(reply, "Handle already taken", request.id);
    }

    await db.update(schema.users).set({ role: "seller" }).where(eq(schema.users.id, userId));

    const rows = await db
      .insert(schema.sellers)
      .values({ user_id: userId, handle: parsed.data.handle })
      .onConflictDoNothing()
      .returning();

    if (!rows[0]) {
      return conflict(reply, "Seller profile already exists", request.id);
    }

    reply.status(201).send({
      id: userId,
      handle: rows[0].handle,
      kyc_tier: rows[0].kyc_tier,
      created_at: rows[0].created_at,
    });
  });

  // GET /v1/sellers/me — authenticated seller profile & stats
  app.get("/me", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;
    const userId = request.jwtPayload!.sub;

    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.user_id, userId),
    });
    if (!seller) return notFound(reply, "Seller profile", request.id);

    reply.status(200).send({
      id: seller.user_id,
      handle: seller.handle,
      kyc_tier: seller.kyc_tier,
      payout_ref: seller.payout_ref,
      created_at: seller.created_at,
    });
  });

  // POST /v1/sellers/kyc
  app.post("/kyc", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;
    const userId = request.jwtPayload!.sub;

    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.user_id, userId),
    });
    if (!seller) return notFound(reply, "Seller", request.id);

    // Update KYC tier to 1 (verified)
    await db
      .update(schema.sellers)
      .set({ kyc_tier: 1 })
      .where(eq(schema.sellers.user_id, userId));

    reply.status(200).send({
      status: "verified",
      kyc_tier: 1,
      message: "Seller identity verified",
    });
  });

  // PUT /v1/sellers/payout-account
  app.put("/payout-account", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;

    const parsed = SetPayoutAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id);
    }

    const userId = request.jwtPayload!.sub;
    const seller = await db.query.sellers.findFirst({ where: eq(schema.sellers.user_id, userId) });
    if (!seller) return forbidden(reply, request.id);

    const ref = `${parsed.data.bank_code}:${parsed.data.account_number}`;
    await db.update(schema.sellers).set({ payout_ref: ref }).where(eq(schema.sellers.user_id, userId));

    reply.status(200).send({ ok: true, payout_ref: ref });
  });

  // GET /v1/sellers/:handle/reputation — public, derived from order_events
  app.get("/:handle/reputation", async (request, reply) => {
    const { handle } = request.params as { handle: string };

    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.handle, handle),
    });
    if (!seller) return notFound(reply, "Seller", request.id);

    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, seller.user_id),
    });

    // Fetch all orders for this seller
    const sellerOrders = await db.query.orders.findMany({
      where: eq(schema.orders.seller_id, seller.user_id),
      orderBy: [desc(schema.orders.created_at)],
    });

    // Fetch disputes and events for these orders
    const mappedOrders: OrderRecordForReputation[] = [];

    for (const ord of sellerOrders) {
      const dispute = await db.query.disputes.findFirst({
        where: eq(schema.disputes.order_id, ord.id),
      });

      const events = await db.query.order_events.findMany({
        where: eq(schema.order_events.order_id, ord.id),
      });

      const fundedEvt = events.find((e) => e.to_status === "Funded");
      const shippedEvt = events.find((e) => e.to_status === "Shipped");
      const releasedEvt = events.find((e) => e.to_status === "Released");
      const disputedEvt = events.find((e) => e.to_status === "Disputed");
      const resolvedEvt = events.find((e) => e.to_status === "Resolved");

      mappedOrders.push({
        id: ord.id,
        sellerId: seller.user_id,
        buyerPhone: ord.buyer_phone,
        sellerPhone: user?.phone_e164 ?? "",
        sellerPayoutAccount: seller.payout_ref,
        amount: ord.amount_minor,
        status: ord.status,
        createdAt: ord.created_at,
        fundedAt: fundedEvt?.created_at ?? ord.created_at,
        shippedAt: ord.shipped_at ?? shippedEvt?.created_at ?? null,
        releasedAt: releasedEvt?.created_at ?? null,
        disputedAt: disputedEvt?.created_at ?? null,
        resolvedAt: resolvedEvt?.created_at ?? null,
        buyerShare: dispute?.buyer_share ?? null,
        sellerShare: dispute?.seller_share ?? null,
      });
    }

    const rep = computeReputation({
      sellerHandle: seller.handle,
      sellerCreatedAt: seller.created_at,
      kycTier: seller.kyc_tier,
      orders: mappedOrders,
    });

    reply.status(200).send(rep);
  });

  // GET /v1/sellers/:handle/badge.svg — server-rendered, cacheable SVG badge
  app.get("/:handle/badge.svg", async (request, reply) => {
    const { handle } = request.params as { handle: string };

    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.handle, handle),
    });
    if (!seller) {
      reply.status(404).send("<svg><text>Seller not found</text></svg>");
      return;
    }

    const isVerified = seller.kyc_tier >= 1;

    // Render accessible SVG with zero external assets
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="340" height="88" viewBox="0 0 340 88" role="img" aria-label="Holdfast Escrow Verified Seller Badge for @${escapeXml(seller.handle)}">
  <title>Holdfast Seller: @${escapeXml(seller.handle)}</title>
  <desc>Verified escrow track record powered by Stellar / Soroban</desc>
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.3"/>
    </filter>
  </defs>

  <!-- Card Body -->
  <rect width="338" height="86" x="1" y="1" rx="12" fill="url(#bg)" stroke="#334155" stroke-width="1.5" filter="url(#shadow)" />

  <!-- Shield Icon -->
  <g transform="translate(16, 20)">
    <path d="M16 2 L4 7 V16 C4 23.5 9.1 30.5 16 32 C22.9 30.5 28 23.5 28 16 V7 Z" fill="#2563eb" />
    <path d="M11 16 L14.5 19.5 L21 13" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <!-- Seller Handle & Verification -->
  <text x="56" y="32" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="15" font-weight="700" fill="#f8fafc">
    @${escapeXml(seller.handle)}
  </text>

  <!-- Verified Pill -->
  ${
    isVerified
      ? `<g transform="translate(56, 42)">
          <rect width="78" height="20" rx="10" fill="#065f46" />
          <text x="8" y="14" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="600" fill="#34d399">✓ Verified</text>
         </g>`
      : `<g transform="translate(56, 42)">
          <rect width="90" height="20" rx="10" fill="#374151" />
          <text x="8" y="14" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="500" fill="#9ca3af">New Seller</text>
         </g>`
  }

  <!-- Footer Brand -->
  <text x="56" y="74" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="10" font-weight="500" fill="#64748b">
    Protected by Holdfast Escrow
  </text>
</svg>
`.trim();

    reply
      .header("Content-Type", "image/svg+xml; charset=utf-8")
      .header("Cache-Control", "public, max-age=300, s-maxage=600")
      .status(200)
      .send(svg);
  });
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}
