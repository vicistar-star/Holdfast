/**
 * apps/worker/src/keeper.ts
 *
 * Keeper worker for Holdfast.
 *
 * Responsibilities:
 * 1. Scan for orders where status=Funded and ship_by has passed -> claim_refund.
 * 2. Scan for orders where status=Shipped, review_ends has passed, and no dispute exists -> claim_auto_release.
 * 3. Drive partner refund/payout in Mode A (fee deducted from seller payout only, refunds fee-free).
 * 4. In Mode B (on-chain), invoke permissionless contract timeout calls.
 * 5. Idempotent: "already settled" / terminal status is treated as success.
 * 6. Controllable clock (for tests).
 * 7. Alert hook when an order is past deadline by more than a configured margin.
 * 8. BullMQ queue with exponential backoff and dead-letter queue (keeper-dlq).
 */

import {
  db,
  schema,
  eq,
  and,
  sql,
} from "@holdfast/db";
import {
  computeFee,
  assertConservation,
  parseEscrowMode,
  type PaymentProvider,
} from "@holdfast/shared";
import { Queue, Worker, type Job, type RedisOptions } from "bullmq";

export type Clock = () => Date;

export interface KeeperAlert {
  orderId: string;
  type: "refund" | "auto_release";
  deadline: Date;
  now: Date;
  overdueMs: number;
}

export type AlertHook = (alert: KeeperAlert) => void;

export interface KeeperOptions {
  clock?: Clock;
  paymentProvider?: PaymentProvider;
  alertMarginSecs?: number;
  onAlert?: AlertHook;
  feeBps?: bigint;
  escrowMode?: "A" | "B";
  redisOptions?: RedisOptions;
}

export interface SettleResult {
  ok: boolean;
  orderId: string;
  action: "refund" | "auto_release" | "noop";
  skipped?: boolean;
  reason?: string;
  error?: string;
  payoutAmountMinor?: bigint;
  feeMinor?: bigint;
}

export class KeeperService {
  private readonly clock: Clock;
  private readonly paymentProvider: PaymentProvider | undefined;
  private readonly alertMarginSecs: number;
  private readonly onAlert: AlertHook | undefined;
  private readonly feeBps: bigint;
  private readonly escrowMode: "A" | "B";
  private queue: Queue | null = null;
  private dlq: Queue | null = null;
  private worker: Worker | null = null;

  constructor(opts: KeeperOptions = {}) {
    this.clock = opts.clock ?? (() => new Date());
    this.paymentProvider = opts.paymentProvider;
    this.alertMarginSecs =
      opts.alertMarginSecs ??
      Number(process.env["KEEPER_ALERT_MARGIN_SECS"] ?? "900");
    this.onAlert = opts.onAlert;
    this.feeBps = opts.feeBps ?? BigInt(process.env["FEE_BPS"] ?? "100");
    this.escrowMode = opts.escrowMode ?? parseEscrowMode(process.env["ESCROW_MODE"]);
  }

  // ── Single order settlement (idempotent) ──────────────────────────────────

