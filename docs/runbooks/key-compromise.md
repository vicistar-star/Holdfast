# Runbook: Suspected Key Compromise (Arbiter, Admin, or Sponsor)

## Symptoms
- Unexpected on-chain transactions signed by admin, arbiter, or sponsor keypairs.
- Dispute resolutions routing funds to unknown addresses.
- Unauthorized changes to `fee_bps` or `treasury`.
- Leak of environment secrets or KMS access credentials.

## Immediate Emergency Actions (Within 5 Minutes)

1. **Pause the Soroban Contract**:
   Admin key invokes `pause()` to immediately block all new order creation:
   ```bash
   stellar contract invoke \
     --id $ESCROW_CONTRACT_ID \
     --source admin \
     --network $STELLAR_NETWORK \
     -- pause
   ```
   *Note: Invariant 5 guarantees that pause blocks only `create_and_fund`; settlement paths stay open for existing orders.*

2. **Revoke compromised API / KMS credentials**:
   - In AWS KMS or IAM console, disable the compromised KMS key or service role immediately.
   - In payment partner dashboards (Paystack, Flutterwave), regenerate all API keys and webhook signing secrets.

3. **Rotate Sponsor Keypair**:
   - Drain remaining XLM from the compromised sponsor address to a secure treasury address.
   - Generate a fresh sponsor keypair in KMS/HSM and fund it with operational gas.
   - Update `SPONSOR_SECRET` or KMS key ID in the API deployment configuration and restart.

4. **Rotate Arbiter Address**:
   - Deploy new contract or multi-sig arbiter configuration.
   - If arbiter key was single-sig, transition immediately to multi-sig with hardware-backed signing keys (e.g., Ledger).

## Diagnosis & Forensic Steps
1. **Audit on-chain transaction history**:
   ```bash
   stellar account info --id <COMPROMISED_PUBLIC_KEY> --network $STELLAR_NETWORK
   ```
2. **Review server access and audit logs**:
   Inspect cloud access logs, SSH logins, and API access logs for anomalous IP addresses.
3. **Verify state of all open orders**:
   ```sql
   SELECT id, status, amount_minor FROM orders WHERE status IN ('Funded', 'Shipped', 'Disputed');
   ```

## Recovery & How to Verify
1. Verify contract is paused:
   ```bash
   stellar contract invoke \
     --id $ESCROW_CONTRACT_ID \
     --source admin \
     --network $STELLAR_NETWORK \
     -- get_order --id 1
   ```
2. Confirm new secrets are loaded and services operating normally:
   ```bash
   curl -s http://localhost:3001/health | jq .ok
   curl -s http://localhost:3001/metrics | jq .sponsor_balance_stroops
   ```
3. Issue an incident report and notify affected users in accordance with privacy and security disclosure policies.
