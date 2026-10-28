SHELL := /bin/sh
NPM ?= npm

.DEFAULT_GOAL := help

.PHONY: help install dev dev-api dev-web dev-worker dev-indexer dev-ops docs-dev docs-check docs-test docs-build docs-browser index health maintenance preview-web start-api start-worker start-indexer protocol-check typecheck lint test build check ci clean deb

help: ## Show available targets.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage:\n  make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_.-]+:.*##/ { printf "  %-18s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install workspace dependencies.
	$(NPM) install
	$(NPM) --prefix docs ci

dev: ## Run the API, worker, and web development servers.
	$(NPM) run dev

dev-api: ## Run the API development server.
	$(NPM) run dev -w @cyberos/api

dev-web: ## Run the web development server.
	$(NPM) run dev -w @cyberos/web

dev-worker: ## Run the worker development process.
	$(NPM) run dev -w @cyberos/worker

dev-indexer: ## Run the indexer in watch mode.
	cargo run -p cyberos-indexer

dev-ops: ## Run an Ops task (TASK=health|maintenance).
	$(NPM) run dev -w @cyberos/ops -- $(TASK)

docs-dev: ## Run the Starlight development server.
	$(NPM) run docs:dev

docs-check: ## Check Starlight content and configuration.
	$(NPM) run docs:check

docs-test: ## Run documentation metadata tests.
	$(NPM) run docs:test

docs-build: ## Build the Starlight site.
	$(NPM) run docs:build

docs-browser: ## Run documentation browser smoke tests.
	$(NPM) run docs:browser

index: ## Run one indexing pass.
	$(NPM) run index

health: ## Run the health evaluator once.
	$(NPM) run health

maintenance: ## Run maintenance once.
	$(NPM) run maintenance

preview-web: ## Preview the built web app.
	$(NPM) run preview -w @cyberos/web

start-api: ## Start the built API server.
	$(NPM) run start -w @cyberos/api

start-worker: ## Start the built worker process.
	$(NPM) run start -w @cyberos/worker

start-indexer: ## Start the built indexer process.
	target/release/cyberos-indexer

protocol-check: ## Verify checked-in Rust-to-TypeScript protocol bindings.
	$(NPM) run protocol:check

typecheck: ## Run TypeScript checks.
	$(NPM) run typecheck

lint: ## Run ESLint.
	$(NPM) run lint

test: ## Run the test suite.
	$(NPM) test

build: ## Build all workspaces.
	$(NPM) run build

check: protocol-check typecheck lint test ## Run protocol drift, typecheck, lint, and tests.

ci: check build ## Run the full local verification suite.

clean: ## Remove generated build and packaging artifacts.
	rm -rf packages/*/dist coverage target .cyberos/deb-build

deb: ## Build the Debian package artifacts.
	./packaging/scripts/build-deb.sh
