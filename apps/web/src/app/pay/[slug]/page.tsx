"use client";

/**
 * apps/web/src/app/pay/[slug]/page.tsx
 *
 * Buyer pay page and live order status.
 *
 * Mobile-first, light, works in Instagram & WhatsApp webviews.
 * Zero chain terminology.
 */

import React, { useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  formatNaira,
  getStatusPresentation,
  getLinkGuaranteeCopy,
} from "../../../lib/presentation.ts";
import type { OrderStatus } from "@holdfast/shared";

interface LinkData {
  id: string;
  slug: string;
  title: string;
  amount_minor: string;
  currency: string;
  ship_by_hours: number;
  review_hours: number;
  seller: {
    handle: string;
    kyc_tier: number;
  };
}

interface OrderData {
  id: string;
  status: OrderStatus;
  amount_minor: string;
  currency: string;
  ship_by: string;
  shipped_at: string | null;
  review_ends: string | null;
  created_at: string;
}

export default function BuyerPayPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const slug = (params["slug"] as string) ?? "";
  const existingOrderId = searchParams.get("order_id");
  const existingToken = searchParams.get("token");

  const [link, setLink] = useState<LinkData | null>(null);
  const [order, setOrder] = useState<OrderData | null>(null);
  const [orderToken, setOrderToken] = useState<string | null>(existingToken);
  const [buyerPhone, setBuyerPhone] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Payment instructions modal
  const [instructions, setInstructions] = useState<{
    account_number?: string;
    bank_name?: string;
    reference: string;
    instructions: string;
  } | null>(null);

  // Dispute form state
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [disputeReason, setDisputeReason] = useState<
    "not_received" | "not_as_described" | "damaged" | "other"
  >("not_received");
  const [disputeNote, setDisputeNote] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // 1. Fetch link or existing order
  useEffect(() => {
    async function loadData() {
      setLoading(true);
      setError(null);
      try {
        const apiBase = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3000/v1";
        const linkRes = await fetch(`${apiBase}/links/${slug}`);
        if (!linkRes.ok) throw new Error("Payment link not found or expired");
        const linkJson = await linkRes.json();
        setLink(linkJson);

        if (existingOrderId && existingToken) {
          const ordRes = await fetch(`${apiBase}/orders/${existingOrderId}`, {
            headers: { Authorization: `Bearer ${existingToken}` },
          });
          if (ordRes.ok) {
            const ordJson = await ordRes.json();
            setOrder(ordJson);
          }
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    if (slug) loadData();
  }, [slug, existingOrderId, existingToken]);

  // Handle buyer clicking "Pay with Safe Escrow"
  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!buyerPhone || buyerPhone.length < 10) {
      setError("Please enter a valid phone number (e.g. 08012345678)");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const apiBase = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3000/v1";
      const res = await fetch(`${apiBase}/links/${slug}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyer_phone: buyerPhone }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message ?? "Failed to create order");
      }

      const data = await res.json();
      setOrderToken(data.order_token);
      setInstructions(data.payment_instructions);
      setOrder({
        id: data.id,
        status: data.status,
        amount_minor: link?.amount_minor ?? "0",
        currency: link?.currency ?? "NGN",
        ship_by: data.ship_by,
        shipped_at: null,
        review_ends: null,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // Handle buyer confirming delivery
  const handleConfirmDelivery = async () => {
    if (!order || !orderToken) return;
    setSubmitting(true);
    setError(null);

    try {
      const apiBase = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3000/v1";
      const res = await fetch(`${apiBase}/orders/${order.id}/confirm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${orderToken}` },
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message ?? "Could not confirm delivery");
      }

      const updated = await res.json();
      setOrder((prev) => (prev ? { ...prev, status: updated.status } : null));
      setActionSuccess("Delivery confirmed! Payment has been safely released to the seller.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // Handle buyer submitting dispute
  const handleSubmitDispute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!order || !orderToken) return;
    setSubmitting(true);
    setError(null);

    try {
      const apiBase = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3000/v1";

      // 1. Submit dispute text and reason
      const disputeRes = await fetch(`${apiBase}/orders/${order.id}/dispute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${orderToken}`,
        },
        body: JSON.stringify({ reason: disputeReason, note: disputeNote }),
      });

      if (!disputeRes.ok) {
        const errJson = await disputeRes.json().catch(() => ({}));
        throw new Error(errJson.message ?? "Failed to open dispute");
      }

      // 2. Upload evidence file if selected
      if (selectedFile) {
        await fetch(`${apiBase}/orders/${order.id}/evidence/upload`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${orderToken}`,
            "Content-Type": selectedFile.type,
            "x-filename": selectedFile.name,
          },
          body: selectedFile,
        });
      }

      setOrder((prev) => (prev ? { ...prev, status: "Disputed" } : null));
      setShowDisputeModal(false);
      setActionSuccess("Problem reported. Funds are frozen and a human arbiter has been assigned.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (error && !link) {
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-rose-800">
          <h1 className="text-lg font-bold">Link Unavailable</h1>
          <p className="mt-2 text-sm">{error}</p>
        </div>
      </main>
    );
  }

  if (!link) return null;

  const isVerifiedSeller = link.seller.kyc_tier >= 1;
  const statusInfo = order ? getStatusPresentation(order.status, {
    shipBy: order.ship_by,
    reviewEnds: order.review_ends,
    sellerHandle: link.seller.handle,
  }) : null;

  return (
    <main className="mx-auto min-h-screen max-w-md bg-white pb-16 shadow-sm">
      {/* Header Banner */}
      <header className="border-b border-slate-100 bg-slate-900 px-5 py-4 text-white">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-400">
            Holdfast Buyer Protection
          </span>
          <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
            Escrow Secured
          </span>
        </div>
        <h1 className="mt-2 text-xl font-bold tracking-tight text-white">{link.title}</h1>
        <p className="mt-1 text-2xl font-extrabold text-white">
          {formatNaira(link.amount_minor)}
        </p>
      </header>

      {/* Seller Credentials */}
      <section className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-5 py-3">
        <div>
          <span className="text-xs text-slate-500">Seller</span>
          <p className="text-sm font-semibold text-slate-900">@{link.seller.handle}</p>
        </div>
        {isVerifiedSeller ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 border border-emerald-200">
            ✓ Verified Seller
          </span>
        ) : (
          <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700">
            New Seller
          </span>
        )}
      </section>

      {/* Alert Notices */}
      {actionSuccess && (
        <div className="mx-4 mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 border border-emerald-200">
          {actionSuccess}
        </div>
      )}
      {error && (
        <div className="mx-4 mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800 border border-rose-200">
          {error}
        </div>
      )}

      {/* VIEW 1: PRE-PAYMENT ORDER FORM */}
      {!order && (
        <div className="p-5">
          {/* Plain Words Guarantees */}
          <div className="mb-6 rounded-xl border border-blue-100 bg-blue-50/60 p-4">
            <h2 className="text-xs font-bold uppercase tracking-wider text-blue-800">
              How Your Escrow Works
            </h2>
            <ul className="mt-2.5 space-y-2 text-xs leading-relaxed text-blue-950">
              {getLinkGuaranteeCopy(link.ship_by_hours, link.review_hours).map((rule, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-blue-600">🛡️</span>
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </div>

          <form onSubmit={handleCreateOrder} className="space-y-4">
            <div>
              <label htmlFor="buyerPhone" className="block text-xs font-semibold text-slate-700">
                Your WhatsApp Phone Number
              </label>
              <input
                id="buyerPhone"
                type="tel"
                placeholder="080 1234 5678"
                value={buyerPhone}
                onChange={(e) => setBuyerPhone(e.target.value)}
                required
                className="mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-base text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                You will receive order status updates and delivery confirmation on WhatsApp.
              </span>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-blue-600 px-4 py-3.5 text-center text-sm font-bold text-white shadow transition hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "Preparing Safe Transfer..." : `Pay ${formatNaira(link.amount_minor)} with Escrow`}
            </button>
          </form>
        </div>
      )}

      {/* VIEW 2: POST-PAYMENT ORDER STATUS */}
      {order && statusInfo && (
        <div className="p-5 space-y-6">
          {/* Status Badge & Summary */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className={`inline-block rounded-full border px-3 py-1 text-xs font-bold ${statusInfo.badgeColor}`}>
                {statusInfo.badge}
              </span>
              <span className="text-xs text-slate-400">
                Order #{order.id.slice(0, 8)}
              </span>
            </div>

            <h2 className="mt-3 text-base font-bold text-slate-900">{statusInfo.title}</h2>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">{statusInfo.description}</p>

            <div className="mt-4 rounded-lg bg-slate-50 p-3 border border-slate-100">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                {statusInfo.nextActionTitle}
              </span>
              <p className="mt-1 text-xs font-medium text-slate-800">
                {statusInfo.nextActionDescription}
              </p>
            </div>
          </div>

          {/* Action Buttons for Buyer */}
          {order.status === "Shipped" && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleConfirmDelivery}
                disabled={submitting}
                className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow hover:bg-emerald-700 disabled:opacity-50"
              >
                ✓ Confirm Delivery & Release Payment
              </button>

              <button
                type="button"
                onClick={() => setShowDisputeModal(true)}
                className="w-full rounded-lg border border-rose-300 bg-white px-4 py-2.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
              >
                Report a Problem with this Order
              </button>
            </div>
          )}

          {/* Payment Instructions if Virtual Account is active */}
          {instructions && order.status === "Funded" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-amber-900">
                Bank Transfer Instructions
              </h3>
              <div className="mt-2.5 space-y-1.5 text-xs text-amber-950">
                <p><strong>Bank:</strong> {instructions.bank_name ?? "Holdfast Partner Bank"}</p>
                <p><strong>Account Number:</strong> <span className="font-mono text-sm font-bold">{instructions.account_number ?? "0123456789"}</span></p>
                <p><strong>Amount:</strong> {formatNaira(link.amount_minor)}</p>
                <p><strong>Reference:</strong> {instructions.reference}</p>
                <p className="mt-2 text-[11px] text-amber-800 leading-snug">{instructions.instructions}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* DISPUTE MODAL */}
      {showDisputeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-bold text-slate-900">Report an Issue</h2>
            <p className="mt-1 text-xs text-slate-600">
              Funds will freeze immediately. Our neutral human arbiter will inspect proof from both sides.
            </p>

            <form onSubmit={handleSubmitDispute} className="mt-4 space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-700">Reason</label>
                <select
                  value={disputeReason}
                  onChange={(e) => setDisputeReason(e.target.value as any)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                >
                  <option value="not_received">Package not received</option>
                  <option value="not_as_described">Item not as described</option>
                  <option value="damaged">Item arrived damaged</option>
                  <option value="other">Other issue</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">Explanation</label>
                <textarea
                  value={disputeNote}
                  onChange={(e) => setDisputeNote(e.target.value)}
                  rows={3}
                  placeholder="Describe what went wrong in detail..."
                  required
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Attach Evidence Photo or Video (Optional)
                </label>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                  className="mt-1 block w-full text-xs text-slate-500 file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-200"
                />
                <span className="text-[10px] text-slate-400">
                  Server computes a tamper-proof SHA-256 fingerprint for arbitration.
                </span>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDisputeModal(false)}
                  className="flex-1 rounded-lg border border-slate-300 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 rounded-lg bg-rose-600 py-2 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {submitting ? "Submitting..." : "Submit Report"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
