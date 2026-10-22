# Code Review: Agent Provider Error Recovery

## Scope

- `packages/agent/src/pi-agent.ts`
- `packages/agent/src/pi-agent.test.ts`
- `packages/db/src/repositories/sessions.ts`
- `packages/worker/src/processor.ts`
- `packages/worker/src/processor.test.ts`

Intent: surface Pi provider failures instead of completing with an empty response, and stop reusing provider context after a rejected turn.

Mode: `autofix`

Reviewers: correctness, testing, maintainability, project-standards, reliability, adversarial, kieran-typescript, agent-native, learnings.

## Applied Fixes

- Detect `stopReason: "error"`, preserve the provider error message, and reject empty terminal responses.
- Emit the existing failed-turn path instead of `agent.completed` for provider errors.
- Clear a provider-session mapping only when the failing turn saved that provider session.
- Re-save the provider mapping after a successful terminal response so a later successful turn can recover after a prior failure.
- Preserve unrelated or newer mappings when their provider session ID differs.
- Added SDK message mapping, empty response, returned failure, thrown failure, pre-save failure, newer mapping, and recovery tests.

## Residual Actionable Work

| Severity | File | Issue | Route |
|---|---|---|---|
| P1 | `packages/worker/src/index.ts` | Multiple workers can process the same ZOS session concurrently and append to one Pi JSONL session without a durable lease or isolation boundary. | `manual -> downstream-resolver` |

Tracked in `.context/compound-engineering/todos/010-ready-p1-agent-session-concurrency.md`.

## Advisory Outputs

- Clearing rejected provider context intentionally resets model-side history. The ZOS transcript remains visible, so a terse follow-up may require the user to restate context.
- Rejected Pi JSONL files remain on disk after their database association is removed and need a separate retention policy.
- `docs/solutions/` is absent, so no institutional learning matched this change.
- No project-standards violations or new agent action-parity gaps were found.

## Verification

- Full Vitest: 169 files passed, 1073 tests passed, 5 skipped.
- Focused TypeScript: passed.
- Focused ESLint: passed.
- `git diff --check`: passed.
- Repository `make check`: TypeScript and lint passed; the Rust test phase is blocked by the unrelated uncommitted `crates/tv-gamepad` test `wtype_failure_recovers_on_the_next_successful_injection`.

## Verdict

Ready with fixes for the single-worker CM5 deployment. Multi-worker same-session isolation remains tracked as P1 follow-up work.
