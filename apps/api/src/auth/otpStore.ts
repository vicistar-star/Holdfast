/**
 * In-memory OTP store — maps phone -> { code, expiresAt, attempts }.
 *
 * In production replace with Redis (TTL key) so restarts and horizontal
 * scale don't lose OTPs. The interface stays the same.
 *
 * ASSUMPTION: Using in-memory store for v1 dev. Production needs Redis.
 */

interface Entry {
  code: string;
  expiresAt: number; // unix ms
  attempts: number;
}

export class OtpStore {
  private readonly map = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;

  constructor(ttlMs = 5 * 60 * 1000, maxAttempts = 3) {
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
  }

  set(phone: string, code: string): void {
    this.map.set(phone, {
      code,
      expiresAt: Date.now() + this.ttlMs,
      attempts: 0,
    });
  }

  /**
   * Verify and consume the OTP for a phone number.
   * Returns true on success, false on wrong code / expired / too many attempts.
   * Deletes the entry on success.
   */
  verify(phone: string, code: string): boolean {
    const entry = this.map.get(phone);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(phone);
      return false;
    }
    if (entry.attempts >= this.maxAttempts) {
      this.map.delete(phone);
      return false;
    }
    entry.attempts += 1;
    if (entry.code !== code) return false;
    this.map.delete(phone);
    return true;
  }

  /** Remove expired entries (call periodically to avoid memory leak). */
  purgeExpired(): void {
    const now = Date.now();
    for (const [phone, entry] of this.map) {
      if (now > entry.expiresAt) this.map.delete(phone);
    }
  }
}
