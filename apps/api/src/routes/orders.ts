/**
 * POST /v1/links/:slug/orders   — create order (buyer, no account required)
 * GET  /v1/orders/:id           — get order (buyer via order token, seller via auth)
 * POST /v1/orders/:id/ship      — seller marks shipped
 * POST /v1/orders/:id/confirm   — buyer confirms delivery
 * POST /v1/orders/:id/dispute   — buyer opens dispute
 * POST /v1/orders/:id/evidence  — upload evidence metadata
 */
import type { FastifyInstance } from "fastify";
import {
  CreateOrderSchema,
  ShipOrderSchema,
  OpenDisputeSchema,
  UploadEvidenceMetaSchema,
  getTierLimits,
  transition,
  type Actor,
} from "@holdfast/shared";
import { authenticate } from "../lib/middleware.ts";
import { verifyToken, issueOrderToken } from "../auth/jwt.ts";
import { badRequest, forbidden, notFound, conflict } from "../lib/errors.ts";
import { db, schema } from "@holdfast/db";
import { eq, and, sql } from "drizzle-orm";

const JWT_SECRET = process.env["JWT_SECRET"] ?? "dev-secret-change-me";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrderOrFail(orderId: string, reply: Parameters<typeof notFound>[0], requestId: string) {
  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  if (!order) { notFound(reply, "Order", requestId); return null; }
  return order;
}

