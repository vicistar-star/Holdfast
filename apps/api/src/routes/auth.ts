/**
 * POST /v1/auth/otp/request  — send OTP to phone
 * POST /v1/auth/otp/verify   — exchange OTP for access token
 */
import type { FastifyInstance } from "fastify";
import { OtpRequestSchema, OtpVerifySchema } from "@holdfast/shared";
import { ConsoleOtpProvider, generateOtp } from "../auth/otp.ts";
import { OtpStore } from "../auth/otpStore.ts";
import { issueToken } from "../auth/jwt.ts";
import { badRequest, tooManyRequests } from "../lib/errors.ts";
import { RateLimiter } from "../lib/rateLimiter.ts";
import { db, schema } from "@holdfast/db";
import { eq } from "drizzle-orm";

const otpStore = new OtpStore();
const otpProvider = new ConsoleOtpProvider();
// 5 OTP requests per phone per 10 minutes
const otpRateLimit = new RateLimiter(5, 10 * 60 * 1000);

const JWT_SECRET = process.env["JWT_SECRET"] ?? "dev-secret-change-me";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/auth/otp/request
  app.post("/otp/request", async (request, reply) => {
    const parsed = OtpRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id as string);
    }
    const { phone } = parsed.data;

    if (!otpRateLimit.allow(phone)) {
      return tooManyRequests(reply, request.id as string);
    }

    const code = generateOtp();
    otpStore.set(phone, code);
    await otpProvider.send(phone, code);

    // No user creation yet — that happens at verify time.
    reply.status(200).send({ ok: true });
  });

  // POST /v1/auth/otp/verify
  app.post("/otp/verify", async (request, reply) => {
    const parsed = OtpVerifySchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? "Invalid input", request.id as string);
    }
    const { phone, code } = parsed.data;

    if (!otpStore.verify(phone, code)) {
      return badRequest(reply, "Invalid or expired OTP", request.id as string);
    }

    // Upsert the user — create on first login, return existing on subsequent logins.
    let user = await db.query.users.findFirst({ where: eq(schema.users.phone_e164, phone) });
    if (!user) {
      const rows = await db
        .insert(schema.users)
        .values({ phone_e164: phone, role: "buyer" })
        .returning();
      user = rows[0]!;
    }

    const token = issueToken(user.id, user.role, JWT_SECRET, 900);
    reply.status(200).send({ access_token: token, expires_in: 900 });
  });
}
