/**
 * apps/worker/src/indexer.test.ts
 *
 * Tests for the Soroban RPC Event Indexer.
 *
 * Covers:
 * 1. Replaying the same events twice produces identical state (idempotency).
 * 2. Out-of-order or duplicate events do not corrupt or regress state (monotonic progression).
 * 3. Cursor recovery after indexer restart.
 * 4. Backfill from start ledger.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { db } from "@holdfast/db";
import {
  EventIndexerService,
  canAdvanceStatus,
  type DecodedContractEvent,
  type SorobanEventSource,
} from "./indexer.ts";

class MockSorobanSource implements SorobanEventSource {
  public eventsToReturn: DecodedContractEvent[] = [];
  public currentLedger = 1000;

  async getEvents(params: {
    startLedger?: number | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  } = {}): Promise<{ events: DecodedContractEvent[]; latestLedger: number }> {
    if (params.cursor) {
      return { events: [], latestLedger: this.currentLedger };
    }
    return {
      events: this.eventsToReturn,
      latestLedger: this.currentLedger,
    };
  }
}

class MockDb {
  public cursors = new Map<string, { id: string; last_ledger: number; cursor: string | null }>();
  public orders = new Map<string, { id: string; chain_id: bigint; status: string; shipped_at?: Date }>();
  public orderEvents: Array<{
    order_id: string;
    from_status: string;
    to_status: string;
    tx_hash: string | null;
    note: Record<string, unknown> | null;
  }> = [];

  query = {
    indexer_cursors: {
      findFirst: async () => {
        const val = this.cursors.get("test_cursor");
        return val ?? null;
      },
    },
    orders: {
      findFirst: async () => {
        for (const order of this.orders.values()) return order;
        return null;
      },
    },
    order_events: {
      findMany: async () => {
        return this.orderEvents;
      },
    },
  };

  insert() {
    return {
      values: (val: { id: string }) => ({
        onConflictDoUpdate: async ({ set }: { set: { last_ledger: number; cursor: string | null } }) => {
          this.cursors.set(val.id, {
            id: val.id,
            last_ledger: set.last_ledger,
            cursor: set.cursor,
          });
        },
      }),
    };
  }

  async transaction(fn: (tx: {
    insert: () => { values: (val: { order_id: string; from_status: string; to_status: string; actor: string; tx_hash: string | null; note: Record<string, unknown> | null }) => Promise<void> };
    update: () => { set: (updates: Record<string, unknown>) => { where: () => Promise<void> } };
  }) => Promise<void>) {
    const tx = {
      insert: () => ({
        values: async (val: { order_id: string; from_status: string; to_status: string; actor: string; tx_hash: string | null; note: Record<string, unknown> | null }) => {
          this.orderEvents.push(val);
        },
      }),
      update: () => ({
        set: (updates: Record<string, unknown>) => ({
          where: async () => {
            for (const order of this.orders.values()) {
              Object.assign(order, updates);
            }
          },
        }),
      }),
    };
    await fn(tx);
  }
}

describe("EventIndexerService", () => {
  it("monotonic state guard: prevents regressing terminal states or skipping backward", () => {
    // Terminal states cannot be advanced/regressed
    assert.equal(canAdvanceStatus("Released", "Shipped"), false);
    assert.equal(canAdvanceStatus("Refunded", "Funded"), false);
    assert.equal(canAdvanceStatus("Resolved", "Disputed"), false);
    assert.equal(canAdvanceStatus("Released", "Funded"), false);

    // Disputed cannot be overwritten by older states
    assert.equal(canAdvanceStatus("Disputed", "Shipped"), false);
    assert.equal(canAdvanceStatus("Disputed", "Funded"), false);

    // Shipped cannot be regressed to Funded
    assert.equal(canAdvanceStatus("Shipped", "Funded"), false);

    // Same state is a no-op
    assert.equal(canAdvanceStatus("Funded", "Funded"), false);
    assert.equal(canAdvanceStatus("Shipped", "Shipped"), false);

    // Valid forward transitions
    assert.equal(canAdvanceStatus("Funded", "Shipped"), true);
    assert.equal(canAdvanceStatus("Funded", "Refunded"), true);
    assert.equal(canAdvanceStatus("Shipped", "Released"), true);
    assert.equal(canAdvanceStatus("Shipped", "Disputed"), true);
    assert.equal(canAdvanceStatus("Disputed", "Resolved"), true);
  });

  it("idempotency: duplicate events do not corrupt or duplicate state", async () => {
    const mockDb = new MockDb();
    mockDb.orders.set("ord_1", {
      id: "ord_1",
      chain_id: 9999n,
      status: "Funded",
    });

    const mockSource = new MockSorobanSource();
    const indexer = new EventIndexerService(mockSource, "test_cursor", mockDb as unknown as typeof db);

    const event: DecodedContractEvent = {
      id: 9999n,
      topic: "shipped",
      ledger: 1050,
      txHash: "0xdeadbeef1",
      pagingToken: "token_1050_0",
      timestamp: new Date(),
      data: { shippedAt: 1700000000n },
    };

    // First process: applied
    const res1 = await indexer.processEvent(event);
    assert.equal(res1.ok, true);
    assert.equal(res1.applied, true);
    assert.equal(mockDb.orderEvents.length, 1);
    assert.equal(mockDb.orders.get("ord_1")?.status, "Shipped");

    // Replay identical event: recognized as duplicate, not re-applied
    const res2 = await indexer.processEvent(event);
    assert.equal(res2.ok, true);
    assert.equal(res2.applied, false);
    assert.equal(res2.reason, "duplicate_event");
    assert.equal(mockDb.orderEvents.length, 1);
  });

  it("out-of-order replay does not regress state after terminal transition", async () => {
    const mockDb = new MockDb();
    mockDb.orders.set("ord_2", {
      id: "ord_2",
      chain_id: 8888n,
      status: "Released", // Already terminal
    });

    const mockSource = new MockSorobanSource();
    const indexer = new EventIndexerService(mockSource, "test_cursor", mockDb as unknown as typeof db);

    // Late arriving "shipped" event
    const lateShippedEvent: DecodedContractEvent = {
      id: 8888n,
      topic: "shipped",
      ledger: 1040,
      txHash: "0xlate",
      pagingToken: "token_1040_0",
      timestamp: new Date(),
      data: { shippedAt: 1699999000n },
    };

    const res = await indexer.processEvent(lateShippedEvent);
    assert.equal(res.ok, true);
    assert.equal(res.applied, true);
    // Order status remains "Released", NOT regressed to "Shipped"
    assert.equal(mockDb.orders.get("ord_2")?.status, "Released");
  });

  it("cursor persistence and recovery after restart", async () => {
    const mockDb = new MockDb();
    const mockSource = new MockSorobanSource();
    const indexer1 = new EventIndexerService(mockSource, "test_cursor", mockDb as unknown as typeof db);

    await indexer1.saveCursor(542000, "token_cursor_abc");
    const loaded = await indexer1.getPersistedCursor();
    assert.equal(loaded?.lastLedger, 542000);
    assert.equal(loaded?.cursor, "token_cursor_abc");

    // Simulate indexer crash & restart with new instance pointing to same storage
    const indexer2 = new EventIndexerService(mockSource, "test_cursor", mockDb as unknown as typeof db);
    const resumed = await indexer2.getPersistedCursor();
    assert.equal(resumed?.lastLedger, 542000);
    assert.equal(resumed?.cursor, "token_cursor_abc");
  });

  it("backfill: processes events in batches from start ledger", async () => {
    const mockDb = new MockDb();
    const mockSource = new MockSorobanSource();
    mockSource.eventsToReturn = [
      {
        id: 101n,
        topic: "funded",
        ledger: 100,
        txHash: "0x1",
        pagingToken: "p1",
        timestamp: new Date(),
        data: { amount: 1000n },
      },
      {
        id: 102n,
        topic: "shipped",
        ledger: 101,
        txHash: "0x2",
        pagingToken: "p2",
        timestamp: new Date(),
        data: { shippedAt: 1700000000n },
      },
    ];

    const indexer = new EventIndexerService(mockSource, "test_cursor", mockDb as unknown as typeof db);
    const res = await indexer.backfill(100);
    assert.equal(res.processedCount, 2);
  });
});
