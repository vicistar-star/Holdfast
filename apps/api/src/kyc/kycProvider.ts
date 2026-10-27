/**
 * KYC provider interface and MockKycProvider.
 *
 * Raw BVN/NIN/ID document data is NEVER stored. Only the verification
 * result (pass/fail) and the provider's opaque reference are persisted.
 *
 * Tier 0 → Tier 1 transition requires:
 *   1. Successful KYC result
 *   2. A verified payout account whose resolved name matches the KYC name
 *      (tolerant matching via normaliseNameForMatch)
 *
 * ASSUMPTION: Only MockKycProvider is implemented. A real provider
 * (Smile ID, Dojah, Prembly, Youverify) follows the same interface.
 * Mark all real endpoints as "ASSUMPTION:" until verified against provider docs.
 */

export interface KycStartRequest {
  user_id: string;
  /** The type of check — 'identity' for NIN/BVN, 'business' for CAC. */
  check_type: "identity" | "business";
}

export interface KycStartResult {
  /** Opaque provider reference — stored in sellers.kyc_ref. */
  provider_ref: string;
  /** URL the user opens to complete the KYC flow (if applicable). */
  redirect_url?: string;
}

export interface KycStatusResult {
  provider_ref: string;
  status: "pending" | "approved" | "rejected";
  /** The verified full name from the provider — used for name matching. */
  verified_name?: string;
  /** Rejection reason (never raw ID data). */
  rejection_reason?: string;
}

export interface KycProvider {
  start(req: KycStartRequest): Promise<KycStartResult>;
  getStatus(providerRef: string): Promise<KycStatusResult>;
  /** Parse and validate a KYC webhook payload. Returns null if invalid. */
  parseWebhook(rawBody: string, signature: string): Promise<KycStatusResult | null>;
}

export class MockKycProvider implements KycProvider {
  private readonly store = new Map<string, KycStatusResult>();

  async start(req: KycStartRequest): Promise<KycStartResult> {
    const provider_ref = `mock_kyc_${req.user_id}_${Date.now()}`;
    this.store.set(provider_ref, { provider_ref, status: "pending" });
    return { provider_ref };
  }

  async getStatus(providerRef: string): Promise<KycStatusResult> {
    return this.store.get(providerRef) ?? { provider_ref: providerRef, status: "pending" };
  }

  async parseWebhook(rawBody: string, _signature: string): Promise<KycStatusResult | null> {
    try {
      const parsed = JSON.parse(rawBody) as { provider_ref: string; status: string; verified_name?: string };
      if (!parsed.provider_ref || !parsed.status) return null;
      const result: KycStatusResult = {
        provider_ref: parsed.provider_ref,
        status: parsed.status as KycStatusResult["status"],
        verified_name: parsed.verified_name,
      };
      this.store.set(parsed.provider_ref, result);
      return result;
    } catch {
      return null;
    }
  }

  /** Test helper: approve a pending check. */
  approveCheck(providerRef: string, verifiedName: string): void {
    this.store.set(providerRef, { provider_ref: providerRef, status: "approved", verified_name: verifiedName });
  }
}

// ── Name matching helper ──────────────────────────────────────────────────────

/**
 * Normalise a name for fuzzy matching (case-fold, strip punctuation/extra spaces).
 * Used to compare KYC verified_name against payout account holder name.
 *
 * Tolerant: "ADAEZE OKOYE" matches "Adaeze Okoye" and "ADAEZE  OKOYE".
 * Strict enough: "JOHN DOE" does NOT match "JANE DOE".
 */
export function normaliseNameForMatch(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true if kycName and accountName are a close enough match.
 * Strategy: exact match after normalisation, or one is a subset of the other
 * (handles middle-name omissions common in Nigerian bank records).
 */
export function namesMatch(kycName: string, accountName: string): boolean {
  const a = normaliseNameForMatch(kycName);
  const b = normaliseNameForMatch(accountName);
  if (a === b) return true;
  // Allow subset match: all tokens of the shorter name appear in the longer name.
  const tokensA = a.split(" ");
  const tokensB = b.split(" ");
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return shorter.every((t) => longer.includes(t));
}
