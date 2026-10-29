import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const { handle: rawHandle } = await params;
  const handle = rawHandle.replace(/\.svg$/, "");

  const apiBase = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3000/v1";

  let isVerified = false;
  let isNewSeller = true;
  let completedOrders = 0;

  try {
    const res = await fetch(`${apiBase}/sellers/${handle}/reputation`, {
      next: { revalidate: 300 },
    });
    if (res.ok) {
      const data = await res.json();
      isVerified = data.isVerified ?? false;
      isNewSeller = data.isNewSeller ?? true;
      completedOrders = data.completedOrdersLifetime ?? 0;
    }
  } catch {
    // Fallback gracefully if API is offline
  }

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="340" height="88" viewBox="0 0 340 88" role="img" aria-label="Holdfast Escrow Verified Seller Badge for @${escapeXml(handle)}">
  <title>Holdfast Seller: @${escapeXml(handle)}</title>
  <desc>Verified escrow track record powered by Holdfast</desc>
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
  </defs>

  <!-- Card Body -->
  <rect width="338" height="86" x="1" y="1" rx="12" fill="url(#bg)" stroke="#334155" stroke-width="1.5" />

  <!-- Shield Icon -->
  <g transform="translate(16, 20)">
    <path d="M16 2 L4 7 V16 C4 23.5 9.1 30.5 16 32 C22.9 30.5 28 23.5 28 16 V7 Z" fill="#2563eb" />
    <path d="M11 16 L14.5 19.5 L21 13" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <!-- Seller Handle -->
  <text x="56" y="32" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="15" font-weight="700" fill="#f8fafc">
    @${escapeXml(handle)}
  </text>

  <!-- Verified Pill / Performance -->
  ${
    isVerified
      ? `<g transform="translate(56, 42)">
          <rect width="78" height="20" rx="10" fill="#065f46" />
          <text x="8" y="14" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="600" fill="#34d399">✓ Verified</text>
         </g>`
      : `<g transform="translate(56, 42)">
          <rect width="90" height="20" rx="10" fill="#374151" />
          <text x="8" y="14" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="500" fill="#9ca3af">New Seller</text>
         </g>`
  }

  <text x="${isVerified ? 142 : 154}" y="56" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="500" fill="#94a3b8">
    ${isNewSeller ? "Safe Escrow" : `${completedOrders} completed orders`}
  </text>

  <!-- Footer Brand -->
  <text x="56" y="74" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="10" font-weight="500" fill="#64748b">
    Protected by Holdfast Escrow
  </text>
</svg>
`.trim();

  return new NextResponse(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=600",
    },
  });
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}
