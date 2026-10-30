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

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    // Add a request ID to every request for tracing.
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: "x-request-id",
  });

  setLogger(app.log);

  // Global hook: add request ID to every response.
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
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
