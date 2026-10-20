---
status: ready
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

- [ ] Every capability in the matrix has an executable adapter or an explicitly accepted product exclusion.
- [ ] Every mutation creates a durable immutable proposal and requires first-party approval.
- [ ] Approval rechecks scope, revision, readiness, paths, and runtime state and executes once.
- [ ] Secrets are collected only in first-party UI and never persisted in run input/events/results.
- [ ] File Git/archive, photo media, and all large outputs use bounded data or subject-bound resource links.
- [ ] Shell is default-off, approval-gated, non-interactive, non-root, root-scoped, and output/time/process bounded.
- [ ] Domain success, unavailable runtime, invalid input, conflict, reject, expiry, cancel, and restart recovery tests pass.

## Work Log

### 2026-10-20 - Review Discovery

**By:** Codex

**Actions:** Confirmed the secure MCP foundation and file mutation path; enumerated unavailable catalog descriptors and grouped the remaining work by domain.

**Learnings:** Catalog presence must not be treated as execution parity; domain service extraction is the controlling dependency.
