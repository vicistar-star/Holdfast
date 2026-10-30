#!/usr/bin/env bash
set -euo pipefail

echo "===================================================="
echo "🔍 Running Holdfast Pre-Commit Verification"
echo "===================================================="

# 1. Secret Scanning
echo "→ Checking for committed secrets and private keys..."
SECRET_PATTERNS=(
  "BEGIN (RSA|EC|DSA|OPENSSH|PRIVATE) KEY"
  "AKIA[0-9A-Z]{16}"
  "S[A-Z0-9]{55}" # Stellar secret seed
  "ghp_[A-Za-z0-9_]{36}"
)

# Search staged and working tree git-tracked files (excluding .env.example, scripts/pre-commit.sh, and test mock files)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM || true)
if [ -n "$STAGED_FILES" ]; then
  for pattern in "${SECRET_PATTERNS[@]}"; do
    if echo "$STAGED_FILES" | xargs grep -E -I -n "$pattern" 2>/dev/null | grep -v -E "(\.env\.example|pre-commit\.sh|test\.ts)" ; then
      echo "❌ SECURITY ALERT: Potential secret or private key detected in staged files matching pattern '$pattern'!"
      echo "Please remove the secret before committing."
      exit 1
    fi
  done
fi
echo "✓ Secret scan clean"

# 2. Rust Contract Formatting Check
if [ -d "contracts/escrow" ]; then
  echo "→ Checking contract formatting (cargo fmt)..."
  cargo fmt --manifest-path contracts/escrow/Cargo.toml --all -- --check
  echo "✓ Contract formatting clean"
fi

# 3. TypeScript Lint
echo "→ Running TypeScript lint..."
pnpm lint
echo "✓ ESLint clean"

# 4. TypeScript Typecheck
echo "→ Running TypeScript typecheck..."
pnpm typecheck
echo "✓ Typecheck clean"

echo "===================================================="
echo "✅ All Pre-Commit Checks Passed Successfully"
echo "===================================================="
