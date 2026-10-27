/**
 * Simple in-memory rate limiter.
 *
 * Maps a key (e.g. IP + route) to { count, windowStart }.
 * A request is allowed if count < limit within the current window.
 *
 * In production, replace with a Redis-backed sliding window counter.
 * ASSUMPTION: in-memory is fine for v1 single-process dev.
 */
export class RateLimiter {
  private readonly map = new Map<string, { count: number; windowStart: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns true if the request should be allowed, false if rate-limited. */
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.map.get(key);

    if (!entry || now - entry.windowStart > this.windowMs) {
      this.map.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  purge(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now - entry.windowStart > this.windowMs) this.map.delete(key);
    }
  }
}
