/**
 * OTP provider interface and implementations.
 *
 * The interface is the boundary — swap the mock for a real SMS provider
 * (Termii, Africa's Talking) without touching the auth routes.
 */

export interface OtpProvider {
  /** Send a 6-digit OTP to the given E.164 phone number. */
  send(phone: string, code: string): Promise<void>;
}

/**
 * Console/mock OTP provider for local development.
 * Prints the OTP to stdout — never use in production.
 *
 * ASSUMPTION: Real SMS delivery is behind this interface. Implement a
 * TermiiProvider or AfricasTalkingProvider when you have API keys.
 * Mark that implementation with the real partner's docs, not invented endpoints.
 */
export class ConsoleOtpProvider implements OtpProvider {
  async send(phone: string, code: string): Promise<void> {
    // In dev/test this just logs. Production uses a real SMS provider.
    console.log(`[OTP mock] ${phone} → code: ${code}`);
  }
}

/** Generate a cryptographically random 6-digit OTP. */
import { randomInt } from "node:crypto";

export function generateOtp(): string {
  return String(randomInt(100_000, 1_000_000)).padStart(6, "0");
}
