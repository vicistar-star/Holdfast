"use client";

/**
 * apps/web/src/app/admin/disputes/[id]/page.tsx
 *
 * Arbiter Case Dossier & Resolution Form.
 * Enforces Conservation Invariant: buyer_share + seller_share == amount.
 * Fee on seller share only; buyer refund is fee-free.
 * Mandatory written rationale and confirmation step.
 */

import React, { useEffect, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { formatNaira, formatDateTime } from "../../../../lib/presentation.ts";

interface CaseData {
  dispute: {
    id: string;
    order_id: string;
    reason: string;
    opened_at: string;
    resolved_at: string | null;
    buyer_share_minor: string | null;
    seller_share_minor: string | null;
    rationale: string | null;
  };
  order: {
    id: string;
    amount_minor: string;
    currency: string;
    status: string;
    buyer_phone: string;
    seller_handle: string;
    ship_by: string;
    shipped_at: string | null;
    review_ends: string | null;
    created_at: string;
  };
  timeline: Array<{
    id: number;
    from_status: string | null;
    to_status: string;
    actor: string;
    note: any;
    tx_hash: string | null;
    created_at: string;
  }>;
  evidence: Array<{
    id: string;
    uploaded_by: string;
    object_key: string;
    sha256: string;
    hash_verified: boolean;
    created_at: string;
  }>;
  statements: {
    buyer_dispute_reason: string;
    buyer_dispute_note: string | null;
    seller_shipping_waybill: string | null;
    seller_shipping_note: string | null;
  };
  requires_second_approver: boolean;
}

export default function ArbiterCasePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const disputeId = (params["id"] as string) ?? "";
  const token = searchParams.get("token") ?? "";

  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolution form state
  const [buyerShareNaira, setBuyerShareNaira] = useState("");
  const [sellerShareNaira, setSellerShareNaira] = useState("");
  const [rationale, setRationale] = useState("");
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolutionSuccess, setResolutionSuccess] = useState<string | null>(null);

  const apiBase = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3000/v1";

  useEffect(() => {
    async function loadCase() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/admin/disputes/${disputeId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Could not load dispute case dossier");
        const data: CaseData = await res.json();
        setCaseData(data);

        // Pre-fill full refund to buyer as a starting point
        const totalMajor = (BigInt(data.order.amount_minor) / 100n).toString();
        setBuyerShareNaira(totalMajor);
        setSellerShareNaira("0");
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    if (disputeId && token) loadCase();
  }, [disputeId, token, apiBase]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (error || !caseData) {
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-rose-800">
          <h1 className="text-base font-bold">Error Loading Case</h1>
          <p className="mt-1 text-xs">{error ?? "Authentication required"}</p>
        </div>
      </main>
    );
  }

  const totalMinor = BigInt(caseData.order.amount_minor);
  const totalNaira = Number(totalMinor / 100n);

  const buyerMinor = BigInt(Math.max(0, Math.round((parseFloat(buyerShareNaira) || 0) * 100)));
  const sellerMinor = BigInt(Math.max(0, Math.round((parseFloat(sellerShareNaira) || 0) * 100)));
  const sumMinor = buyerMinor + sellerMinor;
  const isConservationValid = sumMinor === totalMinor;

  // Fee calculation: fee charged on seller share only
  const feeBps = 150n; // 1.5%
  const sellerFeeMinor = (sellerMinor * feeBps) / 10000n;
  const sellerPayoutMinor = sellerMinor - sellerFeeMinor;
  const buyerRefundMinor = buyerMinor; // Free

  // Handle resolution submission
  const handleResolve = async () => {
    setResolving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/admin/disputes/${disputeId}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          buyer_share_minor: buyerMinor.toString(),
          seller_share_minor: sellerMinor.toString(),
          rationale,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message ?? "Resolution failed");
      }

      setResolutionSuccess("Dispute successfully settled! Payouts and notifications instructed.");
      setShowConfirmModal(false);
      setTimeout(() => router.push(`/admin?token=${token}`), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="mx-auto min-h-screen max-w-3xl bg-slate-50 p-6 pb-20">
      <header className="flex items-center justify-between border-b border-slate-200 pb-4">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-rose-600">
            Case Dossier #{caseData.dispute.id.slice(0, 8)}
          </span>
          <h1 className="text-xl font-black text-slate-900">
            Dispute: @{caseData.order.seller_handle} vs {caseData.order.buyer_phone}
          </h1>
        </div>
        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-bold text-slate-800">
          Order Total: {formatNaira(caseData.order.amount_minor)}
        </span>
      </header>

      {resolutionSuccess && (
        <div className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-xs font-bold text-emerald-900">
          ✓ {resolutionSuccess}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-rose-300 bg-rose-50 p-4 text-xs font-bold text-rose-900">
          {error}
        </div>
      )}

      {caseData.requires_second_approver && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900">
          ⚠️ <strong>High Value Alert:</strong> This order exceeds ₦500,000. Second human approver sign-off is recommended per governance policy.
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Statements & Facts */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Claims & Statements
          </h2>

          <div className="rounded-lg bg-rose-50/70 p-3.5 border border-rose-100">
            <span className="text-xs font-bold text-rose-900">
              Buyer Claim: {caseData.statements.buyer_dispute_reason.replace(/_/g, " ")}
            </span>
            <p className="mt-1 text-xs text-rose-800 leading-relaxed">
              &quot;{caseData.statements.buyer_dispute_note ?? "No detailed statement provided."}&quot;
            </p>
          </div>

          <div className="rounded-lg bg-blue-50/70 p-3.5 border border-blue-100">
            <span className="text-xs font-bold text-blue-900">
              Seller Dispatch Proof
            </span>
            <p className="mt-1 text-xs text-blue-800">
              <strong>Waybill / Tracking:</strong> {caseData.statements.seller_shipping_waybill ?? "None provided"}
            </p>
            <p className="mt-1 text-xs text-blue-800 leading-relaxed">
              &quot;{caseData.statements.seller_shipping_note ?? "No shipping notes attached."}&quot;
            </p>
          </div>

          {/* Evidence with SHA-256 fingerprint */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Uploaded Evidence ({caseData.evidence.length})
            </h3>
            {caseData.evidence.length === 0 ? (
              <p className="mt-1 text-xs text-slate-400">No media attached to this case.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {caseData.evidence.map((ev) => (
                  <li key={ev.id} className="rounded-lg border border-slate-200 p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800">{ev.uploaded_by}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${ev.hash_verified ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                        {ev.hash_verified ? "✓ Hash Verified" : "SHA-256 Recorded"}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-slate-500 truncate">
                      SHA: {ev.sha256}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Audit Timeline */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
            Append-Only Audit Timeline
          </h2>
          <ol className="relative border-l border-slate-200 ml-2 space-y-4">
            {caseData.timeline.map((evt) => (
              <li key={evt.id} className="ml-4">
                <div className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border border-white bg-blue-600" />
                <span className="text-[10px] text-slate-400">{formatDateTime(evt.created_at)}</span>
                <p className="text-xs font-bold text-slate-900">
                  {evt.from_status ? `${evt.from_status} → ` : ""}{evt.to_status} ({evt.actor})
                </p>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {/* RESOLUTION WORKBENCH */}
      {caseData.order.status === "Disputed" && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-black text-slate-900">Arbiter Settlement Split</h2>
          <p className="mt-1 text-xs text-slate-500">
            Split must sum exactly to order total. Payout fee applies to seller share only; buyer refund is fee-free.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (isConservationValid && rationale.length >= 10) {
                setShowConfirmModal(true);
              }
            }}
            className="mt-5 space-y-4"
          >
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700">Buyer Refund (₦ Naira)</label>
                <input
                  type="number"
                  value={buyerShareNaira}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value) || 0;
                    setBuyerShareNaira(e.target.value);
                    setSellerShareNaira(Math.max(0, totalNaira - val).toString());
                  }}
                  required
                  min="0"
                  max={totalNaira}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm font-bold"
                />
                <span className="mt-1 block text-[11px] text-slate-500">Fee-free refund to buyer</span>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700">Seller Payout (₦ Naira)</label>
                <input
                  type="number"
                  value={sellerShareNaira}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value) || 0;
                    setSellerShareNaira(e.target.value);
                    setBuyerShareNaira(Math.max(0, totalNaira - val).toString());
                  }}
                  required
                  min="0"
                  max={totalNaira}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm font-bold"
                />
                <span className="mt-1 block text-[11px] text-slate-500">
                  Seller fee (1.5%): {formatNaira(sellerFeeMinor)}
                </span>
              </div>
            </div>

            {/* Conservation Verification Pill */}
            <div className={`rounded-lg p-3 text-xs font-bold flex items-center justify-between ${isConservationValid ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>
              <span>Conservation Check:</span>
              <span>
                {isConservationValid
                  ? `✓ Exactly conserved: ${formatNaira(sumMinor)} == ${formatNaira(totalMinor)}`
                  : `❌ Split sum ${formatNaira(sumMinor)} does not equal total ${formatNaira(totalMinor)}`}
              </span>
            </div>

            {/* Written Rationale */}
            <div>
              <label className="block text-xs font-bold text-slate-700">
                Mandatory Written Rationale (Visible to both parties)
              </label>
              <textarea
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                rows={4}
                required
                minLength={10}
                placeholder="Explain the settlement decision based on courier waybill and photos..."
                className="mt-1 w-full rounded-lg border border-slate-300 p-3 text-xs focus:ring-1 focus:ring-blue-600 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={!isConservationValid || rationale.length < 10}
              className="w-full rounded-lg bg-slate-900 py-3 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Review & Execute Settlement →
            </button>
          </form>
        </section>
      )}

      {/* CONFIRMATION MODAL */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-black text-slate-900">Confirm Final Settlement</h3>
            <p className="mt-1 text-xs text-slate-600">
              This action is permanent and instructs financial settlement. Payouts will execute immediately.
            </p>

            <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-4 text-xs">
              <div className="flex justify-between font-semibold">
                <span>Buyer Refund:</span>
                <span className="font-bold text-slate-900">{formatNaira(buyerRefundMinor)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Seller Payout (after fee):</span>
                <span className="font-bold text-slate-900">{formatNaira(sellerPayoutMinor)}</span>
              </div>
              <div className="flex justify-between font-semibold text-slate-500">
                <span>Platform Escrow Fee:</span>
                <span>{formatNaira(sellerFeeMinor)}</span>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-slate-200 p-3 text-xs text-slate-700">
              <strong>Rationale:</strong> {rationale}
            </div>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 rounded-lg border border-slate-300 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                Back to Edit
              </button>
              <button
                type="button"
                onClick={handleResolve}
                disabled={resolving}
                className="flex-1 rounded-lg bg-rose-600 py-2.5 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {resolving ? "Executing..." : "Confirm & Settle"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
