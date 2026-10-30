/**
 * Reconciliation job — compares partner transactions with orders/payouts.
 *
 * Writes mismatches to reconciliation_issues. Exposes a run() function
 * callable from a CLI command or a scheduled cron.
 *
 * Issue types:
 *   - MISSING_ORDER:  partner shows a successful payment with no matching order
 *   - AMOUNT_MISMATCH: partner amount differs from order amount
 *   - PAYOUT_NOT_INITIATED: released/resolved order has no payout record
 *
 * This table addition is documented in docs/decisions.md.
 */
import { db, schema, eq } from "@holdfast/db";
import { getPaymentProvider } from "../payment/mockProvider.ts";

export async function runReconciliation(since: Date = new Date(Date.now() - 86_400_000)): Promise<{
  checked: number;
  issues: number;
}> {
  const provider = getPaymentProvider();
  const transactions = await provider.listTransactions(since);

  let issueCount = 0;

  for (const txn of transactions) {
    if (txn.status !== "success") continue;

    // Find the order whose Funded event contains this payment reference.
    const events = await db
      .select()
      .from(schema.order_events)
      .where(eq(schema.order_events.to_status, "Funded"));

    const matchingEvent = events.find(
      (e) =>
        e.note &&
        typeof e.note === "object" &&
        (e.note as Record<string, unknown>)["payment_reference"] === txn.reference,
    );

    if (!matchingEvent) {
      await db.insert(schema.reconciliation_issues).values({
        order_id: null,
        issue_type: "MISSING_ORDER",
        detail: { reference: txn.reference, amount_minor: txn.amount_minor.toString(), currency: txn.currency },
      });
      issueCount++;
      continue;
    }

    // Check amount matches.
    const order = await db.query.orders.findFirst({
      where: eq(schema.orders.id, matchingEvent.order_id),
    });

    if (!order) continue;

    if (order.amount_minor !== txn.amount_minor) {
      await db.insert(schema.reconciliation_issues).values({
        order_id: order.id,
        issue_type: "AMOUNT_MISMATCH",
        detail: {
          expected: order.amount_minor.toString(),
          actual: txn.amount_minor.toString(),
          reference: txn.reference,
        },
      });
      issueCount++;
    }

    // Check that released/resolved/refunded orders have a payout record.
    if (order.status === "Released" || order.status === "Resolved" || order.status === "Refunded") {
      const payoutRows = await db
        .select()
        .from(schema.payouts)
        .where(eq(schema.payouts.order_id, order.id));

      if (payoutRows.length === 0) {
        await db.insert(schema.reconciliation_issues).values({
          order_id: order.id,
          issue_type: "PAYOUT_NOT_INITIATED",
          detail: { status: order.status },
        });
        issueCount++;
      }
    }
  }

  return { checked: transactions.length, issues: issueCount };
}
