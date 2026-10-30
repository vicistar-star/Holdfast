/**
 * Holdfast API — Fastify application factory.
 * Separated from the server entry point so tests can import buildApp() directly.
 */
import Fastify from "fastify";
import { authRoutes } from "./routes/auth.ts";
import { sellerRoutes } from "./routes/sellers.ts";
import { linkRoutes } from "./routes/links.ts";
import { orderRoutes } from "./routes/orders.ts";
import { adminRoutes } from "./routes/admin.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { setLogger } from "./lib/logger.ts";

import type { RouteOptions } from "fastify";

export async function buildApp(opts: {
  logger?: boolean;
  onRoute?: (routeOptions: RouteOptions) => void;
} = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    // Add a request ID to every request for tracing.
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: "x-request-id",
  });

  if (opts.onRoute) {
    app.addHook("onRoute", opts.onRoute);
  }

  setLogger(app.log);

  // Global hook: add request ID, security headers, and CORS headers.
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("content-security-policy", "default-src 'self'");
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "Content-Type,Authorization,x-request-id,x-webhook-signature,x-filename");
  });

  // Handle CORS preflight options
  app.options("/*", async (_request, reply) => {
    return reply.status(204).send();
  });

  // Parse JSON body.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Routes under /v1
  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(sellerRoutes, { prefix: "/v1/sellers" });
  await app.register(linkRoutes, { prefix: "/v1/links" });
  await app.register(orderRoutes, { prefix: "/v1" });
  await app.register(adminRoutes, { prefix: "/v1/admin" });
  await app.register(adminRoutes, { prefix: "/admin" }); // Alias per README table
  await app.register(webhookRoutes, { prefix: "/v1/webhooks" });
  await app.register(webhookRoutes, { prefix: "/webhooks" });

  // Health check
  app.get("/health", async () => ({ ok: true }));

  return app;
}
