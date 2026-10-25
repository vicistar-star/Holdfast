.PHONY: setup dev build test lint typecheck \
        contract-test contract-build contract-clippy \
        db-migrate docker-up docker-down clean help

# ── Setup ─────────────────────────────────────────────────────────────────────

## Install all dependencies and copy .env.example → .env if not present
setup:
	@command -v pnpm >/dev/null 2>&1 || (echo "pnpm not found. Install: npm i -g pnpm" && exit 1)
	@command -v cargo >/dev/null 2>&1 || (echo "cargo not found. Install Rust via rustup.rs" && exit 1)
	@command -v stellar >/dev/null 2>&1 || (echo "stellar CLI not found. See https://developers.stellar.org/docs/tools/cli" && exit 1)
	@[ -f .env ] || (cp .env.example .env && echo "Created .env from .env.example — fill in real values before running.")
	pnpm install
	rustup target add wasm32v1-none 2>/dev/null || rustup target add wasm32-unknown-unknown
	@echo "✓ setup complete"

# ── Development ───────────────────────────────────────────────────────────────

## Start Postgres and Redis, then run all apps in watch mode
dev: docker-up
	pnpm dev

## Start local infrastructure (Postgres + Redis) in the background
docker-up:
	docker compose -f infra/docker-compose.yml up -d

## Stop local infrastructure
docker-down:
	docker compose -f infra/docker-compose.yml down

# ── Build ─────────────────────────────────────────────────────────────────────

## Build all TypeScript packages and apps
build:
	pnpm build

## Build the Soroban contract WASM
contract-build:
	pnpm contract:build

# ── Test ──────────────────────────────────────────────────────────────────────

## Run all tests (contract + TypeScript)
test: contract-test
	pnpm test

## Run Rust contract tests
contract-test:
	pnpm contract:test

# ── Lint / type-check ─────────────────────────────────────────────────────────

## Run ESLint across all TypeScript packages
lint:
	pnpm lint

## Run TypeScript type-checker across all packages
typecheck:
	pnpm typecheck

## Run cargo clippy (Rust linter)
contract-clippy:
	pnpm contract:clippy

# ── Database ──────────────────────────────────────────────────────────────────

## Run pending database migrations
db-migrate:
	pnpm db:migrate

# ── Clean ─────────────────────────────────────────────────────────────────────

## Remove all build artefacts
clean:
	pnpm --recursive exec rm -rf dist .next out 2>/dev/null || true
	cargo clean --manifest-path contracts/escrow/Cargo.toml

# ── Help ──────────────────────────────────────────────────────────────────────

## Show this help message
help:
	@echo ""
	@echo "Holdfast — available make targets:"
	@echo ""
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/## /  /'
	@echo ""
