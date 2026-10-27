/**
 * Structured logger wrapper.
 *
 * Wraps Fastify's built-in pino logger. Import and use `log` instead of
 * console.log so all output is structured JSON. Never log PII — no phone
 * numbers, names, or identity data in log messages.
 */
import type { FastifyBaseLogger } from "fastify";

let _logger: FastifyBaseLogger | null = null;

/** Called once at startup with the Fastify logger instance. */
export function setLogger(logger: FastifyBaseLogger): void {
  _logger = logger;
}

function get(): FastifyBaseLogger {
  if (!_logger) throw new Error("Logger not initialized — call setLogger() first");
  return _logger;
}

export const log = {
  info: (msg: string, data?: object) => get().info(data ?? {}, msg),
  warn: (msg: string, data?: object) => get().warn(data ?? {}, msg),
  error: (msg: string, data?: object) => get().error(data ?? {}, msg),
  debug: (msg: string, data?: object) => get().debug(data ?? {}, msg),
};
