/**
 * JWT helpers — HS256 using Node.js built-in crypto.
 * No external JWT library needed.
 *
 * Tokens are short-lived bearer tokens issued after OTP verification.
 * Order tokens are signed tokens with a fixed sub and an order claim,
 * used to grant buyers access to their order without requiring an account.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const ALG = "HS256";

function b64url(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64url");
}

function sign(payload: object, secret: string, expiresInSecs: number): string {
  const header = b64url(JSON.stringify({ alg: ALG, typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSecs }),
  );
  const sig = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

export interface JwtPayload {
  sub: string;
  role: string;
  exp: number;
  iat: number;
  [key: string]: unknown;
}

function decode(token: string): { header: object; payload: JwtPayload; sig: string; unsigned: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as object;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as JwtPayload;
    return { header, payload, sig: parts[2]!, unsigned: `${parts[0]}.${parts[1]}` };
  } catch {
    return null;
  }
}

export function issueToken(sub: string, role: string, secret: string, expiresInSecs = 900): string {
  return sign({ sub, role }, secret, expiresInSecs);
}

/** Issue a signed order token for buyer access (no buyer account required). */
export function issueOrderToken(orderId: string, buyerPhone: string, secret: string, expiresInSecs = 86400): string {
  return sign({ sub: `order:${orderId}`, role: "buyer_order", order_id: orderId, buyer_phone: buyerPhone }, secret, expiresInSecs);
}

export type VerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: string };

export function verifyToken(token: string, secret: string): VerifyResult {
  const decoded = decode(token);
  if (!decoded) return { ok: false, reason: "malformed" };

  // Re-derive the expected signature and compare in constant time.
  const expected = createHmac("sha256", secret)
    .update(decoded.unsigned)
    .digest("base64url");

  const a = Buffer.from(expected);
  const b = Buffer.from(decoded.sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid signature" };
  }

  if (decoded.payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload: decoded.payload };
}
