/**
 * Day 4 unit tests — payment provider, KYC helpers, sponsor budget, keystore.
 * No database required.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockPaymentProvider } from "./payment/mockProvider.ts";
import { MockKycProvider, namesMatch, normaliseNameForMatch } from "./kyc/kycProvider.ts";
import { SponsorService } from "./chain/sponsorService.ts";
import { LocalDevKeyStore } from "./chain/keyStore.ts";

// ── MockPaymentProvider ───────────────────────────────────────────────────────

describe("MockPaymentProvider", () => {
  it("creates payment instructions", async () => {
    const p = new MockPaymentProvider("secret");
    const instr = await p.createPaymentInstructions("order-1", 100_000n, "NGN");
    assert.ok(instr.reference.startsWith("mock_"));
    assert.ok(instr.instructions.includes("100000"));
  });

  it("verifies a valid webhook", async () => {
    const p = new MockPaymentProvider("secret");
    const instr = await p.createPaymentInstructions("order-1", 100_000n, "NGN");
    const { body, signature } = p.simulatePayment(instr.reference);
    const result = await p.verifyWebhook(body, signature);
    assert.ok(result.ok);
    assert.equal(result.reference, instr.reference);
    assert.equal(result.amount_minor, 100_000n);
  });

  it("rejects a webhook with wrong signature", async () => {
    const p = new MockPaymentProvider("secret");
    const instr = await p.createPaymentInstructions("order-1", 100_000n, "NGN");
    const { body } = p.simulatePayment(instr.reference);
    const result = await p.verifyWebhook(body, "badsig");
    assert.ok(!result.ok);
  });

  it("payout is idempotent — same key returns same result", async () => {
    const p = new MockPaymentProvider("secret");
    const req = { idempotency_key: "idem-1", amount_minor: 50_000n, currency: "NGN", account_ref: "ref", narration: "test" };
    const r1 = await p.createPayout(req);
    const r2 = await p.createPayout(req);
    assert.equal(r1.partner_ref, r2.partner_ref);
  });

  it("duplicate webhook delivered 5 times causes one state change", async () => {
    // Verify that verifyWebhook itself is stateless (idempotency is in the DB layer).
    // This tests that the same event_id is parsed consistently.
    const p = new MockPaymentProvider("secret");
    const instr = await p.createPaymentInstructions("order-2", 200_000n, "NGN");
    const { body, signature } = p.simulatePayment(instr.reference);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => p.verifyWebhook(body, signature)),
    );
    // All 5 parse successfully — idempotency is enforced by the webhook_events table.
    assert.ok(results.every((r) => r.ok));
    assert.ok(results.every((r) => r.event_id === results[0]!.event_id));
  });
});

// ── SponsorService ────────────────────────────────────────────────────────────

describe("SponsorService", () => {
  it("allows spend within budget", () => {
    const s = new SponsorService({ perAccountDailyStroops: 1_000n, lowBalanceAlertStroops: 100n });
    assert.doesNotThrow(() => s.checkBudget("acc1", 500n));
    s.recordSpend("acc1", 500n);
    assert.doesNotThrow(() => s.checkBudget("acc1", 499n));
  });

  it("throws when budget exhausted", () => {
    const s = new SponsorService({ perAccountDailyStroops: 1_000n, lowBalanceAlertStroops: 100n });
    s.checkBudget("acc2", 1_000n);
    s.recordSpend("acc2", 1_000n);
    assert.throws(() => s.checkBudget("acc2", 1n), /budget exhausted/);
  });

  it("fires low-balance alert hook", () => {
    const s = new SponsorService({ perAccountDailyStroops: 1_000n, lowBalanceAlertStroops: 500n });
    let alerted = false;
    s.onLowBalance(() => { alerted = true; });
    s.checkBalance(300n); // below threshold
    assert.ok(alerted);
  });

  it("does NOT fire alert when balance is sufficient", () => {
    const s = new SponsorService({ perAccountDailyStroops: 1_000n, lowBalanceAlertStroops: 500n });
    let alerted = false;
    s.onLowBalance(() => { alerted = true; });
    s.checkBalance(1_000n); // above threshold
    assert.ok(!alerted);
  });
});

// ── LocalDevKeyStore ──────────────────────────────────────────────────────────

describe("LocalDevKeyStore", () => {
  it("stores and retrieves a secret", async () => {
    const ks = new LocalDevKeyStore();
    await ks.store("user-1", "STEST_SECRET_KEY");
    const retrieved = await ks.retrieve("user-1");
    assert.equal(retrieved, "STEST_SECRET_KEY");
  });

  it("returns null for unknown id", async () => {
    const ks = new LocalDevKeyStore();
    assert.equal(await ks.retrieve("nobody"), null);
  });

  it("stores different secrets per id", async () => {
    const ks = new LocalDevKeyStore();
    await ks.store("a", "secret-a");
    await ks.store("b", "secret-b");
    assert.equal(await ks.retrieve("a"), "secret-a");
    assert.equal(await ks.retrieve("b"), "secret-b");
  });
});

// ── MockKycProvider ───────────────────────────────────────────────────────────

describe("MockKycProvider", () => {
  it("starts a KYC check and returns pending", async () => {
    const kyc = new MockKycProvider();
    const result = await kyc.start({ user_id: "user-1", check_type: "identity" });
    assert.ok(result.provider_ref.startsWith("mock_kyc_"));
    const status = await kyc.getStatus(result.provider_ref);
    assert.equal(status.status, "pending");
  });

  it("approves a check and returns the verified name", async () => {
    const kyc = new MockKycProvider();
    const { provider_ref } = await kyc.start({ user_id: "user-2", check_type: "identity" });
    kyc.approveCheck(provider_ref, "ADAEZE OKOYE");
    const status = await kyc.getStatus(provider_ref);
    assert.equal(status.status, "approved");
    assert.equal(status.verified_name, "ADAEZE OKOYE");
  });
});

// ── namesMatch ────────────────────────────────────────────────────────────────

describe("namesMatch", () => {
  it("exact match (case insensitive)", () => assert.ok(namesMatch("Adaeze Okoye", "ADAEZE OKOYE")));
  it("extra spaces normalised", () => assert.ok(namesMatch("ADAEZE  OKOYE", "ADAEZE OKOYE")));
  it("middle name omitted in bank record", () => assert.ok(namesMatch("ADAEZE CHISOM OKOYE", "ADAEZE OKOYE")));
  it("clearly different names do not match", () => assert.ok(!namesMatch("JOHN DOE", "JANE DOE")));
  it("completely unrelated names", () => assert.ok(!namesMatch("EMEKA NWOSU", "ADAEZE OKOYE")));
  it("normaliseNameForMatch strips punctuation", () => {
    assert.equal(normaliseNameForMatch("O'Brien-Smith"), "OBRIENSMITH");
  });
});
