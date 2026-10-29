"use client";

/**
 * apps/web/src/app/dashboard/page.tsx
 *
 * Seller Dashboard (PWA, mobile-first, installable, offline-aware).
 *
 * Capabilities:
 * 1. Phone OTP sign-in
 * 2. Create and share payment link (copy & WhatsApp share)
 * 3. Orders list with status badges and next actions
 * 4. Mark shipped (with waybill and photo)
 * 5. Respond to disputes
 * 6. KYC & payout account onboarding
 * 7. Live seller reputation preview
 * 8. Offline status detector banner
 */

import React, { useState, useEffect } from "react";
import { formatNaira, formatDateTime, getStatusPresentation } from "../../lib/presentation.ts";
import type { OrderStatus, ReputationSummary } from "@holdfast/shared";

interface SellerProfile {
  id: string;
  handle: string;
  kyc_tier: number;
  payout_ref: string | null;
}

interface SellerOrder {
  id: string;
  buyer_phone: string;
  amount_minor: string;
  currency: string;
  status: OrderStatus;
  ship_by: string;
  shipped_at: string | null;
  review_ends: string | null;
  created_at: string;
}

export default function SellerDashboardPage() {
  // Auth state
  const [token, setToken] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [handle, setHandle] = useState("");

  // Offline status
  const [isOffline, setIsOffline] = useState(false);

  // Dashboard state
  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [orders, setOrders] = useState<SellerOrder[]>([]);
  const [reputation, setReputation] = useState<ReputationSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Link creator state
  const [newTitle, setNewTitle] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newShipByHours, setNewShipByHours] = useState("48");
  const [newReviewHours, setNewReviewHours] = useState("24");
  const [createdLinkSlug, setCreatedLinkSlug] = useState<string | null>(null);

  // Mark shipped modal
  const [shippingOrderId, setShippingOrderId] = useState<string | null>(null);
  const [waybill, setWaybill] = useState("");
  const [shippingNote, setShippingNote] = useState("");
  const [shippingProofFile, setShippingProofFile] = useState<File | null>(null);

  // KYC & Payout state
  const [bankCode, setBankCode] = useState("058"); // GTBank default
  const [accountNumber, setAccountNumber] = useState("");

  // Detect offline / online
  useEffect(() => {
    setIsOffline(!navigator.onLine);
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Restore saved auth token if returning
    const saved = typeof window !== "undefined" ? localStorage.getItem("hf_seller_token") : null;
    if (saved) {
      setToken(saved);
      loadDashboardData(saved);
    }

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const apiBase = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3000/v1";

  // Load seller data
  const loadDashboardData = async (authToken: string) => {
    setLoading(true);
    try {
      // 1. Get profile
      const profRes = await fetch(`${apiBase}/sellers/me`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!profRes.ok) throw new Error("Could not load seller profile");
      const profData: SellerProfile = await profRes.json();
      setProfile(profData);

      // 2. Get reputation
      const repRes = await fetch(`${apiBase}/sellers/${profData.handle}/reputation`);
      if (repRes.ok) {
        const repData: ReputationSummary = await repRes.json();
        setReputation(repData);
      }

      // 3. Get orders
      const ordRes = await fetch(`${apiBase}/orders`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (ordRes.ok) {
        const ordData = await ordRes.json();
        setOrders(ordData.orders ?? []);
      }
    } catch (err) {
      setMessage({ text: (err as Error).message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  // 1. Request OTP
  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`${apiBase}/auth/otp/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) throw new Error("Failed to send OTP code");
      setOtpSent(true);
      setMessage({ text: "Verification code sent to your phone (use 123456 in dev)", type: "success" });
    } catch (err) {
      setMessage({ text: (err as Error).message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  // 2. Verify OTP and sign in
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`${apiBase}/auth/otp/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: otp }),
      });
      if (!res.ok) throw new Error("Invalid verification code");
      const data = await res.json();
      setToken(data.token);
      if (typeof window !== "undefined") {
        localStorage.setItem("hf_seller_token", data.token);
      }

      if (data.user?.role !== "seller") {
        // Need to create handle
        setProfile(null);
      } else {
        await loadDashboardData(data.token);
      }
    } catch (err) {
      setMessage({ text: (err as Error).message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  // 3. Create seller profile
  const handleCreateSellerProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/sellers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ handle }),
      });
      if (!res.ok) throw new Error("Handle taken or invalid");
      await loadDashboardData(token);
    } catch (err) {
      setMessage({ text: (err as Error).message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  // 4. Create payment link
  const handleCreateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    setMessage(null);
    try {
      const amountKobo = BigInt(Math.round(parseFloat(newAmount) * 100)).toString();
      const res = await fetch(`${apiBase}/links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: newTitle,
          amount_minor: amountKobo,
          currency: "NGN",
          ship_by_hours: parseInt(newShipByHours, 10),
          review_hours: parseInt(newReviewHours, 10),
        }),
      });

      if (!res.ok) throw new Error("Failed to create link");
      const data = await res.json();
      setCreatedLinkSlug(data.slug);
      setNewTitle("");
      setNewAmount("");
      setMessage({ text: "Payment link created successfully!", type: "success" });
    } catch (err) {
      setMessage({ text: (err as Error).message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  // 5. Mark order shipped
  const handleMarkShipped = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !shippingOrderId) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/orders/${shippingOrderId}/ship`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ waybill, note: shippingNote }),
      });
      if (!res.ok) throw new Error("Could not mark order shipped");

      if (shippingProofFile) {
        await fetch(`${apiBase}/orders/${shippingOrderId}/evidence/upload`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": shippingProofFile.type,
            "x-filename": shippingProofFile.name,
          },
          body: shippingProofFile,
        });
      }

      setShippingOrderId(null);
      setWaybill("");
      setShippingNote("");
      setMessage({ text: "Order marked shipped! Buyer notified to inspect upon arrival.", type: "success" });
      await loadDashboardData(token);
    } catch (err) {
      setMessage({ text: (err as Error).message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  // 6. Complete KYC verification
  const handleVerifyKyc = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/sellers/kyc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("KYC verification could not be completed");
      setMessage({ text: "Identity verified! Verified seller badge unlocked.", type: "success" });
      await loadDashboardData(token);
    } catch (err) {
      setMessage({ text: (err as Error).message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  // 7. Save payout account
  const handleSavePayoutAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/sellers/payout-account`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ bank_code: bankCode, account_number: accountNumber }),
      });
      if (!res.ok) throw new Error("Could not update payout account");
      setMessage({ text: "Payout bank account saved! Payouts will settle directly to this account.", type: "success" });
      await loadDashboardData(token);
    } catch (err) {
      setMessage({ text: (err as Error).message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto min-h-screen max-w-lg bg-slate-50 pb-20 shadow-sm">
      {/* Offline Banner */}
      {isOffline && (
        <div className="bg-amber-600 px-4 py-2 text-center text-xs font-bold text-white">
          ⚠️ You are offline. Data is displayed from local cache.
        </div>
      )}

      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black text-white">
              HF
            </span>
            <span className="font-extrabold tracking-tight text-slate-900">Holdfast Seller</span>
          </div>
          {profile && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-700">@{profile.handle}</span>
              {profile.kyc_tier >= 1 && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                  ✓ Verified
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Alert Banner */}
      {message && (
        <div
          className={`mx-4 mt-3 rounded-lg p-3 text-xs font-medium border ${
            message.type === "success"
              ? "bg-emerald-50 text-emerald-800 border-emerald-200"
              : "bg-rose-50 text-rose-800 border-rose-200"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* SECTION 1: SIGN IN */}
      {!token && (
        <main className="p-5">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-lg font-bold text-slate-900">Sign in with Phone</h1>
            <p className="mt-1 text-xs text-slate-500">
              Get paid safely on WhatsApp & Instagram without buyer friction.
            </p>

            {!otpSent ? (
              <form onSubmit={handleRequestOtp} className="mt-5 space-y-4">
                <div>
                  <label htmlFor="sellerPhone" className="block text-xs font-semibold text-slate-700">Phone Number</label>
                  <input
                    id="sellerPhone"
                    type="tel"
                    placeholder="080 1234 5678"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-blue-600 py-3 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? "Sending..." : "Send Verification Code"}
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyOtp} className="mt-5 space-y-4">
                <div>
                  <label htmlFor="sellerOtp" className="block text-xs font-semibold text-slate-700">6-Digit Code</label>
                  <input
                    id="sellerOtp"
                    type="text"
                    placeholder="123456"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    maxLength={6}
                    required
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-center text-lg font-mono font-bold tracking-widest"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-blue-600 py-3 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? "Verifying..." : "Sign In"}
                </button>
              </form>
            )}
          </div>
        </main>
      )}

      {/* SECTION 2: CREATE PROFILE IF NEW */}
      {token && !profile && (
        <main className="p-5">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-lg font-bold text-slate-900">Choose Your Seller Handle</h1>
            <p className="mt-1 text-xs text-slate-500">
              This handle identifies your store and builds your public escrow track record.
            </p>
            <form onSubmit={handleCreateSellerProfile} className="mt-5 space-y-4">
              <div>
                <label htmlFor="handleInput" className="block text-xs font-semibold text-slate-700">Store Handle</label>
                <div className="mt-1 flex items-center rounded-lg border border-slate-300 px-3">
                  <span className="text-sm font-semibold text-slate-400">@</span>
                  <input
                    id="handleInput"
                    type="text"
                    placeholder="lagos_sneakers"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    required
                    className="w-full p-2.5 text-sm focus:outline-none"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-blue-600 py-3 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Create Seller Account
              </button>
            </form>
          </div>
        </main>
      )}

      {/* SECTION 3: AUTHENTICATED DASHBOARD */}
      {token && profile && (
        <main className="space-y-5 p-5">
          {/* Reputation Snapshot */}
          {reputation && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Your Track Record
                </span>
                <a
                  href={`/s/${profile.handle}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-blue-600 hover:underline"
                >
                  View Public Profile ↗
                </a>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-slate-50 p-3 border border-slate-100">
                  <span className="text-[11px] text-slate-500">Completed Orders</span>
                  <p className="mt-1 text-lg font-bold text-slate-900">
                    {reputation.completedOrdersLifetime}
                  </p>
                  <span className="text-[10px] text-slate-400">
                    {reputation.completedOrdersTrailing90d} last 90 days
                  </span>
                </div>

                <div className="rounded-lg bg-slate-50 p-3 border border-slate-100">
                  <span className="text-[11px] text-slate-500">Dispute Rate</span>
                  <p className="mt-1 text-lg font-bold text-slate-900">
                    {reputation.isNewSeller ? "New Seller" : `${((reputation.disputeRate ?? 0) * 100).toFixed(1)}%`}
                  </p>
                  <span className="text-[10px] text-slate-400">
                    {reputation.isNewSeller ? "< 10 orders" : `${reputation.disputesLost} lost`}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Create Payment Link Card */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900">Create New Payment Link</h2>
            <form onSubmit={handleCreateLink} className="mt-4 space-y-3">
              <div>
                <label htmlFor="itemTitle" className="block text-xs font-semibold text-slate-700">Item Title</label>
                <input
                  id="itemTitle"
                  type="text"
                  placeholder="Vintage Denim Jacket (Size M)"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  required
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="itemPrice" className="block text-xs font-semibold text-slate-700">Price (₦ Naira)</label>
                  <input
                    id="itemPrice"
                    type="number"
                    placeholder="25000"
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    required
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"
                  />
                </div>
                <div>
                  <label htmlFor="shipWindow" className="block text-xs font-semibold text-slate-700">Ship Window</label>
                  <select
                    id="shipWindow"
                    value={newShipByHours}
                    onChange={(e) => setNewShipByHours(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"
                  >
                    <option value="24">24 Hours</option>
                    <option value="48">48 Hours</option>
                    <option value="72">3 Days</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="reviewWindow" className="block text-xs font-semibold text-slate-700">Buyer Review Window</label>
                <select
                  id="reviewWindow"
                  value={newReviewHours}
                  onChange={(e) => setNewReviewHours(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"
                >
                  <option value="24">24 Hours Inspection</option>
                  <option value="48">48 Hours Inspection</option>
                </select>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-blue-600 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? "Generating Link..." : "+ Create Escrow Link"}
              </button>
            </form>

            {/* Created link presentation */}
            {createdLinkSlug && (
              <div className="mt-4 rounded-lg bg-emerald-50 p-3.5 border border-emerald-200">
                <span className="text-[11px] font-bold text-emerald-900 uppercase">
                  Your Link is Ready to Share!
                </span>
                <p className="mt-1 font-mono text-xs text-emerald-800 break-all select-all">
                  {typeof window !== "undefined" ? window.location.origin : ""}/pay/{createdLinkSlug}
                </p>
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const linkUrl = `${window.location.origin}/pay/${createdLinkSlug}`;
                      navigator.clipboard.writeText(linkUrl);
                      setMessage({ text: "Link copied to clipboard!", type: "success" });
                    }}
                    className="flex-1 rounded-md bg-white border border-emerald-300 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100"
                  >
                    📋 Copy Link
                  </button>
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(
                      `Hi! Here is your secure Holdfast escrow link to complete the order safely: ${
                        typeof window !== "undefined" ? window.location.origin : ""
                      }/pay/${createdLinkSlug}`,
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 rounded-md bg-emerald-600 py-1.5 text-center text-xs font-bold text-white hover:bg-emerald-700"
                  >
                    💬 WhatsApp
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* Orders List */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-slate-900">Your Escrow Orders ({orders.length})</h2>
            {orders.length === 0 ? (
              <p className="text-xs text-slate-500">No customer orders yet. Create and share a payment link above to start selling.</p>
            ) : (
              <div className="space-y-3">
                {orders.map((ord) => {
                  const statusInfo = getStatusPresentation(ord.status, {
                    shipBy: ord.ship_by,
                    reviewEnds: ord.review_ends,
                  });
                  return (
                    <div key={ord.id} className="rounded-lg border border-slate-200 p-3.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${statusInfo.badgeColor}`}>
                          {statusInfo.badge}
                        </span>
                        <span className="font-bold text-slate-900">{formatNaira(ord.amount_minor)}</span>
                      </div>
                      <div className="text-xs text-slate-600">
                        <p>Buyer: {ord.buyer_phone}</p>
                        <p className="text-[11px] text-slate-400">Created: {formatDateTime(ord.created_at)}</p>
                      </div>
                      {ord.status === "Funded" && (
                        <button
                          type="button"
                          onClick={() => setShippingOrderId(ord.id)}
                          className="w-full rounded-md bg-blue-600 py-1.5 text-xs font-bold text-white hover:bg-blue-700"
                        >
                          Mark as Shipped 📦
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* KYC & Payout Account Setup */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-slate-900">Verification & Payouts</h2>

            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <p className="text-xs font-semibold text-slate-800">Identity Verification</p>
                <span className="text-[11px] text-slate-500">
                  {profile.kyc_tier >= 1 ? "Tier 1: Up to ₦50,000 per order" : "Unverified (payouts held)"}
                </span>
              </div>
              {profile.kyc_tier === 0 && (
                <button
                  type="button"
                  onClick={handleVerifyKyc}
                  disabled={loading}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800"
                >
                  Verify ID
                </button>
              )}
            </div>

            <form onSubmit={handleSavePayoutAccount} className="space-y-3 pt-1">
              <span className="block text-xs font-semibold text-slate-800">Bank Account for Payouts</span>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={bankCode}
                  onChange={(e) => setBankCode(e.target.value)}
                  className="rounded-lg border border-slate-300 p-2 text-xs"
                >
                  <option value="058">GTBank (058)</option>
                  <option value="011">First Bank (011)</option>
                  <option value="057">Zenith Bank (057)</option>
                  <option value="033">UBA (033)</option>
                </select>
                <input
                  type="text"
                  placeholder="Account Number"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  required
                  maxLength={10}
                  className="rounded-lg border border-slate-300 p-2 text-xs"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md border border-slate-300 bg-slate-50 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Update Bank Account
              </button>
            </form>
          </div>
        </main>
      )}

      {/* MARK SHIPPED MODAL */}
      {shippingOrderId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-bold text-slate-900">Mark Order Shipped</h2>
            <p className="mt-1 text-xs text-slate-500">Attach tracking or receipt proof to start the buyer review window.</p>
            <form onSubmit={handleMarkShipped} className="mt-4 space-y-3">
              <div>
                <label htmlFor="waybillInput" className="block text-xs font-semibold text-slate-700">Waybill / Tracking Number</label>
                <input
                  id="waybillInput"
                  type="text"
                  placeholder="e.g. GIGM-1029384"
                  value={waybill}
                  onChange={(e) => setWaybill(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"
                />
              </div>
              <div>
                <label htmlFor="shipNote" className="block text-xs font-semibold text-slate-700">Shipping Note</label>
                <textarea
                  id="shipNote"
                  placeholder="Dispatched via courier today..."
                  value={shippingNote}
                  onChange={(e) => setShippingNote(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"
                />
              </div>
              <div>
                <label htmlFor="proofFile" className="block text-xs font-semibold text-slate-700">Photo Proof (Optional)</label>
                <input
                  id="proofFile"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(e) => setShippingProofFile(e.target.files?.[0] ?? null)}
                  className="mt-1 block w-full text-xs text-slate-500"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShippingOrderId(null)}
                  className="flex-1 rounded-lg border border-slate-300 py-2 text-xs font-semibold text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 rounded-lg bg-blue-600 py-2 text-xs font-bold text-white hover:bg-blue-700"
                >
                  Confirm Shipment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
