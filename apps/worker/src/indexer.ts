/**
 * apps/worker/src/indexer.ts
 *
 * Soroban RPC Event Indexer for Holdfast.
 *
 * Responsibilities:
 * 1. Poll Soroban RPC getEvents with a cursor persisted in Postgres (indexer_cursors).
 * 2. Writes every transition into order_events and updates the orders projection.
 * 3. Safe to restart — resumes from the persisted cursor and last ledger.
 * 4. Idempotent: replaying the same events twice produces identical state.
 * 5. Out-of-order or duplicate events do not corrupt or regress state.
 *
 * Note on Soroban RPC history window:
 * Public RPC nodes only retain a rolling window of history (typically ~24h / ~17,280 ledgers).
 * The indexer must persist its cursor and run continuously. For historical backfill beyond
 * the window, an archive RPC node or Hubble is required.
 */

import {
  db,
  schema,
  eq,
} from "@holdfast/db";
import type { OrderStatus } from "@holdfast/shared";

export interface DecodedContractEvent {
  id: bigint; // Contract order ID
  topic: string; // "funded" | "shipped" | "released" | "refunded" | "disputed" | "resolved"
  ledger: number;
  txHash: string;
  pagingToken: string;
  timestamp: Date;
  data: {
    buyer?: string;
    seller?: string;
    token?: string;
    amount?: bigint;
    shipBy?: bigint;
    shippedAt?: bigint;
    toSeller?: bigint;
    fee?: bigint;
    how?: "confirmed" | "auto";
    openedAt?: bigint;
    buyerShare?: bigint;
    sellerShare?: bigint;
  };
}

export interface SorobanEventSource {
  getEvents(params: {
    startLedger?: number | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ events: DecodedContractEvent[]; latestLedger: number }>;
}

export class EventIndexerService {
  private readonly eventSource: SorobanEventSource;
  private readonly cursorId: string;
  private readonly dbClient: typeof db;

  constructor(eventSource: SorobanEventSource, cursorId = "default", dbClient: typeof db = db) {
    this.eventSource = eventSource;
    this.cursorId = cursorId;
    this.dbClient = dbClient;
  }

  /** Retrieve the persisted cursor from Postgres. */
  async getPersistedCursor(): Promise<{
    lastLedger: number;
    cursor: string | null;
  } | null> {
    const row = await this.dbClient.query.indexer_cursors.findFirst({
      where: eq(schema.indexer_cursors.id, this.cursorId),
    });
    if (!row) return null;
    return { lastLedger: row.last_ledger, cursor: row.cursor };
  }

  /** Update the persisted cursor in Postgres. */
  async saveCursor(lastLedger: number, cursor: string): Promise<void> {
    await this.dbClient
      .insert(schema.indexer_cursors)
      .values({
        id: this.cursorId,
        last_ledger: lastLedger,
        cursor,
        updated_at: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.indexer_cursors.id,
        set: {
          last_ledger: lastLedger,
          cursor,
          updated_at: new Date(),
        },
      });
  }