/** Write order_events and update orders in the same transaction. */
async function applyTransition(opts: {
  orderId: string;
  fromStatus: string;
  toStatus: string;
  actor: Actor;
  note?: object;
  orderUpdates?: Partial<typeof schema.orders.$inferInsert>;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Update order status first (state before transfers per README rule 8).
    await tx
      .update(schema.orders)
      .set({ status: opts.toStatus, ...opts.orderUpdates })
      .where(eq(schema.orders.id, opts.orderId));

    // 2. Append audit event.
    await tx.insert(schema.order_events).values({
      order_id: opts.orderId,
      from_status: opts.fromStatus,
      to_status: opts.toStatus,
      actor: opts.actor,
      note: opts.note ?? null,
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/links/:slug/orders
  app.post("/links/:slug/orders", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const parsed = CreateOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id as string);
    }

    const link = await db.query.payment_links.findFirst({
      where: eq(schema.payment_links.slug, slug),
    });
    if (!link) return notFound(reply, "Link", request.id as string);
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return notFound(reply, "Link", request.id as string);
    }

    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.user_id, link.seller_id),
    });
    if (!seller) return notFound(reply, "Seller", request.id as string);

    // Tier 0 sellers cannot receive payments.
    const limits = getTierLimits(seller.kyc_tier);
    if (limits.max_order_minor === 0n) {
      return forbidden(reply, request.id as string);
    }

    const now = new Date();
    const shipBy = new Date(now.getTime() + link.ship_by_hours * 3600_000);

    const rows = await db.transaction(async (tx) => {
      const orderRows = await tx
        .insert(schema.orders)
        .values({
          link_id: link.id,
          buyer_phone: parsed.data.buyer_phone,
          seller_id: link.seller_id,
          amount_minor: link.amount_minor,
          currency: link.currency,
          status: "Funded",
          ship_by: shipBy.toISOString(),
        })
        .returning();

      const order = orderRows[0]!;

      await tx.insert(schema.order_events).values({
        order_id: order.id,
        from_status: null,
        to_status: "Funded",
        actor: "system",
        note: { link_slug: slug },
      });

      return orderRows;
    });

    const order = rows[0]!;

    // Issue a signed order token for the buyer — no buyer account needed.
    const orderToken = issueOrderToken(order.id, parsed.data.buyer_phone, JWT_SECRET);

    reply.status(201).send({
      order_id: order.id,
      status: order.status,
      amount_minor: order.amount_minor.toString(),
      currency: order.currency,
      ship_by: order.ship_by,
      // The buyer uses this token to check order status and act on the order.
      order_token: orderToken,
      // In Mode A: payment instructions come from the partner (Day 4).
      // For now return a placeholder so the shape is established.
      payment_instructions: { mode: "A", message: "Payment partner integration pending (Day 4)" },
    });
  });

  // GET /v1/orders/:id — buyer uses order token, seller uses auth token
  app.get("/orders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = request.headers.authorization;

    let authorised = false;
    let isBuyer = false;

    if (auth?.startsWith("Bearer ")) {
      const result = verifyToken(auth.slice(7), JWT_SECRET);
      if (result.ok) {
        const p = result.payload;
        // Seller auth: sub is user UUID, role is 'seller'
        if (p.role === "seller") {
          const order = await getOrderOrFail(id, reply, request.id as string);
          if (!order) return;
          const seller = await db.query.sellers.findFirst({
            where: eq(schema.sellers.user_id, p.sub),
          });
          if (seller && order.seller_id === seller.user_id) authorised = true;
        }
        // Buyer order token: role is 'buyer_order', order_id matches
        if (p.role === "buyer_order" && p["order_id"] === id) {
          authorised = true;
          isBuyer = true;
        }
      }
    }

    if (!authorised) return forbidden(reply, request.id as string);

    const order = await getOrderOrFail(id, reply, request.id as string);
    if (!order) return;

    reply.status(200).send({
      id: order.id,
      status: order.status,
      amount_minor: order.amount_minor.toString(),
      currency: order.currency,
      ship_by: order.ship_by,
      shipped_at: order.shipped_at ?? null,
      review_ends: order.review_ends ?? null,
      created_at: order.created_at,
      // Don't expose buyer_phone in seller view; don't expose seller details in buyer view.
      ...(isBuyer ? {} : { buyer_phone_masked: order.buyer_phone.slice(0, 5) + "****" }),
    });
  });

  // POST /v1/orders/:id/ship
  app.post("/orders/:id/ship", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;

    const { id } = request.params as { id: string };
    const parsed = ShipOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id as string);
    }

    const order = await getOrderOrFail(id, reply, request.id as string);
    if (!order) return;

    // Verify the caller is the seller for this order.
    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.user_id, request.jwtPayload!.sub),
    });
    if (!seller || seller.user_id !== order.seller_id) {
      return forbidden(reply, request.id as string);
    }

    const now = new Date();
    const result = transition({
      status: order.status as Parameters<typeof transition>[0]["status"],
      action: "mark_shipped",
      actor: "seller",
      now,
      shipBy: new Date(order.ship_by),
      reviewEnds: order.review_ends ? new Date(order.review_ends) : null,
    });

    if (!result.ok) return badRequest(reply, result.error.message, request.id as string);

    const link = await db.query.payment_links.findFirst({ where: eq(schema.payment_links.id, order.link_id) });
    const reviewEnds = new Date(now.getTime() + (link?.review_hours ?? 24) * 3600_000);

    await applyTransition({
      orderId: id,
      fromStatus: order.status,
      toStatus: result.nextStatus,
      actor: "seller",
      note: { waybill: parsed.data.waybill, note: parsed.data.note },
      orderUpdates: {
        shipped_at: now.toISOString(),
        review_ends: reviewEnds.toISOString(),
      },
    });

    reply.status(200).send({ status: result.nextStatus, review_ends: reviewEnds.toISOString() });
  });

  // POST /v1/orders/:id/confirm
  app.post("/orders/:id/confirm", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = request.headers.authorization;

    // Buyer uses an order token (not a user auth token).
    if (!auth?.startsWith("Bearer ")) return forbidden(reply, request.id as string);
    const tokenResult = verifyToken(auth.slice(7), JWT_SECRET);
    if (!tokenResult.ok || tokenResult.payload["order_id"] !== id) {
      return forbidden(reply, request.id as string);
    }

    const order = await getOrderOrFail(id, reply, request.id as string);
    if (!order) return;

    const now = new Date();
    const result = transition({
      status: order.status as Parameters<typeof transition>[0]["status"],
      action: "confirm_delivery",
      actor: "buyer",
      now,
      shipBy: new Date(order.ship_by),
      reviewEnds: order.review_ends ? new Date(order.review_ends) : null,
    });

    if (!result.ok) return badRequest(reply, result.error.message, request.id as string);

    await applyTransition({
      orderId: id,
      fromStatus: order.status,
      toStatus: result.nextStatus,
      actor: "buyer",
    });

    reply.status(200).send({ status: result.nextStatus });
  });

  // POST /v1/orders/:id/dispute
  app.post("/orders/:id/dispute", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = request.headers.authorization;

    if (!auth?.startsWith("Bearer ")) return forbidden(reply, request.id as string);
    const tokenResult = verifyToken(auth.slice(7), JWT_SECRET);
    if (!tokenResult.ok || tokenResult.payload["order_id"] !== id) {
      return forbidden(reply, request.id as string);
    }

    const parsed = OpenDisputeSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id as string);
    }

    const order = await getOrderOrFail(id, reply, request.id as string);
    if (!order) return;

    const now = new Date();
    const result = transition({
      status: order.status as Parameters<typeof transition>[0]["status"],
      action: "open_dispute",
      actor: "buyer",
      now,
      shipBy: new Date(order.ship_by),
      reviewEnds: order.review_ends ? new Date(order.review_ends) : null,
    });

    if (!result.ok) return badRequest(reply, result.error.message, request.id as string);

    // Check no existing dispute (belt-and-suspenders; DB UNIQUE also enforces this).
    const existingDispute = await db.query.disputes.findFirst({
      where: eq(schema.disputes.order_id, id),
    });
    if (existingDispute) return conflict(reply, "Dispute already open", request.id as string);

    await db.transaction(async (tx) => {
      await tx.update(schema.orders).set({ status: result.nextStatus }).where(eq(schema.orders.id, id));
      await tx.insert(schema.order_events).values({
        order_id: id,
        from_status: order.status,
        to_status: result.nextStatus,
        actor: "buyer",
        note: { reason: parsed.data.reason, note: parsed.data.note },
      });
      await tx.insert(schema.disputes).values({
        order_id: id,
        reason: parsed.data.reason,
      });
    });

    reply.status(200).send({ status: result.nextStatus });
  });

  // POST /v1/orders/:id/evidence — metadata only; actual upload is to object storage
  app.post("/orders/:id/evidence", async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return forbidden(reply, request.id as string);

    const tokenResult = verifyToken(auth.slice(7), JWT_SECRET);
    if (!tokenResult.ok) return forbidden(reply, request.id as string);

    const payload = tokenResult.payload;
    // Allow both buyer order token and seller/arbiter auth token.
    const isBuyerToken = payload.role === "buyer_order" && payload["order_id"] === id;
    const isSellerOrArbiter = payload.role === "seller" || payload.role === "arbiter";
    if (!isBuyerToken && !isSellerOrArbiter) return forbidden(reply, request.id as string);

    const parsed = UploadEvidenceMetaSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id as string);
    }

    const order = await getOrderOrFail(id, reply, request.id as string);
    if (!order) return;

    // Generate an object key for S3-compatible storage. Actual upload is client-side.
    const objectKey = `evidence/${id}/${Date.now()}-${parsed.data.filename}`;

    await db.insert(schema.evidence).values({
      order_id: id,
      uploaded_by: isBuyerToken ? "buyer" : payload.sub,
      object_key: objectKey,
      sha256: parsed.data.sha256,
    });

    reply.status(201).send({ object_key: objectKey, upload_url: null /* S3 presigned URL — Day 4 */ });
  });
}
