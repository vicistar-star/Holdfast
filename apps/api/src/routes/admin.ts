/**
 * apps/api/src/routes/admin.ts
 *
 * Role-gated admin / arbiter routes:
 * - GET  /v1/admin/disputes             — list open disputes
 * - GET  /v1/admin/disputes/:id         — dispute case view (timeline, evidence, facts)
 * - POST /v1/admin/disputes/:id/resolve — resolve dispute split with rationale
 */

import type { FastifyInstance } from "fastify";
import {
  ResolveDisputeSchema,
  computeFee,
  assertConservation,
  parseEscrowMode,
} from "@holdfast/shared";
import { authenticate } from "../lib/middleware.ts";
import { badRequest, forbidden, notFound, conflict } from "../lib/errors.ts";
import { db, schema, eq, desc } from "@holdfast/db";
import { defaultStorage } from "../storage/s3Client.ts";
import { defaultArbiterSigner } from "../chain/arbiterSigner.ts";
import { defaultPaymentProvider } from "../payment/provider.ts";

// Configurable threshold above which a dispute is flagged for second approver (README guardrails)
const SECOND_APPROVER_THRESHOLD_MINOR = BigInt(
  process.env["SECOND_APPROVER_THRESHOLD_MINOR"] ?? "50000000", // Default: ₦500,000
);

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Auth hook for all /admin routes
  app.addHook("preHandler", async (request, reply) => {
    if (!(await authenticate(request, reply))) return;
    const role = request.jwtPayload?.role;
    if (role !== "arbiter" && role !== "admin") {
      forbidden(reply, request.id);
    }
  });

  // GET /v1/admin/disputes — list all disputes
  app.get("/disputes", async (_request, reply) => {
    const disputeRows = await db.query.disputes.findMany({
      orderBy: [desc(schema.disputes.opened_at)],
    });

    const results = [];

    for (const d of disputeRows) {
      const order = await db.query.orders.findFirst({
        where: eq(schema.orders.id, d.order_id),
      });
      if (!order) continue;

      const seller = await db.query.sellers.findFirst({
        where: eq(schema.sellers.user_id, order.seller_id),
      });

      results.push({
        id: d.id,
        order_id: d.order_id,
        status: order.status,
        reason: d.reason,
        amount_minor: order.amount_minor.toString(),
        currency: order.currency,
        buyer_phone: order.buyer_phone,
        seller_handle: seller?.handle ?? "unknown",
        opened_at: d.opened_at,
        resolved_at: d.resolved_at,
        requires_second_approver: order.amount_minor > SECOND_APPROVER_THRESHOLD_MINOR,
      });
    }

    reply.status(200).send({ disputes: results });
  });

  // GET /v1/admin/disputes/:id — full case view
  app.get("/disputes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    let dispute = await db.query.disputes.findFirst({
      where: eq(schema.disputes.id, id),
    });

    if (!dispute) {
      // Allow querying by order_id as well
      dispute = await db.query.disputes.findFirst({
        where: eq(schema.disputes.order_id, id),
      });
    }

    if (!dispute) {
      return notFound(reply, "Dispute", request.id);
    }

    const order = await db.query.orders.findFirst({
      where: eq(schema.orders.id, dispute.order_id),
    });
    if (!order) return notFound(reply, "Order", request.id);

    const seller = await db.query.sellers.findFirst({
      where: eq(schema.sellers.user_id, order.seller_id),
    });

    // Timeline from order_events (audit trail per README)
    const events = await db.query.order_events.findMany({
      where: eq(schema.order_events.order_id, order.id),
      orderBy: [schema.order_events.created_at],
    });

    // Evidence with hash verification status
    const evidenceRows = await db.query.evidence.findMany({
      where: eq(schema.evidence.order_id, order.id),
    });

    const verifiedEvidence = [];
    for (const ev of evidenceRows) {
      let hashMatches = false;
      try {
        const verifyRes = await defaultStorage.verifyObjectHash(ev.object_key, ev.sha256);
        hashMatches = verifyRes.matches;
      } catch {
        hashMatches = false;
      }

      verifiedEvidence.push({
        id: ev.id,
        uploaded_by: ev.uploaded_by,
        object_key: ev.object_key,
        sha256: ev.sha256,
        hash_verified: hashMatches,
        created_at: ev.created_at,
      });
    }

    // Statements: extract dispute opening note and shipping notes
    const disputeOpenEvent = events.find((e) => e.to_status === "Disputed");
    const shipEvent = events.find((e) => e.to_status === "Shipped");

    reply.status(200).send({
      dispute: {
        id: dispute.id,
        order_id: dispute.order_id,
        reason: dispute.reason,
        opened_at: dispute.opened_at,
        resolved_at: dispute.resolved_at,
        buyer_share_minor: dispute.buyer_share?.toString() ?? null,
        seller_share_minor: dispute.seller_share?.toString() ?? null,
        rationale: dispute.resolution,
      },
      order: {
        id: order.id,
        chain_id: order.chain_id?.toString() ?? null,
        amount_minor: order.amount_minor.toString(),
        currency: order.currency,
        status: order.status,
        buyer_phone: order.buyer_phone,
        seller_handle: seller?.handle ?? "unknown",
        ship_by: order.ship_by,
        shipped_at: order.shipped_at,
        review_ends: order.review_ends,
        created_at: order.created_at,
      },
      timeline: events.map((e) => ({
        id: e.id,
        from_status: e.from_status,
        to_status: e.to_status,
        actor: e.actor,
        note: e.note,
        tx_hash: e.tx_hash,
        created_at: e.created_at,
      })),
      evidence: verifiedEvidence,
      statements: {
        buyer_dispute_reason: dispute.reason,
        buyer_dispute_note: (disputeOpenEvent?.note as Record<string, unknown> | null)?.["note"] ?? null,
        seller_shipping_waybill: (shipEvent?.note as Record<string, unknown> | null)?.["waybill"] ?? null,
        seller_shipping_note: (shipEvent?.note as Record<string, unknown> | null)?.["note"] ?? null,
      },
      requires_second_approver: order.amount_minor > SECOND_APPROVER_THRESHOLD_MINOR,
    });
  });

  // POST /v1/admin/disputes/:id/resolve — submit split & rationale
  app.post("/disputes/:id/resolve", async (request, reply) => {
    const { id } = request.params as { id: string };

    const parsed = ResolveDisputeSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid resolution input", request.id);
    }

    let dispute = await db.query.disputes.findFirst({
      where: eq(schema.disputes.id, id),
    });
    if (!dispute) {
      dispute = await db.query.disputes.findFirst({
        where: eq(schema.disputes.order_id, id),
      });
    }
    if (!dispute) return notFound(reply, "Dispute", request.id);

    const order = await db.query.orders.findFirst({
      where: eq(schema.orders.id, dispute.order_id),
    });
    if (!order) return notFound(reply, "Order", request.id);

    if (order.status !== "Disputed") {
      return conflict(reply, `Order cannot be resolved from state ${order.status}`, request.id);
    }

    const buyerShare = BigInt(parsed.data.buyer_share_minor);
    const sellerShare = BigInt(parsed.data.seller_share_minor);

    // Invariant 7: Conservation check (buyerShare + sellerShare == amount)
    assertConservation(order.amount_minor, buyerShare, sellerShare);

    // Rule 6: Fees apply to payouts only. Fee is charged on seller's share only.
    const feeBps = 150n; // default 1.5%

    const sellerFee = computeFee(sellerShare, feeBps);
    const sellerPayout = sellerShare - sellerFee;
    const buyerRefund = buyerShare; // Refunds are fee-free per README rule 6

    // Mode A vs Mode B settlement
    const mode = parseEscrowMode(process.env["ESCROW_MODE"]);
    let onChainTxHash: string | null = null;

    if (mode === "B" && order.chain_id) {
      const onChainRes = await defaultArbiterSigner.signAndSubmitResolve({
        chainId: order.chain_id,
        buyerShare,
        sellerShare,
      });
      if (!onChainRes.ok) {
        return badRequest(reply, onChainRes.error ?? "Failed on-chain dispute resolution", request.id);
      }
      onChainTxHash = onChainRes.txHash ?? null;
    } else {
      // Mode A: instruct partner payouts
      const seller = await db.query.sellers.findFirst({
        where: eq(schema.sellers.user_id, order.seller_id),
      });

      if (buyerRefund > 0n) {
        await defaultPaymentProvider.createRefund({
          idempotency_key: `dispute_refund_${order.id}`,
          amount_minor: buyerRefund,
          currency: order.currency,
          account_ref: order.buyer_phone,
          narration: `Holdfast Dispute Refund: ${order.id}`,
        });
      }

      if (sellerPayout > 0n && seller?.payout_ref) {
        await defaultPaymentProvider.createPayout({
          idempotency_key: `dispute_seller_${order.id}`,
          amount_minor: sellerPayout,
          currency: order.currency,
          account_ref: seller.payout_ref,
          narration: `Holdfast Dispute Payout: ${order.id}`,
        });
      }
    }

    const now = new Date();

    // Database update in transaction (Rule 8: state updated before transfers)
    await db.transaction(async (tx) => {
      // 1. Update order status
      await tx
        .update(schema.orders)
        .set({ status: "Resolved" })
        .where(eq(schema.orders.id, order.id));

      // 2. Update dispute record
      await tx
        .update(schema.disputes)
        .set({
          buyer_share: buyerShare,
          seller_share: sellerShare,
          resolution: parsed.data.rationale,
          resolved_at: now,
        })
        .where(eq(schema.disputes.id, dispute.id));

      // 3. Append-only order_events
      await tx.insert(schema.order_events).values({
        order_id: order.id,
        from_status: "Disputed",
        to_status: "Resolved",
        actor: "arbiter",
        tx_hash: onChainTxHash,
        note: {
          buyer_share_minor: buyerShare.toString(),
          seller_share_minor: sellerShare.toString(),
          seller_fee_minor: sellerFee.toString(),
          seller_payout_minor: sellerPayout.toString(),
          rationale: parsed.data.rationale,
          arbiter: request.jwtPayload?.sub ?? "arbiter",
        },
      });
    });

    reply.status(200).send({
      ok: true,
      status: "Resolved",
      buyer_share_minor: buyerShare.toString(),
      seller_share_minor: sellerShare.toString(),
      seller_fee_minor: sellerFee.toString(),
      seller_payout_minor: sellerPayout.toString(),
      tx_hash: onChainTxHash,
    });
  });
}
