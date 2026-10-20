# ZOS MCP / Agent Refactor Review

- Mode: autofix
- Scope: current dirty working tree on `main`, including untracked MCP packages and CLI files
- Intent: implement the user-provided comprehensive MCP / Agent refactor plan
- Verdict: Not ready against the explicit plan; the secure MCP foundation is implemented, but full capability parity is not

## Findings

### P1 -- High

| # | File | Issue | Reviewer(s) | Confidence | Route |
|---|---|---|---|---:|---|
| 1 | `packages/mcp/src/runtime.ts:77` | Most catalogued mutations and several read outcomes have no execution adapter and return `NOT_READY`; the runtime orchestrator only executes five file mutations. | correctness, agent-native, API contract | 1.00 | manual -> downstream-resolver |
| 2 | `packages/capabilities/src/parity-routes.test.ts:10` | Parity CI proves only that routes claimed by the manifest exist; it does not prove every actionable REST/UI outcome is represented or executable through MCP. | testing, agent-native | 0.99 | manual -> downstream-resolver |

### P2 -- Moderate

| # | File | Issue | Reviewer(s) | Confidence | Route |
|---|---|---|---|---:|---|
| 3 | `docs/src/content/docs/reference/mcp-agent-capabilities.md:103` | Modern MCP Tasks are not projected because SDK 2.3.1 lacks server runtime support; only durable `zos.runs.*` fallback tools are available. | API contract, reliability | 1.00 | manual -> downstream-resolver |
| 4 | `packages/mcp/src/server.ts:87` | OpenTelemetry capability metrics and the planned REST/MCP shadow comparison and rollout gates are not implemented. | reliability, deployment | 0.98 | manual -> downstream-resolver |

## Requirements Completeness

- Partially met: capability contracts, scoped catalog, stable errors, output limits, resources, prompts, and parity manifest.
- Partially met: durable runs, approval linkage, idempotency, revision checks, cancellation, revocation, and recovery. Lease-based claiming is not implemented for general runs.
- Partially met: shared read adapters and file mutation service extraction. Most mutating domains still use REST-only orchestration.
- Partially met: Streamable HTTP, protocol negotiation, auth, scope filtering, bounded transfer links, Host/Origin checks, and per-client limits. Native Tasks and complete matrix execution are missing.
- Met for the implemented surface: Pi MCP pairing, continuation persistence, legacy fallback flag, and event/input redaction.
- Met: root-only client CLI, token digest lifecycle, private/custom TLS, HTTPS-only LAN listener, and packaging.
- Partially met: feature flags and operational documentation exist; shadow comparison, OpenTelemetry, and complete parity rollout do not.

## Applied Fixes

- Made run pagination lossless for equal timestamps.
- Redacted Pi commands, mutation bodies, secret-like fields, URLs, and durable tool events.
- Added Pi credential-install rollback after client creation failure.
- Replaced string parity checks with TypeScript AST route extraction.
- Made terminal run transitions non-cancellable.
- Made approval/run decisions atomic and added state-drift coverage.
- Added true per-client MCP rate limiting while preserving IP-level protection.
- Enforced NAS mount readiness for MCP reads and preserved `NOT_READY` errors.
- Redacted download credentials and persisted host paths from MCP output.
- Added IPv4 SAN generation and cross-platform certificate identity validation.
- Added Host, Origin, external enablement, HTTPS, token ownership, and secret-output regression coverage.

## Residual Actionable Work

- `.context/compound-engineering/todos/005-ready-p1-complete-mcp-capability-parity.md`
- `.context/compound-engineering/todos/006-ready-p2-add-native-mcp-tasks.md`
- `.context/compound-engineering/todos/007-ready-p2-add-mcp-rollout-observability.md`

## Agent-Native Gaps

- Catalog discovery is agent-native, but unavailable descriptors are not outcome parity.
- Shell remains correctly disabled but has no bounded execution adapter.
- Photo/media links, archive inspection, file Git inspection, and most mutation outcomes remain unavailable.

## Schema Drift Check

- Migrations 034 and 035 create only MCP run/client/approval/event/transfer state. Schema and migration tests pass; no unrelated drift was identified.

## Deployment Notes

- Keep `mcp.external_enabled` off until TLS initialization and at least one LAN client exist.
- Verify API remains loopback-bound and the normal HTTP Nginx listener returns 404 for `/mcp` and `/mcp-transfer/`.
- Back up SQLite before package upgrade; migrations have no reverse migration.
- After installation, verify token file and TLS key permissions, Nginx config, API/worker restart, client revocation, and approval recovery.

## Coverage

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: passed after one isolated flaky VOD timeout; 156 Vitest files, 1033 passed, 5 skipped, plus Rust and docs tests.
- `npm run build`: passed.
- `npm run docs:browser`: 2 passed.
- Isolated IPv4 private-CA and provided-certificate CLI smoke: passed.
- Remaining deployment gap: no Debian amd64/arm64 package installation was performed in this local review.
