# =============================================================
# 2FA monorepo - top-level Makefile
# =============================================================
# Conventions:
#   * Real targets only; phony targets declared explicitly.
#   * Use TABS for recipes (this file uses tabs).
#   * Per-language work lives behind clearly-named targets so
#     specialized agents can extend them without touching the
#     top-level orchestration.
# =============================================================

SHELL        := /bin/bash
.SHELLFLAGS  := -eu -o pipefail -c
.DEFAULT_GOAL := help

GO          ?= go
PNPM        ?= pnpm

GO_PKGS     := ./...
SERVER_BIN  := bin/2fa-server
SERVER_PKG  := ./cmd/server

# ----- Help (default) -----

.PHONY: help
help: ## Show available targets.
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_.-]+:.*?## / {printf "  %-22s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ----- Install / setup -----

.PHONY: install
install: install-go install-js ## Install Go modules and JS dependencies.

.PHONY: install-go
install-go: ## Download Go module dependencies.
	$(GO) mod download

.PHONY: install-js
install-js: ## Install JS workspace dependencies via pnpm.
	$(PNPM) install

# ----- Format -----

.PHONY: fmt
fmt: fmt-go fmt-js ## Format Go and JS sources.

.PHONY: fmt-go
fmt-go: ## Run `gofmt -s -w` on Go sources.
	$(GO) fmt $(GO_PKGS)

.PHONY: fmt-js
fmt-js: ## Run prettier (if configured) on JS/TS sources.
	$(PNPM) -w run format

# ----- Lint / vet -----

.PHONY: vet
vet: ## Run `go vet`.
	$(GO) vet $(GO_PKGS)

.PHONY: lint-js
lint-js: ## Lint JS/TS workspace (no-op if not configured).
	$(PNPM) -w run lint

# ----- Typecheck (TS only) -----

.PHONY: typecheck
typecheck: ## Run TypeScript type-checks across the workspace.
	$(PNPM) -w run typecheck

# ----- Build -----

.PHONY: build
build: build-go build-js ## Build server and JS packages.

.PHONY: build-go
build-go: ## Build the sync server binary into ./bin.
	mkdir -p bin
	$(GO) build -o $(SERVER_BIN) $(SERVER_PKG)

.PHONY: build-js
build-js: ## Build all JS workspace packages.
	$(PNPM) -w run build

# ----- Test -----

.PHONY: test
test: test-go test-js ## Run Go and JS tests.

.PHONY: test-go
test-go: ## Run all Go tests.
	$(GO) test $(GO_PKGS)

.PHONY: test-js
test-js: ## Run all JS workspace tests.
	$(PNPM) -w run test

# ----- Run -----

.PHONY: run-server
run-server: ## Run the sync server from source.
	$(GO) run $(SERVER_PKG)

.PHONY: dev
dev: ## Run the local dev stack (server, admin, extension preview).
	./scripts/dev.sh

# ----- Cleanup -----

.PHONY: clean
clean: ## Remove build artifacts.
	rm -rf bin dist coverage
	$(PNPM) -w -r exec rm -rf dist .turbo .cache .vite || true
