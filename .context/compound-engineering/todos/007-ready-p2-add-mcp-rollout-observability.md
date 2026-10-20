---
status: ready
priority: p2
issue_id: "007"
tags: [mcp, observability, parity, rollout]
dependencies: ["005"]
---

# Add MCP Rollout Observability and Bidirectional Parity

## Problem Statement

The implementation has request logs and a manifest existence check, but lacks capability metrics, REST/MCP shadow comparison, and a CI rule proving that every actionable UI/REST outcome is represented.

## Findings

- `packages/capabilities/src/parity-routes.test.ts:10` validates only manifest-to-route existence.
- `packages/mcp/src/server.ts:87` has limits and error logging but no OpenTelemetry capability dimensions.
- No shadow comparator records REST/MCP result drift for read capabilities.

## Proposed Solutions

### Option 1: Generated Outcome Inventory

Add explicit route/UI action metadata and compare it bidirectionally with the capability manifest in CI. Instrument runtime invocation and run transitions with bounded labels.

**Pros:** Deterministic CI and useful rollout evidence.

**Cons:** Requires maintaining action metadata near route/UI definitions.

### Option 2: Source Heuristics Only

Expand AST scanning to classify every mutating route automatically.

**Pros:** Less manual metadata.

**Cons:** Cannot reliably infer UI outcomes, shared routes, or intentional exclusions.

## Recommended Action

Use explicit outcome metadata with a small AST check for stale route references. Add OpenTelemetry counters/histograms for capability, client kind, duration, stable error code, approval wait, and cancellation without paths, commands, or client names.

## Acceptance Criteria

- [ ] CI fails when an actionable UI/REST outcome lacks a capability mapping or documented exclusion.
- [ ] CI fails for duplicate capability IDs, duplicate route ownership, approve tools, or stale route mappings.
- [ ] Read-only shadow comparison detects shape/value drift without exposing secrets or paths.
- [ ] Metrics cover invocation duration, error code, approval wait, cancellation, and runtime availability.
- [ ] Rollout flags gate Pi reads, Pi mutations, and external LAN independently; mutations are never double-written.
- [ ] Operational docs define dashboards, rollback signals, and log redaction checks.

## Work Log

### 2026-10-20 - Review Discovery

**By:** Codex

**Actions:** Verified current parity and handler instrumentation and identified the missing reverse mapping and telemetry layers.

**Learnings:** Route existence is necessary but insufficient to prove agent-native outcome parity.
