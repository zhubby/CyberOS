## Code Review Results

**Scope:** base `5613c2a620b0736e5da0400f330ab82d4f18ffe8` to the tracked working tree on `codex/pi-host-stability`.
**Intent:** Stabilize the in-process Pi host with per-session serialization, durable leases and commands, recoverable JSONL projection, runtime generations, root-scoped execution, and reconnectable streaming UI state.
**Mode:** autofix, sequential main-thread review per repository tool mapping. No reviewer subagents.

**Reviewers:** correctness, testing, maintainability, project-standards, agent-native, learnings, security, performance, api-contract, data-migrations, reliability, adversarial, kieran-typescript, julik-frontend-races.

- Security: NAS-root path confinement, restricted shell capability, approval revalidation, resource trust policy, and secret-safe public payloads.
- API contract: durable command endpoints, SSE hydration/replay, event envelopes, idempotency, and additive response fields.
- Data migrations: migration 043 lease, command, projection, and runtime-generation schema changes.
- Reliability: lease loss, process interruption, conservative recovery, actor ownership, JSONL reuse, and graceful shutdown.
- Performance: worker concurrency, actor eviction, runtime caching, event projection, and queue access patterns.
- TypeScript: strict shared contracts across DB, agent, worker, API, and Web consumers.
- Frontend races: delta merging, reload hydration, active-run controls, and SSE reconnect behavior.

### Applied Fixes

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 1 | `packages/agent/src/pi-agent.ts:481` | Idle Pi commands could finish after losing their durable command lease | correctness, reliability | 0.98 | `safe_auto -> review-fixer` |
| 2 | `packages/db/src/repositories/jobs.ts:81` | Prompt idempotency lookup was outside the creation transaction | correctness, data-migrations | 0.99 | `safe_auto -> review-fixer` |
| 3 | `packages/agent/src/model-runtime-manager.ts:114` | Runtime generation cache could alias legacy sessions with different provider settings | correctness, maintainability | 0.97 | `safe_auto -> review-fixer` |

- Idle commands now monitor lease cancellation, abort long-running compaction, and check cancellation before execution and completion.
- Prompt idempotency lookup and message, transcript, job, and command creation now share one immediate transaction.
- Runtime cache identity now includes generation, provider, base URL, and model.
- Regression coverage was added in worker processor, DB repository, and model runtime manager tests.
- Focused verification passed: 57 tests. Full verification passed: typecheck, lint, 181 Vitest files with 1,155 passed and 5 skipped, Rust workspace tests, docs tests, production build, and version check `1.7.1`.
- No residual actionable code findings remain.

### Requirements Completeness

- Met: one active Pi writer per session with cross-session worker concurrency and actor reuse/eviction.
- Met: durable job and command leases, heartbeat, graceful shutdown, and conservative interruption recovery.
- Met: Pi JSONL ownership with idempotent SQLite event/transcript projection and reconciliation cursor.
- Met: persistent runtime generations and explicit model/thinking-level command semantics.
- Met: atomic current-path snapshotting with NAS-root validation and relative public paths.
- Met: legacy Pi bash removal; shell access is available only through the restricted `zos.shell.run` capability.
- Met: versioned streaming event envelopes, SSE replay/hydration, delta reduction, and durable session commands.
- Met: trust-gated Pi resources, exact Pi version pin, compatibility contract tests, and compatibility documentation.

### Learnings & Past Solutions

- No applicable `docs/solutions/` records exist for this change.
- Pi JSONL remains the conversation truth source; SQLite state is scheduling metadata and a rebuildable query projection.

### Agent-Native Gaps

- None found. Prompt, steer, follow-up, abort, compact, model, thinking, and stats operations are exposed through durable APIs rather than UI-only actions.

### Schema Drift Check

- Clean: migration 043, row types, mappers, repositories, and schema tests are aligned. No unrelated schema objects changed.

### Deployment Notes

- Pre-deploy: back up SQLite, Pi JSONL, configuration, and state together. A database-only rollback cannot restore a matching Pi conversation state.
- Verify stale leases: `SELECT COUNT(*) FROM jobs WHERE status = 'running' AND lease_until <= datetime('now');`
- Verify interruptions: `SELECT error_code, COUNT(*) FROM jobs WHERE error_code = 'WORKER_INTERRUPTED' GROUP BY error_code;`
- Verify projection identity: `SELECT session_id, source, source_id, COUNT(*) FROM agent_events WHERE source_id IS NOT NULL GROUP BY session_id, source, source_id HAVING COUNT(*) > 1;`
- Verify queue state: `SELECT status, COUNT(*) FROM jobs GROUP BY status;` and `SELECT status, COUNT(*) FROM agent_session_commands GROUP BY status;`
- Verify runtime binding: `SELECT runtime_generation, runtime_provider, runtime_model, COUNT(*) FROM agent_provider_sessions GROUP BY runtime_generation, runtime_provider, runtime_model;`
- Verify projection bootstrap: `SELECT COUNT(*) FROM agent_provider_sessions WHERE projection_cursor IS NULL;`
- Monitor stale leases, interrupted jobs, duplicate projection identities, projection lag, actor count, queue age, and approval continuation failures before widening rollout.

### Coverage

- Suppressed findings: 0; failed reviewers: 0 (review lenses ran sequentially in the main thread).
- Residual risks: browser acceptance and real appliance interruption behavior still require runtime validation; migration 043 has no reverse migration.
- Testing gaps: no browser run was executed until the required headed/headless mode is selected.
- `git diff --check` passed. No commit or push was performed.

---

> **Verdict:** Ready with fixes, pending browser acceptance.
>
> **Reasoning:** All three code findings were fixed and the complete automated gate passed. The remaining work is runtime UI verification and deployment monitoring, not an unresolved code finding.
