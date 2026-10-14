## Code Review Results

**Scope:** `v0.9.20` / `origin/main` at `79480be` to the tracked working tree.
**Intent:** Stop the Rust Indexer watcher from feeding file-read access events back into
the queue, and make CM5 deployment fail when the Indexer service, heartbeat, watcher,
or queue health has not recovered.
**Mode:** interactive, sequential main-thread personas per project instructions.

**Reviewers:** correctness, testing, maintainability, project-standards, agent-native,
learnings, performance, reliability, adversarial, CLI-readiness.

- Performance: watcher feedback loops, blocking scan accumulation, and queue progress.
- Reliability: systemd enablement, bounded readiness waits, diagnostics, and unhealthy rollout failure.
- Adversarial: production deployment behavior and the observed CM5 resource exhaustion path.
- CLI-readiness: POSIX shell control flow, error exits, and diagnostic output.

### Applied Fixes

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 1 | `apps/indexer/src/watcher.rs:120` | Test did not name the concrete open/close access events seen through notify | testing | 0.91 | `safe_auto -> review-fixer` |

- Added explicit coverage for access open, read close, write close, and access-time metadata.
- Retained positive coverage for create, modify, and remove events.
- No unresolved actionable code findings remain.

### Learnings & Past Solutions

- No `docs/solutions/` directory exists in this checkout.
- Linux notify emits file opens as `Access(Open(...))`; content writes also emit a separate
  data-modification event, so filtering access-only events preserves real change detection.

### Agent-Native Gaps

- None. The change is internal watcher and deployment health behavior; existing status APIs
  expose every new deployment gate to UI and programmatic clients.

### Deployment Notes

- Confirm `zos-indexer.service` is enabled and active after package installation.
- Require fresh heartbeat, watcher `ready`, and queue `stalled=false` before accepting rollout.
- Continue monitoring until the inherited queue drains; an immediate ready response alone does
  not prove the former self-triggering scan loop is gone.
- Verify CPU and thread counts remain stable while file browsing and search read indexed files.

### Coverage

- Suppressed findings: 0; failed reviewers: 0 (sequential main-thread review).
- Full Node 22 `make ci` passed after refreshing lockfile dependencies.
- Targeted checks passed: 25 Indexer tests, 10 packaging tests, Rust formatting, shell syntax.
- One unrelated VOD timeout test was timing-sensitive during the first full run; its focused rerun
  and the second complete CI run passed without code changes.
- Residual risk: macOS cannot reproduce Linux inotify delivery exactly; CM5 deployment and browser
  acceptance are required before declaring the production incident resolved.

---

> **Verdict:** Ready to merge and deploy with CM5 verification.
>
> **Reasoning:** The access-event feedback path is filtered without suppressing create, data
> modification, metadata modification, rename, or remove events. Deployment now checks the
> Indexer as a required service and rejects an unhealthy watcher or stalled queue.
