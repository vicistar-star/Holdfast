# Runbook: Sponsor Account Balance Low

## Symptoms
- Alert: `sponsor_balance_stroops < 10000000` (< 1 XLM remaining in sponsor pool).
- Logs show `Sponsor budget exhausted` or warnings from `sponsorService.checkBalance()`.
- Users in Mode B fail to execute on-chain escrow operations with `insufficient funds for gas/reserves`.

## Diagnosis Steps
1. **Query on-chain sponsor balance via Stellar CLI**:
   ```bash
   stellar keys address sponsor
   stellar account info --id $(stellar keys address sponsor) --network testnet
   ```
2. **Review daily spend by account**:
   Inspect whether a single malicious or high-velocity account is exhausting sponsorship allowances.
3. **Verify alerts**:
   Confirm whether automatic alert hooks (Slack, PagerDuty, or email) received the low-balance trigger.

## Fix
1. **Top up the sponsor account immediately**:
   - **On Testnet**:
     ```bash
     curl "https://friendbot.stellar.org?addr=$(stellar keys address sponsor)"
     ```
   - **On Mainnet**:
     Initiate an operational transfer of native XLM (e.g. 500 XLM) from the cold treasury wallet to the sponsor public address.
2. **Mitigate abnormal drainage**:
   If an abusive account triggered high fee burn, lower `DEFAULT_SPONSOR_BUDGET.perAccountDailyStroops` in environment configuration and restart the API:
   ```bash
   export SPONSOR_PER_ACCOUNT_DAILY_STROOPS=500000
   ```

## How to Verify
1. Verify the on-chain balance has updated:
   ```bash
   stellar account info --id $(stellar keys address sponsor) --network testnet | grep -i balance
   ```
2. Check metrics endpoint:
   ```bash
   curl -s http://localhost:3001/metrics | jq .sponsor_balance_stroops
   ```
   Ensure `sponsor_balance_stroops` reflects the topped-up balance and the alert clears.
