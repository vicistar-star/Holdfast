/**
 * POST /v1/sellers            — create seller profile
 * POST /v1/sellers/kyc        — start KYC (stub)
 * PUT  /v1/sellers/payout-account
 * GET  /v1/sellers/:handle/reputation
 */
import type { FastifyInstance } from "fastify";
import { CreateSellerSchema, SetPayoutAccountSchema } from "@holdfast/shared";
import { authenticate } from "../lib/middleware.ts";
import { badRequest, conflict, notFound, forbidden } from "../lib/errors.ts";
import { db, schema } from "@holdfast/db";
import { eq, count, sql } from "drizzle-orm";

export async function sellerRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/sellers
  app.post("/", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;

    const parsed = CreateSellerSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id as string);
    }

    const userId = request.jwtPayload!.sub;

    // Check handle uniqueness
    const existing = await db.query.sellers.findFirst({
      where: eq(schema.sellers.handle, parsed.data.handle),
    });
    if (existing) {
      return conflict(reply, "Handle already taken", request.id as string);
    }

    // Promote the user to seller role
    await db.update(schema.users).set({ role: "seller" }).where(eq(schema.users.id, userId));

    const rows = await db
      .insert(schema.sellers)
      .values({ user_id: userId, handle: parsed.data.handle })
      .onConflictDoNothing()
      .returning();

    if (!rows[0]) {
      return conflict(reply, "Seller profile already exists", request.id as string);
    }

    reply.status(201).send({
      id: userId,
      handle: rows[0].handle,
      kyc_tier: rows[0].kyc_tier,
      created_at: rows[0].created_at,
    });
  });

  // POST /v1/sellers/kyc  — stub; real KYC is Day 4
  app.post("/kyc", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;
    // ASSUMPTION: KYC provider integration is a Day 4 task (MockKycProvider).
    // For now return a placeholder response so the route exists.
    reply.status(202).send({ status: "pending", message: "KYC not yet integrated" });
  });

  // PUT /v1/sellers/payout-account
  app.put("/payout-account", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;

    const parsed = SetPayoutAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id as string);
    }

    const userId = request.jwtPayload!.sub;
    const seller = await db.query.sellers.findFirst({ where: eq(schema.sellers.user_id, userId) });
    if (!seller) return forbidden(reply, request.id as string);

    // ASSUMPTION: Real account-name resolution (matching KYC name) is Day 4.
    // Store a reference string for now.
    const ref = `${parsed.data.bank_code}:${parsed.data.account_number}`;
    await db.update(schema.sellers).set({ payout_ref: ref }).where(eq(schema.sellers.user_id, userId));

    reply.status(200).send({ ok: true, payout_ref: ref });
  });

  // GET /v1/sellers/:handle/reputation  — public, no auth
  app.get("/:handle/reputation", async (request, reply) => {
    const { handle } = request.params as { handle: string };

    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.handle, handle),
    });
    if (!seller) return notFound(reply, "Seller", request.id as string);

    // Compute reputation from order_events (source of truth per README).
    const completedRows = await db
      .select({ count: count() })
      .from(schema.orders)
      .where(
        sql`seller_id = ${seller.user_id} AND status IN ('Released','Resolved')`,
      );
    const completedOrders = Number(completedRows[0]?.count ?? 0);

    const shippedRows = await db
      .select({ count: count() })
      .from(schema.orders)
      .where(sql`seller_id = ${seller.user_id} AND status NOT IN ('Funded')`);
    const shipped = Number(shippedRows[0]?.count ?? 0);

    const disputedRows = await db
      .select({ count: count() })
      .from(schema.orders)
      .where(sql`seller_id = ${seller.user_id} AND status IN ('Disputed','Resolved')`);
    const disputed = Number(disputedRows[0]?.count ?? 0);

    const MIN_SAMPLE = 10;
    const disputeRate = shipped >= MIN_SAMPLE ? disputed / shipped : null;

    reply.status(200).send({
      handle: seller.handle,
      kyc_tier: seller.kyc_tier,
      completed_orders: completedOrders,
      dispute_rate: disputeRate,
      median_ship_hours: null, // TODO: compute from order_events timestamps
      sample_size: shipped,
    });
  });
}
