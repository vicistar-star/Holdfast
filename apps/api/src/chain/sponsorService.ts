/**
 * SponsorService — pays Stellar fees and base reserves on behalf of users.
 *
 * Responsibilities:
 * - Fee-bump transactions so users never need XLM.
 * - Sponsored reserve creation for new managed accounts.
 * - USDC trustline setup (Mode B).
 * - Per-account and per-day fee budget enforcement.
 * - Low-balance alert hook.
 *
 * The sponsor key MUST live in a KMS/HSM in production.
 * In dev, SPONSOR_SECRET in .env is accepted (dev only — never production).
 *
 * ASSUMPTION: Sponsor budget limits are configurable via env vars.
 * Real KMS integration is a TODO stub (see keyStore.ts).
 */

export interface SponsorBudget {
  /** Maximum XLM stroops to spend per account per day. */
  perAccountDailyStroops: bigint;
  /** Maximum XLM stroops in the sponsor account before alerting. */
  lowBalanceAlertStroops: bigint;
}

export const DEFAULT_SPONSOR_BUDGET: SponsorBudget = {
  perAccountDailyStroops: 1_000_000n,   // 0.1 XLM per account per day
  lowBalanceAlertStroops: 10_000_000n,  // alert when < 1 XLM
};

interface AccountSpend {
  stroops: bigint;
  windowStart: number; // unix ms
}

export type LowBalanceAlertHook = (currentStroops: bigint) => void;

export class SponsorService {
  private readonly spendMap = new Map<string, AccountSpend>();
  private readonly budget: SponsorBudget;
  private lowBalanceHook: LowBalanceAlertHook | null = null;

  constructor(budget: SponsorBudget = DEFAULT_SPONSOR_BUDGET) {
    this.budget = budget;
  }

  onLowBalance(hook: LowBalanceAlertHook): void {
    this.lowBalanceHook = hook;
  }

  /**
   * Check whether sponsoring `stroops` for `accountId` is within budget.
   * Throws if the budget would be exceeded.
   */
  checkBudget(accountId: string, stroops: bigint): void {
    const now = Date.now();
    const DAY_MS = 86_400_000;
    const existing = this.spendMap.get(accountId);

    if (!existing || now - existing.windowStart > DAY_MS) {
      // Fresh window.
      this.spendMap.set(accountId, { stroops: 0n, windowStart: now });
    }

    const current = this.spendMap.get(accountId)!;
    if (current.stroops + stroops > this.budget.perAccountDailyStroops) {
      throw new Error(
        `Sponsor budget exhausted for account ${accountId}: ` +
        `${current.stroops + stroops} > ${this.budget.perAccountDailyStroops} stroops/day`,
      );
    }
  }

  /** Record that `stroops` were spent for `accountId`. */
  recordSpend(accountId: string, stroops: bigint): void {
    const entry = this.spendMap.get(accountId);
    if (entry) {
      entry.stroops += stroops;
    }
  }

  /** Simulate checking sponsor balance and firing the low-balance alert. */
  checkBalance(currentStroops: bigint): void {
    if (currentStroops < this.budget.lowBalanceAlertStroops) {
      this.lowBalanceHook?.(currentStroops);
    }
  }
}

export const sponsorService = new SponsorService();
