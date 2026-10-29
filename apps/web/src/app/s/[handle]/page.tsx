"use client";

/**
 * apps/web/src/app/s/[handle]/page.tsx
 *
 * Public Seller Profile.
 *
 * Requirements:
 * - Shows counts alongside any summary
 * - "New seller" below minimum sample (< 10 orders)
 * - Verified marker (KYC tier >= 1) separate from performance
 * - Embedded shareable badge preview with copyable badge URL
 * - Zero chain terminology
 */

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { ReputationSummary } from "@holdfast/shared";

export default function PublicSellerProfilePage() {
  const params = useParams();
  const handle = (params["handle"] as string) ?? "";

  const [rep, setRep] = useState<ReputationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function fetchReputation() {
      setLoading(true);
      setError(null);
      try {
        const apiBase = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3000/v1";
        const res = await fetch(`${apiBase}/sellers/${handle}/reputation`);
        if (!res.ok) throw new Error("Seller profile not found");
        const data: ReputationSummary = await res.json();
        setRep(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    if (handle) fetchReputation();
  }, [handle]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (error || !rep) {
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-bold text-slate-800">Seller Not Found</h1>
          <p className="mt-1 text-xs text-slate-500">The seller @{handle} does not exist or has not activated their store.</p>
        </div>
      </main>
    );
  }

  const badgeUrl = typeof window !== "undefined"
    ? `${window.location.origin}/badge/${rep.sellerHandle}.svg`
    : `/badge/${rep.sellerHandle}.svg`;

  return (
    <main className="mx-auto min-h-screen max-w-md bg-slate-50 p-5 pb-16">
      {/* Seller Header Card */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-xl font-black text-blue-700">
          @{rep.sellerHandle.slice(0, 2).toUpperCase()}
        </div>

        <h1 className="mt-3 text-xl font-extrabold text-slate-900">@{rep.sellerHandle}</h1>
        <p className="text-xs text-slate-500">Member for {rep.accountAgeDays} days</p>

        {/* Verified Marker — strictly separate from performance */}
        <div className="mt-3">
          {rep.isVerified ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800">
              ✓ Verified by Holdfast
            </span>
          ) : (
            <span className="inline-block rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
              Unverified Seller
            </span>
          )}
        </div>
      </section>

      {/* Performance Signals Grid */}
      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">
          Escrow Track Record
        </h2>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-100">
            <span className="text-xs text-slate-500">Completed Orders</span>
            <p className="mt-1 text-2xl font-black text-slate-900">
              {rep.completedOrdersLifetime}
            </p>
            <span className="text-[10px] text-slate-400">
              {rep.completedOrdersTrailing90d} in last 90 days
            </span>
          </div>

          <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-100">
            <span className="text-xs text-slate-500">Dispute Rate</span>
            {rep.isNewSeller ? (
              <div>
                <p className="mt-1 text-base font-bold text-slate-700">New Seller</p>
                <span className="text-[10px] text-slate-400">&lt; 10 orders sample</span>
              </div>
            ) : (
              <div>
                <p className="mt-1 text-2xl font-black text-slate-900">
                  {((rep.disputeRate ?? 0) * 100).toFixed(1)}%
                </p>
                <span className="text-[10px] text-slate-400">
                  {rep.disputesLost} lost of {rep.completedOrdersLifetime}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-100">
            <span className="text-xs text-slate-500">Volume Band</span>
            <p className="mt-1 text-xs font-bold text-slate-800">
              {rep.totalVolumeBand}
            </p>
            <span className="text-[10px] text-slate-400">Lifetime held & released</span>
          </div>

          <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-100">
            <span className="text-xs text-slate-500">Average Dispatch</span>
            <p className="mt-1 text-xs font-bold text-slate-800">
              {rep.medianTimeToShipHours ? `${rep.medianTimeToShipHours.toFixed(0)} Hours` : "Under 24h"}
            </p>
            <span className="text-[10px] text-slate-400">Median shipping speed</span>
          </div>
        </div>
      </section>

      {/* Shareable Badge Preview */}
      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">
          Shareable Bio Badge
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Paste into your Instagram bio, WhatsApp business catalog, or website.
        </p>

        {/* Live SVG Badge preview */}
        <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
          <img
            src={`/badge/${rep.sellerHandle}.svg`}
            alt={`Holdfast Verified Badge for @${rep.sellerHandle}`}
            className="w-full"
          />
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(badgeUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="w-full rounded-lg bg-slate-900 py-2.5 text-xs font-bold text-white hover:bg-slate-800"
          >
            {copied ? "✓ Copied Badge Link!" : "Copy Badge Image URL"}
          </button>
        </div>
      </section>
    </main>
  );
}
