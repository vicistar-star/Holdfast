/**
 * Consistent API error helpers.
 *
 * Every error response has the shape:
 *   { error: { code: string; message: string; request_id?: string } }
 */
import type { FastifyReply } from "fastify";

export interface ApiError {
  code: string;
  message: string;
  request_id?: string;
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  requestId?: string,
): void {
  const body: { error: ApiError } = { error: { code, message } };
  if (requestId) body.error.request_id = requestId;
  reply.status(status).send(body);
}

export function badRequest(reply: FastifyReply, message: string, requestId?: string): void {
  sendError(reply, 400, "BAD_REQUEST", message, requestId);
}

export function unauthorized(reply: FastifyReply, requestId?: string): void {
  sendError(reply, 401, "UNAUTHORIZED", "Authentication required", requestId);
}

export function forbidden(reply: FastifyReply, requestId?: string): void {
  sendError(reply, 403, "FORBIDDEN", "Not allowed", requestId);
}

export function notFound(reply: FastifyReply, entity: string, requestId?: string): void {
  sendError(reply, 404, "NOT_FOUND", `${entity} not found`, requestId);
}

export function conflict(reply: FastifyReply, message: string, requestId?: string): void {
  sendError(reply, 409, "CONFLICT", message, requestId);
}

export function tooManyRequests(reply: FastifyReply, requestId?: string): void {
  sendError(reply, 429, "RATE_LIMITED", "Too many requests, slow down", requestId);
}

export function internalError(reply: FastifyReply, requestId?: string): void {
  sendError(reply, 500, "INTERNAL_ERROR", "An unexpected error occurred", requestId);
}
