# Code Review Results

**Scope:** `c6db6a336fc513ad78ce5eff7b40d0fcad0ea581` to the current working tree (the complete Rust Termux replacement, including intent-to-add files).

**Intent:** Atomically replace the Node `terminal-helper` with the non-root Rust `zos-termux` daemon, preserve tmux persistence and browser terminal behavior, introduce strict Termux Protocol v1, migrate runtime state safely, and prepare release `0.8.0`.

**Mode:** autofix; sequential main-thread execution required by repository instructions.

**Reviewers:** correctness, testing, maintainability, project standards, security, performance, API contract, data migrations, reliability, adversarial, CLI readiness, TypeScript, agent-native, learnings, and deployment verification.

## Findings

| # | Severity | Area | Finding | Resolution |
|---|----------|------|---------|------------|
| 1 | P1 | `apps/termux/src/server.rs` | Startup unlinked an existing active Unix listener, permitting split-brain daemons. | Probe the existing socket, reject an active owner, and replace only a connection-refused stale socket; added active/stale tests. |
| 2 | P1 | `apps/termux/src/server.rs` | Errors after PTY spawn bypassed child termination and detach bookkeeping. | Wrapped the session in an inner result and always runs lifecycle cleanup; added cleanup-state tests. |
| 3 | P1 | `apps/api/src/lib/termux-client.ts` | Output could arrive between handshake listener removal and permanent listener installation. | Pause before transferring ownership, process buffered frames after installing listeners, then resume; added immediate-output coverage. |
| 4 | P1 | `packaging/debian/postinst` | Direct upgrades moved the old terminal home while the legacy helper could still be running. | Validate directory conflicts, stop the old helper, then move the home; packaging tests enforce the order. |
| 5 | P2 | Rust and TypeScript protocol parsers | UUID and Base64 acceptance differed across implementations. | Enforced canonical hyphenated RFC UUIDs and canonical padded Base64 in both implementations with matching rejection tests. |
| 6 | P2 | `apps/termux/src/tmux.rs` | Failed option initialization could leave a partially managed tmux session. | Repair the managed marker for existing sessions and destroy newly created sessions if metadata initialization fails. |
| 7 | P2 | `packaging/scripts/zos-refresh-termux.sh` | Dynamic NAS paths were emitted into systemd directives without escaping. | Quote and escape backslashes, quotes, and systemd `%` specifiers; extended the packaging contract test. |

All findings were fixed and re-verified. No residual actionable code findings remain.

## Requirements Completeness

- [x] Native PTY, controlling terminal, resize, tmux persistence, session limits, eviction, and idle reaping.
- [x] Unix peer credentials, bounded connections and frames, timeouts, structured errors, and graceful shutdown.
- [x] Strict, versioned JSONL protocol with shared fixtures and byte-safe Base64 streaming.
- [x] Complete runtime rename and removal of `node-pty` and the Node helper fallback.
- [x] Atomic configuration/home/unit migration and Debian, appliance, CM5, and systemd integration.
- [x] Version `0.8.0`, operational documentation, focused tests, and complete repository gates.

## Agent-Native Gaps

None. Termux is an internal runtime replacement; browser and API terminal capabilities remain available through the existing terminal routes and session manager.

## Learnings And Schema

- No applicable repository solution notes exist under `docs/solutions/`.
- No database schema or data migration was introduced; schema drift is not applicable.

## Deployment Notes

- Before upgrade, stop terminal/API consumers and timers, then back up the current package, `/zos/config`, `/zos/state`, `/zos/home/terminal`, and SQLite state.
- The package must refuse an upgrade if old and new terminal homes both exist. A successful upgrade disables `zos-terminal-helper.service`, moves the old home, writes `config.toml.pre-termux.bak`, and enables `zos-termux.service`.
- Healthy signals are an active Termux/API service, no failed ZOS units, successful health/readiness endpoints, and a terminal that opens, resizes, reconnects, retains scrollback, and can be destroyed.
- Rollback to `0.7.x` requires stopping Termux, restoring the old package and config backup, and moving `/zos/home/termux` back to `/zos/home/terminal` without merging directories.

## Coverage

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run version:check` passed on the final source tree.
- Rust: 89 passed, including the real tmux/native-PTY integration test. Vitest: 645 passed and 4 skipped. Documentation: 5 passed, with Astro checks/build and internal-link validation successful.
- Focused protocol, API client, socket ownership, cleanup, migration, packaging, shell syntax, and repeated socket regression checks passed. `git diff --check` passed.
- Expected non-blocking output is limited to the pre-existing React i18next test notice, Vite large-chunk warning, and Astro empty-i18n/404 warnings.
- This macOS host does not provide `dpkg-buildpackage` or `systemd-analyze`, so a real Debian package install, systemd sandbox validation, and CM5 runtime acceptance remain Linux release gates.
- Multiple application services share the `zos` UID accepted by Termux peer validation. This matches the current single-user architecture but is not process-level authorization isolation.

---

> **Verdict:** Ready to merge; Debian/systemd and CM5 acceptance remain release gates.
>
> **Reasoning:** The complete replacement has no unresolved actionable review findings, all local quality gates pass, and the high-risk protocol, PTY, tmux, socket, migration, and packaging behaviors have focused regression coverage.
