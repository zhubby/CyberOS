---
status: ready
priority: p1
issue_id: "010"
tags: [agent, worker, reliability, concurrency]
dependencies: []
---

# Isolate Concurrent Agent Turns Per Session

## Problem Statement

Multiple ZOS workers, or overlapping worker ticks, can claim different jobs for the same ZOS session. Those turns can open and append to the same Pi JSONL session concurrently, making provider context and failure recovery order-dependent.

## Findings

- `packages/worker/src/index.ts` permits overlapping polling ticks.
- Nix deployments support multiple worker instances.
- `claimNextJob` claims globally queued jobs without a same-session ownership lease.
- Pi continuation turns reopen one provider session file, which is not an isolated concurrent workspace.
- Blocking claims solely on `running` status is unsafe because a crashed worker can leave a stale job that permanently blocks the session.

## Proposed Solutions

### Option 1: Durable Per-Session Lease

Add worker ownership, lease expiry, and heartbeat fields for active agent work. Claim queued jobs only when the session lease is absent or expired, and recover interrupted jobs before transferring ownership.

**Pros:** Works across processes and preserves ordered provider context.

**Cons:** Requires migration, heartbeat, recovery, and operational tests.

**Risk:** Medium.

### Option 2: Isolated Provider Branch Per Turn

Fork the Pi append-only session tree for each concurrent turn and use an explicit compare-and-swap policy to select the surviving branch.

**Pros:** Allows concurrent model work without sharing a writable JSONL file.

**Cons:** Requires branch reconciliation and a clear user-visible ordering contract.

**Risk:** High.

## Recommended Action

Implement a durable per-session lease with worker ownership and heartbeat. Expired owners must be recovered before another turn is claimed, and waiting-approval continuations must retain ownership without blocking forever.

## Technical Details

**Affected files:**
- `packages/db/src/repositories/jobs.ts`
- `packages/db/src/migrations/production.ts`
- `packages/worker/src/index.ts`
- `packages/worker/src/processor.ts`
- repository and multi-connection worker tests

**Database changes:**
- Add durable worker ownership and lease expiry, either to `jobs` or a dedicated per-session lease table.

## Acceptance Criteria

- [ ] Two workers cannot run Agent jobs for the same ZOS session concurrently.
- [ ] Jobs for different sessions remain concurrently claimable.
- [ ] A crashed worker's lease expires and the session recovers without manual database edits.
- [ ] Waiting-approval continuations retain ordered ownership and recover after expiry/cancellation.
- [ ] A failed turn cannot delete or restore provider context owned by a different live turn.
- [ ] Multi-connection tests cover claim, heartbeat, expiry, recovery, and completion ordering.

## Work Log

### 2026-10-22 - Review Discovery

**By:** Codex

**Actions:**
- Reproduced the same-session claim race in code review.
- Rejected status-only serialization because stale `running` jobs have no recovery lease.
- Kept the CM5 provider-error hotfix scoped to the single-worker deployment.

**Learnings:**
- Provider-session cleanup and provider-file ownership must use the same concurrency contract.
- A queue serialization rule is incomplete without crash recovery.
