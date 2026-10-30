/**
 * apps/api/src/routes.auth.test.ts
 *
 * Security route audit and authorization verification suite.
 *
 * Requirements verified:
 * 1. Enumerates ALL registered routes and asserts each has a declared authorization policy.
 * 2. Asserts that protected routes reject requests missing authentication tokens (401/403).
 * 3. Asserts that HTTP security headers (nosniff, DENY, HSTS, CSP) and CORS are returned.
 * 4. Asserts path traversal attempts in evidence storage are strictly blocked.
 * 5. Asserts sensitive PII fields (phone, BVN, NIN, tokens) are redacted from logs.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.ts";
import { sanitizePii } from "./lib/logger.ts";
import { StorageService } from "./storage/s3Client.ts";
import { Readable } from "node:stream";

type AuthPolicy =
  | "public"
  | "webhook_signature"
  | "seller"
  | "buyer"
  | "buyer_or_seller"
  | "arbiter";

interface DeclaredRoutePolicy {
  policy: AuthPolicy;
  description: string;
}

const ROUTE_AUTH_REGISTRY: Record<string, DeclaredRoutePolicy> = {
  // Public infrastructure and auth
  "GET /health": { policy: "public", description: "Health check endpoint" },
  "OPTIONS /*": { policy: "public", description: "CORS preflight handler" },
  "POST /v1/auth/otp/request": { policy: "public", description: "Phone OTP request" },
  "POST /v1/auth/otp/verify": { policy: "public", description: "Phone OTP verification" },

  // Public buyer-facing link views and profile badges
  "GET /v1/links/:slug": { policy: "public", description: "Public payment link preview" },
  "POST /v1/links/:slug/orders": { policy: "public", description: "Buyer order creation via payment link" },
  "GET /v1/sellers/:handle/badge.svg": { policy: "public", description: "Public reputation SVG badge" },
  "GET /v1/sellers/:handle/reputation": { policy: "public", description: "Public seller reputation profile" },

  // Partner webhooks (signature-verified)
  "POST /v1/webhooks/payments": { policy: "webhook_signature", description: "Payment partner webhook (HMAC-SHA256)" },
  "POST /webhooks/payments": { policy: "webhook_signature", description: "Payment partner webhook alias" },
  "POST /v1/webhooks/kyc": { policy: "webhook_signature", description: "KYC provider webhook" },
  "POST /webhooks/kyc": { policy: "webhook_signature", description: "KYC provider webhook alias" },

  // Seller-authenticated management routes
  "POST /v1/sellers": { policy: "seller", description: "Create seller profile" },
  "GET /v1/sellers/me": { policy: "seller", description: "Get authenticated seller profile" },
  "PUT /v1/sellers/payout-account": { policy: "seller", description: "Register verified bank payout account" },
  "POST /v1/sellers/kyc": { policy: "seller", description: "Initiate seller KYC verification" },
  "POST /v1/links": { policy: "seller", description: "Create payment link" },
  "POST /v1/orders/:id/ship": { policy: "seller", description: "Mark order as shipped by seller" },

  // Buyer-authenticated order actions
  "POST /v1/orders/:id/confirm": { policy: "buyer", description: "Buyer confirm delivery" },
  "POST /v1/orders/:id/dispute": { policy: "buyer", description: "Buyer open dispute" },

  // Dual buyer / seller authenticated routes
  "GET /v1/orders/:id": { policy: "buyer_or_seller", description: "View order details" },
  "POST /v1/orders/:id/evidence": { policy: "buyer_or_seller", description: "Submit evidence metadata" },
  "POST /v1/orders/:id/evidence/upload": { policy: "buyer_or_seller", description: "Stream evidence file" },

  // Arbiter dispute console
  "GET /v1/admin/disputes": { policy: "arbiter", description: "List disputes for arbiter review" },
  "GET /admin/disputes": { policy: "arbiter", description: "List disputes alias" },
  "GET /v1/admin/disputes/:id": { policy: "arbiter", description: "Get dispute details" },
  "GET /admin/disputes/:id": { policy: "arbiter", description: "Get dispute details alias" },
  "POST /v1/admin/disputes/:id/resolve": { policy: "arbiter", description: "Resolve dispute with split payouts" },
  "POST /admin/disputes/:id/resolve": { policy: "arbiter", description: "Resolve dispute alias" },
};

describe("Security Route Audit & Policy Verification", () => {
  const discoveredRoutes: Array<{ method: string; url: string }> = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    app = await buildApp({
      logger: false,
      onRoute: (routeOptions) => {
        const methods = Array.isArray(routeOptions.method)
          ? routeOptions.method
          : [routeOptions.method];
        for (const m of methods) {
          discoveredRoutes.push({ method: m, url: routeOptions.url });
        }
      },
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("asserts every registered route has an explicit authorization policy", () => {
    assert.ok(discoveredRoutes.length > 0, "Routes must be registered in the application");

    for (const route of discoveredRoutes) {
      if (route.method === "HEAD") continue; // Fastify automatically creates HEAD for GET

      const routeKey = `${route.method} ${route.url}`;
      const policyEntry = ROUTE_AUTH_REGISTRY[routeKey];

      assert.ok(
        policyEntry,
        `SECURITY VIOLATION: Route ${routeKey} is registered in Fastify but has no documented authorization policy!`,
      );
      assert.ok(
        ["public", "webhook_signature", "seller", "buyer", "buyer_or_seller", "arbiter"].includes(
          policyEntry.policy,
        ),
        `Route ${routeKey} has invalid policy: ${policyEntry.policy}`,
      );
    }
  });

  it("enforces authentication on protected routes when no token is provided", async () => {
    const protectedRoutes = [
      { method: "POST", url: "/v1/sellers" },
      { method: "GET", url: "/v1/sellers/me" },
      { method: "PUT", url: "/v1/sellers/payout-account" },
      { method: "POST", url: "/v1/sellers/kyc" },
      { method: "POST", url: "/v1/links" },
      { method: "POST", url: "/v1/orders/00000000-0000-0000-0000-000000000001/ship" },
      { method: "POST", url: "/v1/orders/00000000-0000-0000-0000-000000000001/confirm" },
      { method: "POST", url: "/v1/orders/00000000-0000-0000-0000-000000000001/dispute" },
      { method: "POST", url: "/v1/orders/00000000-0000-0000-0000-000000000001/evidence" },
      { method: "GET", url: "/v1/admin/disputes" },
      { method: "POST", url: "/v1/admin/disputes/00000000-0000-0000-0000-000000000001/resolve" },
    ];

    for (const r of protectedRoutes) {
      const res = await app.inject({
        method: r.method as "GET" | "POST",
        url: r.url,
      });

      // Must be 401 Unauthorized or 403 Forbidden
      assert.ok(
        res.statusCode === 401 || res.statusCode === 403,
        `Expected ${r.method} ${r.url} without token to return 401 or 403, got ${res.statusCode}`,
      );
    }
  });

  it("returns mandatory HTTP security headers on all responses", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
    assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin");
    assert.equal(res.headers["content-security-policy"], "default-src 'self'");
    assert.equal(res.headers["access-control-allow-origin"], "*");
  });

  it("path traversal prevention: strictly blocks directory escape attempts", async () => {
    const storage = new StorageService();

    const dummyStream = new Readable({
      read() {
        this.push(Buffer.from("malicious test payload"));
        this.push(null);
      },
    });

    // Attempt traversal with ../
    await assert.rejects(
      async () => {
        await storage.uploadStream({
          objectKey: "../../../../etc/cron.d/malicious",
          stream: dummyStream,
          contentType: "image/png",
        });
      },
      /Path traversal detected/,
    );

    // Attempt traversal with absolute path
    await assert.rejects(
      async () => {
        await storage.uploadStream({
          objectKey: "/var/log/malicious.png",
          stream: dummyStream,
          contentType: "image/png",
        });
      },
      /Path traversal detected/,
    );
  });

  it("PII redaction: scrubs phone numbers, BVN, NIN, and secrets from logged data", () => {
    const sensitivePayload = {
      order_id: "ord-999",
      buyer_phone: "+2348012345678",
      phone_e164: "+2349098765432",
      bvn: "12345678901",
      nin: "98765432109",
      token: "jwt.secret.token",
      nested: {
        account_number: "0123456789",
        safe_data: "public_info",
      },
    };

    const sanitized = sanitizePii(sensitivePayload);

    assert.equal(sanitized.order_id, "ord-999");
    assert.equal(sanitized.buyer_phone, "[REDACTED]");
    assert.equal(sanitized.phone_e164, "[REDACTED]");
    assert.equal(sanitized.bvn, "[REDACTED]");
    assert.equal(sanitized.nin, "[REDACTED]");
    assert.equal(sanitized.token, "[REDACTED]");
    assert.equal(sanitized.nested.account_number, "[REDACTED]");
    assert.equal(sanitized.nested.safe_data, "public_info");
  });
});
