/**
 * POST /v1/webhooks/payments
 *
 * Signature-verified, idempotent webhook handler.
 * Idempotency is enforced by the webhook_events table (unique on provider+event_id).
 * Duplicate or out-of-order delivery is safe: a second delivery with the same
 * event_id hits the UNIQUE constraint and is silently ignored.
 *
 * A confirmed payment transitions the order from Funded (Mode A: partner confirms
 * payment received) and, in Mode B, triggers on-chain funding.
 */
import type { FastifyInstance } from "fastify";
import { db, schema, eq, and } from "@holdfast/db";
import { getPaymentProvider } from "../payment/mockProvider.ts";
import { parseEscrowMode } from "@holdfast/shared";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/payments", {
    // Read body as raw string so we can verify the HMAC before parsing.
    config: { rawBody: true },
  }, async (request, reply) => {
    const provider = getPaymentProvider();
    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
    const signature = (request.headers["x-webhook-signature"] as string) ?? "";

    const verified = await provider.verifyWebhook(rawBody, signature);
    if (!verified.ok) {
      // Return 200 to prevent the partner retrying — log for investigation.
      app.log.warn({ event: "webhook_invalid_signature" }, "Webhook signature mismatch");
      return reply.status(200).send({ ok: false, reason: "invalid_signature" });
    }

    // Idempotency check: try to insert webhook_events; skip if already processed.
    let alreadyProcessed = false;
    try {
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload =
          typeof request.body === "object" && request.body !== null
            ? (request.body as Record<string, unknown>)
            : (JSON.parse(rawBody) as Record<string, unknown>);
      } catch {
        parsedPayload = {};
      }
      await db.insert(schema.webhook_events).values({
        provider: "payment",
        event_id: verified.event_id,
        payload: parsedPayload,
      });
    } catch (err: unknown) {
      // Unique constraint violation = duplicate delivery.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate") || msg.includes("unique") || msg.includes("23505")) {
        alreadyProcessed = true;
      } else {
        throw err;
      }
    }

    if (alreadyProcessed) {
      app.log.info({ event_id: verified.event_id }, "Duplicate webhook ignored");
      return reply.status(200).send({ ok: true, duplicate: true });
    }

    // Only handle successful payment events.
    if (verified.event_type !== "charge.success") {
      await db
        .update(schema.webhook_events)
        .set({ processed_at: new Date() })
        .where(
          and(
            eq(schema.webhook_events.provider, "payment"),
            eq(schema.webhook_events.event_id, verified.event_id),
          ),
        );
      return reply.status(200).send({ ok: true });
    }

    // Find the order by its payment reference stored in note.
    const eventRows = await db
      .select()
      .from(schema.order_events)
      .where(
        // The order reference is stored in the Funded event's note.note.reference field.
        eq(schema.order_events.to_status, "Funded"),
      )
      .limit(200);

    const matchingEvent = eventRows.find(
      (e) =>
        e.note &&
        typeof e.note === "object" &&
        (e.note as Record<string, unknown>)["payment_reference"] === verified.reference,
    );

    if (!matchingEvent) {
      app.log.warn({ reference: verified.reference }, "No order found for payment reference");
      await db
        .update(schema.webhook_events)
        .set({ processed_at: new Date() })
        .where(
          and(
            eq(schema.webhook_events.provider, "payment"),
            eq(schema.webhook_events.event_id, verified.event_id),
          ),
        );
      return reply.status(200).send({ ok: true });
    }

    // Fetch order to verify existence and check for reordering / delays
    const order = await db.query.orders.findFirst({
      where: eq(schema.orders.id, matchingEvent.order_id),
    });

    if (!order) {
      app.log.warn({ order_id: matchingEvent.order_id }, "Matching event found but order missing");
      await db
        .update(schema.webhook_events)
        .set({ processed_at: new Date() })
        .where(
          and(
            eq(schema.webhook_events.provider, "payment"),
            eq(schema.webhook_events.event_id, verified.event_id),
          ),
        );
      return reply.status(200).send({ ok: true, reason: "order_missing" });
    }

    // Amount check: if partner reports an amount differing from order amount, record issue
    if (verified.amount_minor > 0n && verified.amount_minor !== order.amount_minor) {
      app.log.warn(
        {
          order_id: order.id,
          expected: order.amount_minor.toString(),
          received: verified.amount_minor.toString(),
        },
        "Webhook payment amount mismatch",
      );
      await db.insert(schema.reconciliation_issues).values({
        order_id: order.id,
        issue_type: "AMOUNT_MISMATCH",
        detail: {
          reference: verified.reference,
          expected: order.amount_minor.toString(),
          actual: verified.amount_minor.toString(),
          event_id: verified.event_id,
        },
      });
    }

    // Reordering / Delay check: If order has already transitioned to a terminal status
    if (["Released", "Refunded", "Resolved"].includes(order.status)) {
      app.log.info(
        { order_id: order.id, status: order.status },
        "Delayed or reordered webhook arrived for terminal order",
      );
      await db
        .update(schema.webhook_events)
        .set({ processed_at: new Date() })
        .where(
          and(
            eq(schema.webhook_events.provider, "payment"),
            eq(schema.webhook_events.event_id, verified.event_id),
          ),
        );
      return reply.status(200).send({ ok: true, reason: "already_terminal" });
    }

    const escrowMode = parseEscrowMode(process.env["ESCROW_MODE"]);

    // In Mode A the order is already Funded when created; payment confirmation
    // just marks the webhook as processed.  In Mode B we would trigger on-chain
    // funding here — that integration is Day 4 chain service (ChainService).
    if (escrowMode === "B") {
      // TODO (Day 4): call ChainService.fundOrder(orderId, amount, token)
      app.log.info({ order_id: matchingEvent.order_id }, "Mode B on-chain funding: TODO");
    }

    await db
      .update(schema.webhook_events)
      .set({ processed_at: new Date() })
      .where(
        and(
          eq(schema.webhook_events.provider, "payment"),
          eq(schema.webhook_events.event_id, verified.event_id),
        ),
      );

    reply.status(200).send({ ok: true });
  });

  // POST /v1/webhooks/kyc — handled by KYC layer (see kyc.ts)
  app.post("/kyc", async (request, reply) => {
    const rawBody = (request.body as string) ?? "";
    app.log.info({ body_length: rawBody.length }, "KYC webhook received");
    // Full KYC webhook processing is in kyc.ts; this stub records receipt.
    reply.status(200).send({ ok: true });
  });
}
