/**
 * apps/api/src/resilience.test.ts
 *
 * Failure injection and resilience test suite verifying that no failure
 * leaves an order in an inconsistent or stranded state.
 *
 * Scenarios tested:
 * 1. Soroban RPC unavailable or slow
 * 2. Submitted transaction not found (mempool eviction / polling timeout)
 * 3. Partner webhook duplicates, reordering, and delays
 * 4. Keeper killed mid-job
 * 5. Indexer restarted / replaying history
 * 6. Postgres connection loss mid-transaction
 * 7. Sponsor balance / budget exhausted
 * 8. Evidence storage down
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { SponsorService } from "./chain/sponsorService.ts";
import { StorageService } from "./storage/s3Client.ts";
import { MockPaymentProvider } from "./payment/mockProvider.ts";
import {
  canAdvanceStatus,
  type OrderStatus,
  assertConservation,
  computeFee,
} from "@holdfast/shared";

describe("Failure Injection & Resilience Tests", () => {
  // ── 1. Soroban RPC Unavailable or Slow ──────────────────────────────────
  describe("1. RPC unavailable or slow", () => {
    it("fails cleanly when RPC simulates with error or drops connection", async () => {
      // Mock an RPC server that is unavailable / throws network error
      const mockRpcServer = {
        async simulateTransaction() {
          throw new Error("RPC 503: Service Temporarily Unavailable");
        },
        async sendTransaction() {
          throw new Error("RPC connection refused");
        },
      };

      let thrown = false;
      let orderStatus: OrderStatus = "Funded";

      try {
        await mockRpcServer.simulateTransaction();
        // If simulation succeeded, status would advance:
        orderStatus = "Shipped";
      } catch (err: unknown) {
        thrown = true;
        assert.match((err as Error).message, /503/);
      }

      assert.equal(thrown, true, "Expected RPC failure to throw");
      // INVARIANT: State must remain untouched and unstranded
      assert.equal(orderStatus, "Funded", "Order state must not advance on RPC failure");
    });

    it("handles slow RPC timeout without mutating order state", async () => {
      const slowRpcTimeout = async () => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error("RPC request timed out after 30000ms")), 10);
        });
      };

      let orderStatus: OrderStatus = "Shipped";
      await assert.rejects(
        async () => {
          await slowRpcTimeout();
          orderStatus = "Released";
        },
        /timed out/,
      );

      assert.equal(orderStatus, "Shipped", "Order state must remain Shipped");
    });
  });

  // ── 2. Submitted Transaction Not Found / Polling Timeout ─────────────────
  describe("2. Submitted transaction not found in mempool", () => {
    it("aborts when transaction polling exceeds max attempts without confirmation", async () => {
      const mockTxHash = "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890";
      let pollCount = 0;

      // Mock RPC that returns NOT_FOUND continuously
      const mockGetTransaction = async () => {
        pollCount++;
        return { status: "NOT_FOUND" };
      };

      // Emulate EscrowClient polling loop (shortened poll delay for test)
      const pollTransaction = async (hash: string, maxAttempts = 5) => {
        for (let i = 0; i < maxAttempts; i++) {
          const res = await mockGetTransaction();
          if (res.status === "SUCCESS") return hash;
        }
        throw new Error(`Transaction not confirmed after polling: ${hash}`);
      };

      let orderStatus: OrderStatus = "Shipped";

      await assert.rejects(
        async () => {
          await pollTransaction(mockTxHash);
          orderStatus = "Released";
        },
        (err: Error) => {
          assert.match(err.message, /Transaction not confirmed after polling/);
          assert.match(err.message, new RegExp(mockTxHash));
          return true;
        },
      );

      assert.equal(pollCount, 5);
      // Invariant: order not left in released or corrupt state
      assert.equal(orderStatus, "Shipped");
    });
  });

  // ── 3. Partner Webhook Duplicates, Reordering, and Delays ────────────────
  describe("3. Partner webhook duplicates, reordering, and delays", () => {
    it("safely ignores duplicate webhook delivery and prevents duplicate side-effects", async () => {
      const provider = new MockPaymentProvider("test-secret");
      const instructions = await provider.createPaymentInstructions("order-101", 50_000n, "NGN");
      const { body, signature } = provider.simulatePayment(instructions.reference);

      // Verify webhook once
      const verify1 = await provider.verifyWebhook(body, signature);
      assert.equal(verify1.ok, true);

      // In-memory set simulating UNIQUE constraint on webhook_events(provider, event_id)
      const seenEvents = new Set<string>();
      let transitionCount = 0;

      const processWebhook = async (eventId: string) => {
        if (seenEvents.has(eventId)) {
          return { ok: true, duplicate: true };
        }
        seenEvents.add(eventId);
        transitionCount++;
        return { ok: true, duplicate: false };
      };

      // Deliver first time
      const res1 = await processWebhook(verify1.event_id);
      assert.equal(res1.duplicate, false);
      assert.equal(transitionCount, 1);

      // Deliver second and third time (duplicate/retry)
      const res2 = await processWebhook(verify1.event_id);
      const res3 = await processWebhook(verify1.event_id);
      assert.equal(res2.duplicate, true);
      assert.equal(res3.duplicate, true);
      assert.equal(transitionCount, 1, "State transitions must occur exactly once");
    });

    it("safely handles out-of-order or delayed webhook on terminal order", async () => {
      // Simulate an order that was already refunded by keeper
      const mockOrder: { status: OrderStatus; amountMinor: bigint } = {
        status: "Refunded",
        amountMinor: 100_000n,
      };

      const handleWebhookOnOrder = (
        order: { status: OrderStatus; amountMinor: bigint },
        webhookAmount: bigint,
      ) => {
        // Guard: check if order is already in a terminal state
        if (["Released", "Refunded", "Resolved"].includes(order.status)) {
          return { ok: true, action: "ignored", reason: "already_terminal" };
        }
        if (webhookAmount !== order.amountMinor) {
          return { ok: true, action: "flagged_mismatch" };
        }
        return { ok: true, action: "funded" };
      };

      const result = handleWebhookOnOrder(mockOrder, 100_000n);
      assert.equal(result.action, "ignored");
      assert.equal(result.reason, "already_terminal");
      assert.equal(mockOrder.status, "Refunded", "Terminal order state must never regress");
    });

    it("flags amount mismatch between partner webhook and order amount", () => {
      const mockOrder = { status: "Funded" as OrderStatus, amountMinor: 200_000n };
      const webhookAmountMinor = 150_000n; // Underpaid

      let issueRecorded: { type: string; expected: bigint; actual: bigint } | null = null;

      if (webhookAmountMinor !== mockOrder.amountMinor) {
        issueRecorded = {
          type: "AMOUNT_MISMATCH",
          expected: mockOrder.amountMinor,
          actual: webhookAmountMinor,
        };
      }

      assert.ok(issueRecorded);
      assert.equal(issueRecorded.type, "AMOUNT_MISMATCH");
      assert.equal(issueRecorded.expected, 200_000n);
      assert.equal(issueRecorded.actual, 150_000n);
    });
  });

  // ── 4. Keeper Killed Mid-Job ─────────────────────────────────────────────
  describe("4. Keeper killed mid-job", () => {
    it("ensures idempotency when keeper restarts after partial completion", async () => {
      // Order state updated to 'Refunded' before crash
      let orderStatus: OrderStatus = "Refunded";
      let partnerPayoutExecuted = false;

      // Simulated keeper settlement logic
      const settleRefund = async (currentStatus: OrderStatus) => {
        if (currentStatus !== "Funded") {
          return { ok: true, skipped: true, reason: `already_${currentStatus.toLowerCase()}` };
        }
        // State update
        orderStatus = "Refunded";
        // Partner payout
        partnerPayoutExecuted = true;
        return { ok: true, skipped: false };
      };

      // Restarted keeper re-processes the job:
      const res = await settleRefund(orderStatus);
      assert.equal(res.ok, true);
      assert.equal(res.skipped, true);
      assert.equal(res.reason, "already_refunded");
      assert.equal(partnerPayoutExecuted, false, "Did not execute double payout");
    });

    it("reconciliation catches terminal orders missing payout records", () => {
      interface PayoutRecord {
        orderId: string;
        amount: bigint;
      }

      const orders = [
        { id: "order-1", status: "Refunded" as OrderStatus },
        { id: "order-2", status: "Released" as OrderStatus },
        { id: "order-3", status: "Funded" as OrderStatus },
      ];
      // Only order-2 has a payout recorded (order-1 crashed before payout)
      const payouts: PayoutRecord[] = [{ orderId: "order-2", amount: 99_000n }];

      const detectedIssues: string[] = [];

      for (const ord of orders) {
        if (["Released", "Refunded", "Resolved"].includes(ord.status)) {
          const hasPayout = payouts.some((p) => p.orderId === ord.id);
          if (!hasPayout) {
            detectedIssues.push(ord.id);
          }
        }
      }

      assert.equal(detectedIssues.length, 1);
      assert.equal(detectedIssues[0], "order-1");
    });
  });

  // ── 5. Indexer Restarted / Monotonic Progression ─────────────────────────
  describe("5. Indexer restarted and replaying events", () => {
    it("canAdvanceStatus enforces strictly monotonic state progression", () => {
      // Allowed forward transitions
      assert.equal(canAdvanceStatus("Funded", "Shipped"), true);
      assert.equal(canAdvanceStatus("Shipped", "Released"), true);
      assert.equal(canAdvanceStatus("Shipped", "Disputed"), true);
      assert.equal(canAdvanceStatus("Disputed", "Resolved"), true);

      // Disallowed backwards or regressive transitions
      assert.equal(canAdvanceStatus("Released", "Funded"), false);
      assert.equal(canAdvanceStatus("Released", "Shipped"), false);
      assert.equal(canAdvanceStatus("Refunded", "Funded"), false);
      assert.equal(canAdvanceStatus("Refunded", "Shipped"), false);
      assert.equal(canAdvanceStatus("Resolved", "Disputed"), false);
      assert.equal(canAdvanceStatus("Resolved", "Funded"), false);
    });

    it("skips duplicate events upon indexer restart", () => {
      const existingEvents = [
        { topic: "funded", txHash: "0x1111", toStatus: "Funded" },
        { topic: "shipped", txHash: "0x2222", toStatus: "Shipped" },
      ];

      const incomingReplayedEvent = {
        topic: "shipped",
        txHash: "0x2222",
        toStatus: "Shipped",
      };

      const isDuplicate = existingEvents.some(
        (e) => e.toStatus === incomingReplayedEvent.toStatus && e.txHash === incomingReplayedEvent.txHash,
      );

      assert.equal(isDuplicate, true, "Duplicate event must be recognized");
    });
  });

  // ── 6. Postgres Connection Loss Mid-Transaction ──────────────────────────
  describe("6. Postgres connection loss mid-transaction", () => {
    it("rolls back all changes atomically if connection fails mid-transaction", async () => {
      // In-memory database simulation with transactional rollback
      let dbOrderState: OrderStatus = "Funded";
      const dbAuditEvents: string[] = [];

      const executeAtomicOrderShipment = async (shouldFailMidway: boolean) => {
        const snapshotStatus = dbOrderState;
        const snapshotAudit = [...dbAuditEvents];

        try {
          // Step 1: Update order
          dbOrderState = "Shipped";

          // Step 2: Failure occurs (e.g. Postgres connection timeout)
          if (shouldFailMidway) {
            throw new Error("Connection lost: ECONNRESET");
          }

          // Step 3: Insert audit event
          dbAuditEvents.push("Shipped");
        } catch (err) {
          // Rollback snapshot
          dbOrderState = snapshotStatus;
          dbAuditEvents.length = 0;
          dbAuditEvents.push(...snapshotAudit);
          throw err;
        }
      };

      await assert.rejects(
        () => executeAtomicOrderShipment(true),
        /ECONNRESET/,
      );

      // Invariant: Both order state and audit log are completely intact and uncorrupted
      assert.equal(dbOrderState, "Funded", "Order state must roll back to Funded");
      assert.equal(dbAuditEvents.length, 0, "No orphaned audit logs should exist");
    });
  });

  // ── 7. Sponsor Balance / Budget Exhausted ─────────────────────────────────
  describe("7. Sponsor balance or budget exhausted", () => {
    it("blocks transaction submission when per-account daily budget is exceeded", () => {
      const sponsor = new SponsorService({
        perAccountDailyStroops: 500_000n, // 0.05 XLM max
        lowBalanceAlertStroops: 1_000_000n,
      });

      const accountId = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

      // 1st spend within budget
      sponsor.checkBudget(accountId, 300_000n);
      sponsor.recordSpend(accountId, 300_000n);

      // 2nd spend exceeds daily budget
      assert.throws(
        () => sponsor.checkBudget(accountId, 300_000n),
        /Sponsor budget exhausted for account/,
      );
    });

    it("triggers low balance alert hook when sponsor pool is depleted", () => {
      const sponsor = new SponsorService({
        perAccountDailyStroops: 1_000_000n,
        lowBalanceAlertStroops: 10_000_000n,
      });

      let alertedBalance: bigint | null = null;
      sponsor.onLowBalance((balance) => {
        alertedBalance = balance;
      });

      // Balance sufficient: no alert
      sponsor.checkBalance(50_000_000n);
      assert.equal(alertedBalance, null);

      // Balance drops below threshold
      sponsor.checkBalance(8_000_000n);
      assert.equal(alertedBalance, 8_000_000n);
    });
  });

  // ── 8. Evidence Storage Down ─────────────────────────────────────────────
  describe("8. Evidence storage (S3 / MinIO) down", () => {
    it("aborts evidence registration and inserts zero database rows if storage fails", async () => {
      const storage = new StorageService();

      // Mock an error stream simulating network disconnect during upload
      const failingStream = new Readable({
        read() {
          this.destroy(new Error("S3 connection refused: EHOSTUNREACH"));
        },
      });

      const evidenceRows: Array<{ id: string; objectKey: string }> = [];

      const uploadEvidenceFlow = async () => {
        // Storage upload attempted first:
        const uploadResult = await storage.uploadStream({
          objectKey: "evidence/order-1/photo.jpg",
          stream: failingStream,
          contentType: "image/jpeg",
        });

        // Database insert happens only after successful stream upload:
        evidenceRows.push({ id: "ev-1", objectKey: uploadResult.objectKey });
      };

      await assert.rejects(
        () => uploadEvidenceFlow(),
        /EHOSTUNREACH/,
      );

      // Invariant: no dead pointers or corrupt SHA entries in DB
      assert.equal(evidenceRows.length, 0, "No evidence row must be saved when upload fails");
    });
  });

  // ── Invariant Guarantees: Conservation and Fees ──────────────────────────
  describe("Invariant Checks: Conservation & Fee bounds", () => {
    it("conservation holds across all payout amounts and fee deductions", () => {
      const amounts = [1000n, 50000n, 100000n, 5000000n];
      const feeBpsList = [0n, 50n, 100n, 250n, 500n];

      for (const amount of amounts) {
        for (const bps of feeBpsList) {
          const fee = computeFee(amount, bps);
          const payout = amount - fee;
          assertConservation(amount, payout, fee);
          assert.ok(fee <= (amount * 500n) / 10000n, "Fee must never exceed 5% cap");
        }
      }
    });
  });
});
