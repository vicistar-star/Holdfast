/**
 * Holdfast API — server entry point.
 * Starts the Fastify server on PORT (default 3000).
 */
import { buildApp } from "./app.ts";

const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "0.0.0.0";

const app = await buildApp({ logger: true });

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Holdfast API listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
