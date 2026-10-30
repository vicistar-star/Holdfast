/**
 * Structured logger wrapper.
 *
 * Wraps Fastify's built-in pino logger. Import and use `log` instead of
 * console.log so all output is structured JSON. Never log PII — no phone
 * numbers, names, or identity data in log messages.
 */
import type { FastifyBaseLogger } from "fastify";

let _logger: FastifyBaseLogger | null = null;

const SENSITIVE_KEYS = new Set([
  "phone",
  "buyer_phone",
  "phone_e164",
  "bvn",
  "nin",
  "account_number",
  "account_ref",
  "token",
  "access_token",
  "order_token",
  "authorization",
  "secret",
  "password",
  "seed",
  "private_key",
]);

/** Recursively mask sensitive fields to prevent accidental PII leakage in logs. */
export function sanitizePii<T>(val: T): T {
  if (!val || typeof val !== "object") return val;
  if (Array.isArray(val)) {
    const arr = (val as unknown[]).map((item: unknown) => sanitizePii(item));
    return arr as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(val as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      result[key] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      result[key] = sanitizePii(v);
    } else {
      result[key] = v;
    }
  }
  return result as unknown as T;
}

/** Called once at startup with the Fastify logger instance. */
export function setLogger(logger: FastifyBaseLogger): void {
  _logger = logger;
}

function get(): FastifyBaseLogger {
  if (!_logger) throw new Error("Logger not initialized — call setLogger() first");
  return _logger;
}

export const log = {
  info: (msg: string, data?: object) => get().info(data ? sanitizePii(data) : {}, msg),
  warn: (msg: string, data?: object) => get().warn(data ? sanitizePii(data) : {}, msg),
  error: (msg: string, data?: object) => get().error(data ? sanitizePii(data) : {}, msg),
  debug: (msg: string, data?: object) => get().debug(data ? sanitizePii(data) : {}, msg),
};
