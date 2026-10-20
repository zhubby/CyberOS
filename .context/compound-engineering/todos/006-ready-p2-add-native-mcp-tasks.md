---
status: ready
priority: p2
issue_id: "006"
tags: [mcp, tasks, protocol, runs]
dependencies: []
---

# Add Native MCP Tasks Projection

## Problem Statement

Durable capability runs are exposed through `zos.runs.*`, but modern clients do not receive the native MCP Tasks projection required by the explicit plan.

## Findings

- `docs/src/content/docs/reference/mcp-agent-capabilities.md:103` records that `@modelcontextprotocol/server` 2.3.1 has wire types but no server Tasks runtime.
- The durable run model already has the states, ownership, cancellation, progress, and terminal result needed for a Tasks projection.

## Proposed Solutions

### Option 1: Upgrade to Official Server Tasks Support

Adopt the first compatible official SDK release with stable server Tasks support and map it to capability runs.

**Pros:** Standards-aligned and maintainable.

**Cons:** Depends on an upstream release and requires conformance retesting.

### Option 2: Implement a Local Protocol Adapter

Build the Tasks JSON-RPC methods directly over the existing MCP transport.

**Pros:** Removes the upstream dependency.

**Cons:** Higher protocol and compatibility risk; duplicates SDK responsibility.

## Recommended Action

Prefer Option 1. Keep `zos.runs.*` as the legacy fallback and make both projections use the same ownership and transition functions.

## Acceptance Criteria

- [ ] Modern protocol negotiation advertises Tasks only when fully supported.
- [ ] Task get/list/cancel and progress map to the same durable capability run.
- [ ] Ownership and scope rules are identical to `zos.runs.*`.
- [ ] Pi-era clients continue to use the legacy run tools.
- [ ] 2026 and 2025-era conformance tests pass without long-held mutation requests.

## Work Log

### 2026-10-20 - Review Discovery

**By:** Codex

**Actions:** Verified the fallback projection and the SDK limitation documented by the implementation.

**Learnings:** The database model is ready; the missing layer is protocol projection and conformance coverage.