  /**
   * Settle an expired Funded order by executing a full fee-free refund.
   * If the order has already moved past Funded, gracefully returns skipped: true.
   */
  async settleRefund(orderId: string): Promise<SettleResult> {
    const now = this.clock();

    const order = await db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });

    if (!order) {
      return { ok: false, orderId, action: "refund", error: "Order not found" };
    }

    // Idempotency: "already settled" is success per README
    if (order.status !== "Funded") {
      return {
        ok: true,
        orderId,
        action: "refund",
        skipped: true,
        reason: `already_${order.status.toLowerCase()}`,
      };
    }

    const shipBy = new Date(order.ship_by);
    if (now <= shipBy) {
      return {
        ok: false,
        orderId,
        action: "refund",
        error: "ship_by deadline has not passed yet",
      };
    }

    // Check overdue margin for alert
    const overdueMs = now.getTime() - shipBy.getTime();
    if (overdueMs > this.alertMarginSecs * 1000) {
      this.onAlert?.({
        orderId: order.id,
        type: "refund",
        deadline: shipBy,
        now,
        overdueMs,
      });
    }

    // 1. Update state BEFORE transfers (README rule 8)
    await db.transaction(async (tx) => {
      await tx
        .update(schema.orders)
        .set({ status: "Refunded" })
        .where(and(eq(schema.orders.id, order.id), eq(schema.orders.status, "Funded")));

      await tx.insert(schema.order_events).values({
        order_id: order.id,
        from_status: "Funded",
        to_status: "Refunded",
        actor: "keeper",
        note: {
          reason: "ship_by_deadline_passed",
          deadline: shipBy.toISOString(),
          settled_at: now.toISOString(),
        },
      });
    });

    // 2. Drive partner refund (Mode A)
    if (this.escrowMode === "A" && this.paymentProvider) {
      const partnerRef = `refund_${order.id}`;
      const payoutRes = await this.paymentProvider.createRefund({
        idempotency_key: partnerRef,
        amount_minor: order.amount_minor,
        currency: order.currency,
        account_ref: order.buyer_phone,
        narration: `Refund for order ${order.id}`,
      });

      await db
        .insert(schema.payouts)
        .values({
          order_id: order.id,
          party: "buyer",
          amount_minor: order.amount_minor,
          partner_ref: payoutRes.partner_ref,
          status: payoutRes.status,
        })
        .onConflictDoNothing();
    }

    return {
      ok: true,
      orderId: order.id,
      action: "refund",
      payoutAmountMinor: order.amount_minor,
      feeMinor: 0n,
    };
  }

  /**
   * Settle an expired review window on a Shipped order via claim_auto_release.
   * If a dispute is open, skips auto-release.
   * If already transitioned out of Shipped, gracefully returns skipped: true.
   */
  async settleAutoRelease(orderId: string): Promise<SettleResult> {
    const now = this.clock();

    const order = await db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });

    if (!order) {
      return { ok: false, orderId, action: "auto_release", error: "Order not found" };
    }

    // Idempotency: "already settled" is success
    if (order.status !== "Shipped") {
      return {
        ok: true,
        orderId,
        action: "auto_release",
        skipped: true,
        reason: `already_${order.status.toLowerCase()}`,
      };
    }

    // Check for open dispute
    const dispute = await db.query.disputes.findFirst({
      where: eq(schema.disputes.order_id, order.id),
    });
    if (dispute) {
      return {
        ok: true,
        orderId,
        action: "auto_release",
        skipped: true,
        reason: "order_disputed",
      };
    }

    if (!order.review_ends) {
      return {
        ok: false,
        orderId,
        action: "auto_release",
        error: "review_ends timestamp not set on order",
      };
    }

    const reviewEnds = new Date(order.review_ends);
    if (now <= reviewEnds) {
      return {
        ok: false,
        orderId,
        action: "auto_release",
        error: "review window has not passed yet",
      };
    }

    // Check overdue margin for alert
    const overdueMs = now.getTime() - reviewEnds.getTime();
    if (overdueMs > this.alertMarginSecs * 1000) {
      this.onAlert?.({
        orderId: order.id,
        type: "auto_release",
        deadline: reviewEnds,
        now,
        overdueMs,
      });
    }

    // Fee calculation (README rule 6: fees apply to payouts only, rounds down)
    const fee = computeFee(order.amount_minor, this.feeBps);
    const sellerNet = order.amount_minor - fee;
    assertConservation(order.amount_minor, sellerNet, fee);

    // 1. Update state BEFORE transfers (README rule 8)
    await db.transaction(async (tx) => {
      await tx
        .update(schema.orders)
        .set({ status: "Released" })
        .where(and(eq(schema.orders.id, order.id), eq(schema.orders.status, "Shipped")));

      await tx.insert(schema.order_events).values({
        order_id: order.id,
        from_status: "Shipped",
        to_status: "Released",
        actor: "keeper",
        note: {
          how: "auto",
          fee: fee.toString(),
          to_seller: sellerNet.toString(),
          settled_at: now.toISOString(),
        },
      });
    });

    // 2. Drive partner payout (Mode A)
    if (this.escrowMode === "A" && this.paymentProvider) {
      const seller = await db.query.sellers.findFirst({
        where: eq(schema.sellers.user_id, order.seller_id),
      });

      const partnerRef = `auto_release_${order.id}`;
      const payoutRes = await this.paymentProvider.createPayout({
        idempotency_key: partnerRef,
        amount_minor: sellerNet,
        currency: order.currency,
        account_ref: seller?.payout_ref ?? `seller_${order.seller_id}`,
        narration: `Auto-release payout for order ${order.id}`,
      });

      await db
        .insert(schema.payouts)
        .values({
          order_id: order.id,
          party: "seller",
          amount_minor: sellerNet,
          partner_ref: payoutRes.partner_ref,
          status: payoutRes.status,
        })
        .onConflictDoNothing();
    }

    return {
      ok: true,
      orderId: order.id,
      action: "auto_release",
      payoutAmountMinor: sellerNet,
      feeMinor: fee,
    };
  }

  // ── Scheduled scan ────────────────────────────────────────────────────────

  /**
   * Scans for all eligible orders and executes settlement directly.
   * Safe to call on a cron schedule or BullMQ job.
   */
  async runScan(): Promise<{
    refunds: SettleResult[];
    autoReleases: SettleResult[];
  }> {
    const now = this.clock();

    // 1. Scan for eligible refunds: Funded and ship_by < now
    const refundableOrders = await db
      .select({ id: schema.orders.id, ship_by: schema.orders.ship_by })
      .from(schema.orders)
      .where(
        sql`${schema.orders.status} = 'Funded' AND ${schema.orders.ship_by} < ${now}`,
      );

    const refunds: SettleResult[] = [];
    for (const order of refundableOrders) {
      const res = await this.settleRefund(order.id);
      refunds.push(res);
    }

    // 2. Scan for eligible auto-releases: Shipped and review_ends < now
    const autoReleasableOrders = await db
      .select({ id: schema.orders.id, review_ends: schema.orders.review_ends })
      .from(schema.orders)
      .where(
        sql`${schema.orders.status} = 'Shipped' AND ${schema.orders.review_ends} < ${now}`,
      );

    const autoReleases: SettleResult[] = [];
    for (const order of autoReleasableOrders) {
      const res = await this.settleAutoRelease(order.id);
      autoReleases.push(res);
    }

    return { refunds, autoReleases };
  }

  // ── BullMQ worker and queue ───────────────────────────────────────────────

  /** Initialize BullMQ queue and worker if Redis configuration is provided. */
  initBullMQ(redisOptions: RedisOptions): {
    queue: Queue;
    dlq: Queue;
    worker: Worker;
  } {
    const connection = redisOptions;

    this.queue = new Queue("keeper", {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    });

    this.dlq = new Queue("keeper-dlq", { connection });

    this.worker = new Worker(
      "keeper",
      async (job: Job<{ orderId: string; type: "refund" | "auto_release" }>) => {
        const { orderId, type } = job.data;
        if (type === "refund") {
          const res = await this.settleRefund(orderId);
          if (!res.ok) throw new Error(res.error ?? "Refund failed");
          return res;
        } else {
          const res = await this.settleAutoRelease(orderId);
          if (!res.ok) throw new Error(res.error ?? "Auto-release failed");
          return res;
        }
      },
      { connection },
    );

    // Route permanently failed jobs to DLQ
    this.worker.on("failed", (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
        void this.dlq?.add("dead-letter", {
          originalJobId: job.id,
          data: job.data as object,
          failedReason: err.message,
          failedAt: new Date().toISOString(),
        });
      }
    });

    return { queue: this.queue, dlq: this.dlq, worker: this.worker };
  }

  async close(): Promise<void> {
    if (this.worker) await this.worker.close();
    if (this.queue) await this.queue.close();
    if (this.dlq) await this.dlq.close();
  }
}
