/**
 * apps/web/src/lib/presentation.ts
 *
 * User-facing presentation helpers and plain-language copy.
 *
 * NON-NEGOTIABLE RULE: Zero chain terminology in any user-facing text.
 * No XLM, Stellar, Soroban, blockchain, smart contract, wallet, gas, seed phrase.
 */

import type { OrderStatus } from "@holdfast/shared";

export function formatNaira(amountMinor: bigint | number | string): string {
  const minor = BigInt(amountMinor.toString());
  const major = minor / 100n;
  const kobo = minor % 100n;
  const majorFormatted = Number(major).toLocaleString("en-NG");
  if (kobo === 0n) {
    return `₦${majorFormatted}`;
  }
  return `₦${majorFormatted}.${kobo.toString().padStart(2, "0")}`;
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-NG", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface StatusCopy {
  badge: string;
  badgeColor: string; // Tailwind classes
  title: string;
  description: string;
  nextActionTitle: string;
  nextActionDescription: string;
}

export function getStatusPresentation(
  status: OrderStatus,
  context: {
    shipBy?: Date | string | null;
    reviewEnds?: Date | string | null;
    sellerHandle?: string;
  } = {},
): StatusCopy {
  switch (status) {
    case "Funded":
      return {
        badge: "Payment Received",
        badgeColor: "bg-amber-100 text-amber-800 border-amber-300",
        title: "Payment Held in Safe Escrow",
        description:
          "Your payment is safely held until delivery is completed. The seller has been notified to ship your package.",
        nextActionTitle: "Seller Shipping Window",
        nextActionDescription: context.shipBy
          ? `If the seller doesn't ship by ${formatDateTime(context.shipBy)}, you get an automatic full refund.`
          : "If the seller doesn't ship in time, you get a full refund.",
      };

    case "Shipped":
      return {
        badge: "Package On The Way",
        badgeColor: "bg-blue-100 text-blue-800 border-blue-300",
        title: "Your Order is Shipped",
        description:
          "The seller marked this order shipped. Inspect your items once delivered.",
        nextActionTitle: "Inspection Window",
        nextActionDescription: context.reviewEnds
          ? `Please confirm delivery by ${formatDateTime(context.reviewEnds)}. If you have any issue, you can report a problem before this deadline.`
          : "Confirm delivery once received, or report any issue before the inspection window closes.",
      };

    case "Released":
      return {
        badge: "Order Completed",
        badgeColor: "bg-emerald-100 text-emerald-800 border-emerald-300",
        title: "Delivery Confirmed & Settled",
        description:
          "Delivery was confirmed and the seller's payment has been released. Thank you for using secure escrow!",
        nextActionTitle: "Sale Complete",
        nextActionDescription: "No further action is required.",
      };

    case "Refunded":
      return {
        badge: "Refunded in Full",
        badgeColor: "bg-purple-100 text-purple-800 border-purple-300",
        title: "Payment Returned to Buyer",
        description:
          "The shipping deadline expired without dispatch, and your payment was fully refunded with zero fee deducted.",
        nextActionTitle: "Refund Succeeded",
        nextActionDescription: "Funds returned to the paying bank account.",
      };

    case "Disputed":
      return {
        badge: "Under Review",
        badgeColor: "bg-rose-100 text-rose-800 border-rose-300",
        title: "Issue Reported — Under Arbiter Review",
        description:
          "Funds are frozen safely while our human dispute resolution team reviews statements and evidence from both sides.",
        nextActionTitle: "Human Arbiter Resolution",
        nextActionDescription:
          "Our arbiter will review waybill proof, photos, and messages, and issue a fair written settlement decision.",
      };

    case "Resolved":
      return {
        badge: "Dispute Settled",
        badgeColor: "bg-indigo-100 text-indigo-800 border-indigo-300",
        title: "Dispute Settled by Arbiter",
        description:
          "The arbiter concluded the case and distributed funds in accordance with the evidence provided.",
        nextActionTitle: "Case Closed",
        nextActionDescription: "Review the arbiter's written rationale below.",
      };

    default: {
      const fallbackStatus = String(status);
      return {
        badge: fallbackStatus,
        badgeColor: "bg-slate-100 text-slate-800 border-slate-300",
        title: `Order Status: ${fallbackStatus}`,
        description: "Your order is progressing.",
        nextActionTitle: "Status",
        nextActionDescription: "Please check back shortly.",
      };
    }
  }
}

/**
 * Plain words guarantee for payment link preview.
 */
export function getLinkGuaranteeCopy(shipByHours: number, reviewHours: number): string[] {
  return [
    `Guaranteed refund: If the seller does not ship within ${shipByHours} hours, 100% of your money is refunded automatically.`,
    `Buyer inspection period: You have ${reviewHours} hours after delivery to inspect your package before payment is sent to the seller.`,
    "Zero hidden fees: Free escrow protection for the buyer.",
  ];
}
