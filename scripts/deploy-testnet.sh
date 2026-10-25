#!/usr/bin/env bash
# scripts/deploy-testnet.sh
#
# Builds the escrow WASM, deploys it to Stellar testnet, and initialises the contract.
#
# Usage:
#   ./scripts/deploy-testnet.sh
#
# Prerequisites:
#   - Stellar CLI installed and in PATH (stellar --version)
#   - Rust with wasm32v1-none target
#   - The following identities already created (or the script will create them):
#       deployer, arbiter, treasury
#   - Internet access (connects to testnet RPC and Friendbot)
#
# Idempotency: re-running after a successful deploy will deploy a new contract instance.
# Keep the printed CONTRACT_ID — you need it in .env.
#
# DO NOT embed real secrets here. This script uses named identities stored by the CLI,
# not raw secret keys.

set -euo pipefail

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Fee in basis points (1% = 100). Must be ≤ 500 (hard cap in contract).
FEE_BPS=100

# Max order amount in the token's smallest unit.
# For USDC (7 decimals): 50_000_0000000 = 50,000 USDC. Adjust for your token.
# For local dev / testnet, use a lower value.
MAX_ORDER_AMOUNT=10000000

WASM_PATH="target/wasm32v1-none/release/escrow.wasm"

echo "=== Holdfast testnet deployment ==="
echo "Network:    $NETWORK"
echo "RPC URL:    $RPC_URL"
echo ""

# ── Step 1: Build WASM ────────────────────────────────────────────────────────

echo "[1/6] Building WASM..."
cargo build \
  --manifest-path contracts/escrow/Cargo.toml \
  --target wasm32v1-none \
  --release

if [[ ! -f "$WASM_PATH" ]]; then
  echo "ERROR: WASM not found at $WASM_PATH" >&2
  exit 1
fi
echo "      WASM built: $WASM_PATH ($(du -h "$WASM_PATH" | cut -f1))"

# ── Step 2: Create/fund identities ───────────────────────────────────────────

echo "[2/6] Ensuring testnet identities exist and are funded..."

for IDENTITY in deployer arbiter treasury; do
  if ! stellar keys address "$IDENTITY" &>/dev/null; then
    echo "      Creating identity: $IDENTITY"
    stellar keys generate "$IDENTITY" --network "$NETWORK"
  else
    echo "      Identity $IDENTITY already exists: $(stellar keys address "$IDENTITY")"
  fi
done

echo "      Funding deployer via Friendbot (may take a few seconds)..."
stellar keys fund deployer --network "$NETWORK" || echo "      (already funded or Friendbot rate-limited; continuing)"

# ── Step 3: Deploy contract ───────────────────────────────────────────────────

echo "[3/6] Deploying contract..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM_PATH" \
  --source-account deployer \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  2>&1 | grep -oE 'C[A-Z0-9]{55}' | head -1)

if [[ -z "$CONTRACT_ID" ]]; then
  echo "ERROR: contract deploy did not return a contract ID" >&2
  exit 1
fi
echo "      Contract deployed: $CONTRACT_ID"

# ── Step 4: Resolve admin / arbiter / treasury addresses ─────────────────────

echo "[4/6] Resolving identity addresses..."
ADMIN_ADDRESS=$(stellar keys address deployer)
ARBITER_ADDRESS=$(stellar keys address arbiter)
TREASURY_ADDRESS=$(stellar keys address treasury)

echo "      Admin (deployer): $ADMIN_ADDRESS"
echo "      Arbiter:          $ARBITER_ADDRESS"
echo "      Treasury:         $TREASURY_ADDRESS"

# ── Step 5: Initialise contract ───────────────────────────────────────────────

echo "[5/6] Initialising contract..."
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source-account deployer \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- initialize \
    --admin         "$ADMIN_ADDRESS" \
    --arbiter       "$ARBITER_ADDRESS" \
    --treasury      "$TREASURY_ADDRESS" \
    --fee_bps       "$FEE_BPS" \
    --max_order_amount "$MAX_ORDER_AMOUNT"

echo "      Contract initialised."

# ── Step 6: Verify ────────────────────────────────────────────────────────────

echo "[6/6] Verifying (reading back a non-existent order should return NotFound = error #1)..."
VERIFY_OUTPUT=$(stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source-account deployer \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_order --id 0 2>&1 || true)

if echo "$VERIFY_OUTPUT" | grep -q "#1"; then
  echo "      Verified: Contract returned NotFound (#1) as expected."
else
  echo "      WARNING: unexpected response from get_order: $VERIFY_OUTPUT"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Add these to your .env:"
echo ""
echo "  ESCROW_CONTRACT_ID=$CONTRACT_ID"
echo "  STELLAR_NETWORK=testnet"
echo "  STELLAR_RPC_URL=$RPC_URL"
echo "  STELLAR_NETWORK_PASSPHRASE=\"$NETWORK_PASSPHRASE\""
echo ""
echo "Deployer (admin) identity: deployer  ($ADMIN_ADDRESS)"
echo "Arbiter identity:          arbiter   ($ARBITER_ADDRESS)"
echo "Treasury identity:         treasury  ($TREASURY_ADDRESS)"
echo ""
echo "IMPORTANT: These identities are stored by the Stellar CLI (~/.config/stellar/)."
echo "For production, use hardware-backed multisig accounts — not CLI identities."
