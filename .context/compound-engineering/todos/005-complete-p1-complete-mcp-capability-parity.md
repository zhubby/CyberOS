---
status: complete
priority: p1
issue_id: "005"
tags: [mcp, capabilities, agent-native, parity]
dependencies: []
---

# Complete MCP Capability Parity

## Problem Statement

The MCP catalog describes the planned NAS capability matrix, but most mutations and several read outcomes remain unavailable. Returning `NOT_READY` is honest discovery behavior, not the UI outcome parity required by the explicit refactor plan.

## Findings

- `packages/mcp/src/runtime.ts:77` lists the currently implemented built-in capabilities.
- `packages/mcp/src/runtime.ts:115` marks all other catalog entries unavailable unless the API injects a read adapter.
- `packages/capability-runtime/src/orchestrator.ts:24` supports only `zos.files.mutate-propose` with mkdir, move, copy, rename, and trash.
- Missing executable outcomes include file write/upload/tag/restore/extract/rollback, photo media and mutations, downloads, backup restore staging, alert configuration, Docker/VM/network/storage/settings/terminal mutations, and bounded shell.

## Proposed Solutions

### Option 1: Domain Adapter Rollout

Extract shared domain services in bounded batches and add one proposal/execution adapter per capability family. Keep REST and MCP as input adapters over those services.

**Pros:** Preserves architecture and safety boundaries; supports focused rollout and tests.

**Cons:** Requires coordinated changes across API routes, runtime orchestration, UI approval summaries, and domain tests.

### Option 2: Generic Legacy Approval Bridge

Project MCP runs into existing approval handlers before extracting each service.

**Pros:** Faster initial breadth.

**Cons:** Extends the giant approval branch, duplicates validation semantics, and conflicts with the target architecture.

## Recommended Action

Use Option 1. Implement Files/Media, Operations, Compute, Network/Storage, and Monitoring batches. Each batch must add strict schemas, immutable proposals, execution-time scope/revision/readiness checks, secret redaction, and end-to-end approval tests before enabling the capability.

## Technical Details

Affected components include `packages/capabilities`, `packages/capability-runtime`, `packages/mcp`, API domain services/routes, DB repositories, the worker, and approval UI.

## Acceptance Criteria

- [x] Every capability in the matrix has an executable adapter or an explicitly accepted product exclusion.
- [x] Every mutation creates a durable immutable proposal and requires first-party approval.
- [x] Approval rechecks scope, revision, readiness, paths, and runtime state and executes once.
- [x] Secrets are collected only in first-party UI and never persisted in run input/events/results.
- [x] File Git/archive, photo media, and all large outputs use bounded data or subject-bound resource links.
- [x] Shell is default-off, approval-gated, non-interactive, non-root, root-scoped, and output/time/process bounded.
- [x] Domain success, unavailable runtime, invalid input, conflict, reject, expiry, cancel, and restart recovery tests pass.

## Work Log

### 2026-10-27 - Implementation Completed

**By:** Codex

**Actions:** Implemented strict JSON Schema and shared TypeScript contracts for all 27 Pi capabilities, adapter-driven prepare/revalidate/execute behavior, durable approval recovery and idempotency, local-only secret supplementation, client-bound single-use resource tokens, bounded file/archive/Git and Shell reads, all requested domain mutation bridges, Shell scope repair, and the approval UI. Added focused runtime, schema, resource, file-safety, scope, queue, secret, and browser regressions.

**Verification:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `git diff --check` pass. The full Vitest run reports 1119 passed and 5 skipped tests. Headless browser checks passed at 320, 390, 560, 820, and 1440px in light and dark themes; approval submission completed through the real API, restored focus on Escape, produced no browser errors, and left no secret in DOM or capability persistence.

**Learnings:** A shared adapter lifecycle allows REST compatibility without weakening approval invariants. Secret-bearing actions need a distinct non-replayable transition from pending to running, while non-secret actions can safely use the durable startup-recovered queue.

---

### 2026-10-27 - Full Implementation Started

**By:** Codex

**Actions:** Confirmed the approved scope as the existing 26 unavailable catalog capabilities plus `zos.shell.run`; started the domain-adapter, strict-schema, durable-approval, resource-token, secret-supplementation, and approval-UI implementation on `codex/pi-mcp-capabilities`.

**Learnings:** Existing capability runs already provide most lifecycle and revision primitives, but catalog schema registration and execution routing still need to become adapter-driven before domain implementations can be enabled safely.

---

### 2026-10-20 - Review Discovery

**By:** Codex

**Actions:** Confirmed the secure MCP foundation and file mutation path; enumerated unavailable catalog descriptors and grouped the remaining work by domain.

**Learnings:** Catalog presence must not be treated as execution parity; domain service extraction is the controlling dependency.
