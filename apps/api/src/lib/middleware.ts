/**
 * Fastify middleware: authenticate a request and attach the JWT payload.
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken, type JwtPayload } from "../auth/jwt.ts";
import { unauthorized } from "./errors.ts";

declare module "fastify" {
  interface FastifyRequest {
    jwtPayload?: JwtPayload;
  }
}

const JWT_SECRET = process.env["JWT_SECRET"] ?? "dev-secret-change-me";

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    unauthorized(reply, request.id as string);
    return false;
  }
  const result = verifyToken(auth.slice(7), JWT_SECRET);
  if (!result.ok) {
    unauthorized(reply, request.id as string);
    return false;
  }
  request.jwtPayload = result.payload;
  return true;
}

export async function requireRole(
  request: FastifyRequest,
  reply: FastifyReply,
  role: string,
): Promise<boolean> {
  if (!(await authenticate(request, reply))) return false;
  if (request.jwtPayload?.role !== role) {
    unauthorized(reply, request.id as string);
    return false;
  }
  return true;
}