  /**
   * Process a single contract event into order_events and update the orders projection.
   * Completely idempotent and resilient to out-of-order delivery.
   */
  async processEvent(event: DecodedContractEvent): Promise<{
    ok: boolean;
    applied: boolean;
    reason?: string;
  }> {
    const toStatus = mapTopicToStatus(event.topic);
    if (!toStatus) {
      return { ok: false, applied: false, reason: `Unknown event topic: ${event.topic}` };
    }

    // Find order by on-chain chain_id
    const order = await this.dbClient.query.orders.findFirst({
      where: eq(schema.orders.chain_id, event.id),
    });

    if (!order) {
      // In Mode B, if an order exists only on-chain, we log and skip projection
      return { ok: true, applied: false, reason: "Order not found in DB projection" };
    }

    // Deduplication check: check if this exact event was already recorded
    const existingEvents = await this.dbClient.query.order_events.findMany({
      where: eq(schema.order_events.order_id, order.id),
    });

    const isDuplicate = existingEvents.some((e) => {
      const note = e.note as Record<string, unknown> | null;
      return e.to_status === toStatus && (e.tx_hash === event.txHash || note?.["on_chain_event"] === true);
    });

    if (isDuplicate) {
      return { ok: true, applied: false, reason: "duplicate_event" };
    }

    // Monotonic state progression check: do NOT regress state on out-of-order replay
    const currentStatus = order.status as OrderStatus;
    const shouldUpdateStatus = canAdvanceStatus(currentStatus, toStatus);

    await this.dbClient.transaction(async (tx) => {
      // 1. Insert into append-only order_events
      await tx.insert(schema.order_events).values({
        order_id: order.id,
        from_status: currentStatus,
        to_status: toStatus,
        actor: mapActorForTopic(event.topic, event.data.how),
        tx_hash: event.txHash,
        note: {
          on_chain_event: true,
          ledger: event.ledger,
          topic: event.topic,
          data: stringifyBigInts(event.data),
        },
      });

      // 2. Advance orders projection if monotonic progression allows
      if (shouldUpdateStatus) {
        const updates: Partial<typeof schema.orders.$inferInsert> = {
          status: toStatus,
        };

        if (event.topic === "shipped" && event.data.shippedAt) {
          const shippedDate = new Date(Number(event.data.shippedAt) * 1000);
          updates.shipped_at = shippedDate;
        }

        await tx
          .update(schema.orders)
          .set(updates)
          .where(eq(schema.orders.id, order.id));
      }
    });

    return { ok: true, applied: true };
  }

  /**
   * Run a single poll batch from the Soroban RPC event source.
   */
  async poll(): Promise<{ processedCount: number; latestLedger: number }> {
    const saved = await this.getPersistedCursor();
    const startLedger = saved ? saved.lastLedger : undefined;
    const cursor = saved?.cursor ?? undefined;

    const { events, latestLedger } = await this.eventSource.getEvents({
      startLedger,
      cursor,
      limit: 50,
    });

    let processedCount = 0;
    let lastToken = cursor ?? "";

    for (const evt of events) {
      await this.processEvent(evt);
      processedCount++;
      lastToken = evt.pagingToken;
    }

    if (lastToken) {
      await this.saveCursor(latestLedger, lastToken);
    }

    return { processedCount, latestLedger };
  }

  /**
   * Backfill events starting from a specific ledger number.
   */
  async backfill(startLedger: number): Promise<{ processedCount: number }> {
    let currentCursor: string | undefined = undefined;
    let totalProcessed = 0;

    for (let page = 0; page < 100; page++) {
      const { events } = await this.eventSource.getEvents({
        startLedger,
        cursor: currentCursor,
        limit: 100,
      });

      if (events.length === 0) break;

      for (const evt of events) {
        await this.processEvent(evt);
        totalProcessed++;
        currentCursor = evt.pagingToken;
      }
    }

    return { processedCount: totalProcessed };
  }
}

// ── State machine helpers ───────────────────────────────────────────────────

function mapTopicToStatus(topic: string): OrderStatus | null {
  switch (topic.toLowerCase()) {
    case "funded":
      return "Funded";
    case "shipped":
      return "Shipped";
    case "released":
      return "Released";
    case "refunded":
      return "Refunded";
    case "disputed":
      return "Disputed";
    case "resolved":
      return "Resolved";
    default:
      return null;
  }
}

function mapActorForTopic(topic: string, how?: "confirmed" | "auto"): string {
  switch (topic.toLowerCase()) {
    case "funded":
      return "buyer";
    case "shipped":
      return "seller";
    case "released":
      return how === "auto" ? "keeper" : "buyer";
    case "refunded":
      return "keeper";
    case "disputed":
      return "buyer";
    case "resolved":
      return "arbiter";
    default:
      return "system";
  }
}

const TERMINAL_SET = new Set<OrderStatus>(["Released", "Refunded", "Resolved"]);

/**
 * Ensures monotonic state progression so replayed or out-of-order events
 * cannot corrupt or regress an order.
 */
export function canAdvanceStatus(current: OrderStatus, target: OrderStatus): boolean {
  if (current === target) return false;
  if (TERMINAL_SET.has(current)) return false; // Terminal states are final per README
  if (current === "Disputed" && (target === "Funded" || target === "Shipped")) return false;
  if (current === "Shipped" && target === "Funded") return false;
  return true;
}

function stringifyBigInts(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "bigint") {
      result[key] = value.toString();
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
