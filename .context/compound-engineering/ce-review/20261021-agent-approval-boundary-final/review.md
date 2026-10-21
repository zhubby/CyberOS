# Agent Approval Boundary Final Review

- Mode: autofix
- Scope: the Agent, capability runtime, API, database, MCP, worker, Web, and documentation changes in the current working tree on `main`
- Intent: ensure only Pi capability requests made during Agent conversations can create approvals, while every Workspace panel operation executes outside the approval state machine
- Verdict: ready after verification; no unresolved P0-P3 findings remain

## Findings

No unresolved P0-P3 findings remain after the autofix and verification passes.

## Resolved Findings

- Pi MCP file resource links are now hidden unless Agent read policy is `auto`, closing a bypass around `approve`, `confirm`, and `disabled` read policies.
- Agent continuation now waits for every linked capability run and returns the complete terminal result set instead of dropping all but the last approval outcome.
- Capability runs that fail an execution precondition delete their private payload after transitioning to a terminal state.
- Secret redaction in shell approval previews preserves command separators, so a URL or secret assignment cannot hide later commands from the reviewer.
- Agent cancellation expires every linked pending capability approval, cancels its run, and deletes private payloads.
- Approved capability execution failures return an error response instead of a false success notification.

## Approval Boundary

- Production approval creation has exactly three entry points in `@zos/capability-runtime`: Pi SDK tools, Pi MCP file reads that require approval, and Pi MCP file mutation proposals.
- `createCapabilityProposal` rejects non-Pi subjects at runtime, and pending approvals are visible only when linked to a waiting Agent job.
- Workspace file, photo, Docker, VM, share, storage, and operations routes create direct domain operations with no approval state.
- Legacy approval constructors remain only as internal migration and compatibility code and are no longer exported by the public `@zos/db` barrel.

## Verification

- Passed: focused Agent/capability/MCP/worker/database tests, 61 tests.
- Passed: `npm run typecheck` and Astro documentation checks.
- Passed: `npm run lint`, including Rust formatting, Clippy with warnings denied, and ESLint.
- Passed: `npm test`: Rust workspace, 172 Vitest files with 1096 passed and 5 skipped, and documentation tests.
- Passed: `npm run build`: release Rust workspace, API, Web, worker, and documentation build/link validation.
- Passed: `git diff --check`.

## Residual Environment Risk

- A live provider-driven Pi turn was not exercised because it requires configured model credentials and a paired Pi MCP token; runtime behavior is covered by focused integration tests.
- The approval card was verified by component rendering and the production Web build, but not through a seeded interactive browser session.

## Review Accounting

- Suppressed findings: 0.
- Failed reviewers: 0; repository instructions required the review to run sequentially in the main thread.
