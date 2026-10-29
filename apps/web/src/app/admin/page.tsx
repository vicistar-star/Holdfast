"use client";

/**
 * apps/web/src/app/admin/page.tsx
 *
 * Admin / Arbiter Console — Disputes Queue.
 * Role-gated for neutral human arbiters.
 */

import React, { useState } from "react";
import Link from "next/link";
import { formatNaira, formatDateTime } from "../../lib/presentation.ts";

interface DisputeItem {
  id: string;
  order_id: string;
  status: string;
  reason: string;
  amount_minor: string;
  currency: string;
  buyer_phone: string;
  seller_handle: string;
  opened_at: string;
  resolved_at: string | null;
  requires_second_approver: boolean;
}

export default function AdminDisputesPage() {
  const [disputes, setDisputes] = useState<DisputeItem[]>([]);
  const [token, setToken] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDisputes = async (authToken: string) => {
    setLoading(true);
    setError(null);
    try {
      const apiBase = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3000/v1";
      const res = await fetch(`${apiBase}/admin/disputes`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error("Unauthorized or failed to fetch disputes queue");
      const data = await res.json();
      setDisputes(data.disputes ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto min-h-screen max-w-4xl bg-slate-50 p-6">
      <header className="flex items-center justify-between border-b border-slate-200 pb-4">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-rose-600">
            Internal Operations
          </span>
          <h1 className="text-2xl font-black text-slate-900">Arbiter Dispute Console</h1>
        </div>
        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-bold text-slate-700">
          Human Arbitration Only
        </span>
      </header>

      {/* Auth Input */}
      {!token && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-bold text-slate-900">Enter Arbiter Access Token</h2>
          <p className="mt-1 text-xs text-slate-500">
            Restricted to authenticated human dispute resolution arbiters.
          </p>
          <div className="mt-4 flex gap-2">
            <input
              type="password"
              placeholder="Bearer Token..."
              onChange={(e) => setToken(e.target.value)}
              className="w-full rounded-lg border border-slate-300 p-2.5 text-xs font-mono"
            />
            <button
              type="button"
              onClick={() => fetchDisputes(token)}
              disabled={loading || !token}
              className="rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Sign In
            </button>
          </div>
        </div>
      )}

      {/* Disputes Queue */}
      {token && (
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-800">
              Open Disputes ({disputes.length})
            </h2>
            <button
              type="button"
              onClick={() => fetchDisputes(token)}
              className="text-xs font-semibold text-blue-600 hover:underline"
            >
              ↻ Refresh
            </button>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 p-3 text-xs text-rose-800 border border-rose-200">
              {error}
            </div>
          )}

          {disputes.length === 0 && !loading && (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
              No open disputes in queue. All orders settled.
            </div>
          )}

          <div className="space-y-3">
            {disputes.map((d) => (
              <div
                key={d.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-blue-400 transition"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-800 uppercase">
                      {d.reason.replace(/_/g, " ")}
                    </span>
                    {d.requires_second_approver && (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                        ⚠️ High Value (2 Approvers)
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-black text-slate-900">
                    {formatNaira(d.amount_minor)}
                  </span>
                </div>

                <div className="mt-2.5 grid grid-cols-2 gap-2 text-xs text-slate-600">
                  <p><strong>Seller:</strong> @{d.seller_handle}</p>
                  <p><strong>Buyer:</strong> {d.buyer_phone}</p>
                  <p><strong>Opened:</strong> {formatDateTime(d.opened_at)}</p>
                  <p><strong>Status:</strong> {d.status}</p>
                </div>

                <div className="mt-3.5 pt-2 border-t border-slate-100 flex justify-end">
                  <Link
                    href={`/admin/disputes/${d.id}?token=${token}`}
                    className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-slate-800"
                  >
                    Open Case Dossier →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
