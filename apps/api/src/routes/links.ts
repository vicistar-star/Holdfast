/**
 * POST /v1/links          — create payment link (seller auth)
 * GET  /v1/links/:slug    — public link details for the pay page
 */
import type { FastifyInstance } from "fastify";
import { CreateLinkSchema, getTierLimits } from "@holdfast/shared";
import { authenticate } from "../lib/middleware.ts";
import { badRequest, forbidden, notFound } from "../lib/errors.ts";
import { db, schema, eq } from "@holdfast/db";
import { randomBytes } from "node:crypto";

function randomSlug(): string {
  return randomBytes(6).toString("base64url");
}

export async function linkRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/links
  app.post("/", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;

    const userId = request.jwtPayload!.sub;
    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.user_id, userId),
    });
    if (!seller) return forbidden(reply, request.id);

    // Tier 0 cannot receive payments.
    const limits = getTierLimits(seller.kyc_tier);
    if (limits.max_order_minor === 0n) {
      return forbidden(reply, request.id);
    }

    const parsed = CreateLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id);
    }

    const { title, amount_minor, currency, ship_by_hours, review_hours, expires_at } = parsed.data;

    // Enforce per-order cap for the seller's tier.
    if (amount_minor > limits.max_order_minor) {
      return badRequest(
        reply,
        `Amount exceeds tier limit of ${limits.max_order_minor} minor units`,
        request.id,
      );
    }

    // Also enforce global cap from env.
    const globalCap = BigInt(process.env["MAX_ORDER_AMOUNT_MINOR"] ?? "5000000");
    if (amount_minor > globalCap) {
      return badRequest(reply, "Amount exceeds global order cap", request.id);
    }

    const slug = randomSlug();
    const rows = await db
      .insert(schema.payment_links)
      .values({
        slug,
        seller_id: userId,
        title,
        amount_minor,
        currency,
        ship_by_hours,
        review_hours,
        expires_at: expires_at ? new Date(expires_at) : null,
      })
      .returning();

    const link = rows[0]!;
    reply.status(201).send({
      id: link.id,
      slug: link.slug,
      title: link.title,
      amount_minor: link.amount_minor.toString(),
      currency: link.currency,
      ship_by_hours: link.ship_by_hours,
      review_hours: link.review_hours,
      expires_at: link.expires_at ?? null,
      seller: { handle: seller.handle, kyc_tier: seller.kyc_tier },
    });
  });

  // GET /v1/links/:slug — public; no seller private data
  app.get("/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const link = await db.query.payment_links.findFirst({
      where: eq(schema.payment_links.slug, slug),
    });
    if (!link) return notFound(reply, "Link", request.id);

    // Check expiry
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return notFound(reply, "Link", request.id);
    }

    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.user_id, link.seller_id),
    });

    reply.status(200).send({
      id: link.id,
      slug: link.slug,
      title: link.title,
      amount_minor: link.amount_minor.toString(),
      currency: link.currency,
      ship_by_hours: link.ship_by_hours,
      review_hours: link.review_hours,
      expires_at: link.expires_at ?? null,
      // Only public seller info — no phone, no payout_ref, no kyc_ref.
      seller: { handle: seller?.handle ?? "", kyc_tier: seller?.kyc_tier ?? 0 },
    });
  });
}
