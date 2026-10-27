/**
 * apps/api — unit tests for auth helpers and state machine integration.
 * These tests do NOT require a database.
 *
 * Integration tests against a real DB are in api.integration.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { issueToken, issueOrderToken, verifyToken } from "./auth/jwt.ts";
import { OtpStore } from "./auth/otpStore.ts";
import { RateLimiter } from "./lib/rateLimiter.ts";

const SECRET = "test-secret-do-not-use-in-production";

// ── JWT ───────────────────────────────────────────────────────────────────────

describe("JWT", () => {
  it("issues and verifies a token", () => {
    const token = issueToken("user-1", "seller", SECRET);
    const result = verifyToken(token, SECRET);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.payload.sub, "user-1");
      assert.equal(result.payload.role, "seller");
    }
  });

  it("rejects a token with wrong secret", () => {
    const token = issueToken("user-1", "seller", SECRET);
    const result = verifyToken(token, "wrong-secret");
    assert.ok(!result.ok);
  });

  it("rejects an expired token", async () => {
    const token = issueToken("user-1", "seller", SECRET, -1); // already expired
    const result = verifyToken(token, SECRET);
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.reason, "expired");
  });

  it("rejects a malformed token", () => {
    const result = verifyToken("not.a.jwt.at.all", SECRET);
    assert.ok(!result.ok);
  });

  it("issues and verifies an order token with order_id claim", () => {
    const token = issueOrderToken("order-123", "+2348000000001", SECRET);
    const result = verifyToken(token, SECRET);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.payload["order_id"], "order-123");
      assert.equal(result.payload.role, "buyer_order");
    }
  });
});

// ── OtpStore ──────────────────────────────────────────────────────────────────

describe("OtpStore", () => {
  it("accepts a valid code", () => {
    const store = new OtpStore();
    store.set("+2348000000001", "123456");
    assert.ok(store.verify("+2348000000001", "123456"));
  });

  it("rejects a wrong code", () => {
    const store = new OtpStore();
    store.set("+2348000000001", "123456");
    assert.ok(!store.verify("+2348000000001", "999999"));
  });

  it("rejects after expiry", async () => {
    const store = new OtpStore(1); // 1 ms TTL
    store.set("+2348000000001", "123456");
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(!store.verify("+2348000000001", "123456"));
  });

  it("rejects after max attempts", () => {
    const store = new OtpStore(60_000, 2);
    store.set("+2348000000001", "123456");
    assert.ok(!store.verify("+2348000000001", "wrong1"));
    assert.ok(!store.verify("+2348000000001", "wrong2"));
    // Third attempt — entry deleted due to max attempts
    assert.ok(!store.verify("+2348000000001", "123456"));
  });

  it("deletes entry on success (no replay)", () => {
    const store = new OtpStore();
    store.set("+2348000000001", "123456");
    assert.ok(store.verify("+2348000000001", "123456"));
    assert.ok(!store.verify("+2348000000001", "123456")); // second use fails
  });
});

// ── RateLimiter ───────────────────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("allows requests within limit", () => {
    const rl = new RateLimiter(3, 60_000);
    assert.ok(rl.allow("key1"));
    assert.ok(rl.allow("key1"));
    assert.ok(rl.allow("key1"));
  });

  it("blocks the 4th request", () => {
    const rl = new RateLimiter(3, 60_000);
    rl.allow("key1"); rl.allow("key1"); rl.allow("key1");
    assert.ok(!rl.allow("key1"));
  });

  it("resets after window expires", async () => {
    const rl = new RateLimiter(1, 10); // 10ms window
    assert.ok(rl.allow("key2"));
    assert.ok(!rl.allow("key2"));
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(rl.allow("key2")); // new window
  });

  it("tracks different keys independently", () => {
    const rl = new RateLimiter(1, 60_000);
    assert.ok(rl.allow("a"));
    assert.ok(!rl.allow("a"));
    assert.ok(rl.allow("b")); // independent key
  });
});
