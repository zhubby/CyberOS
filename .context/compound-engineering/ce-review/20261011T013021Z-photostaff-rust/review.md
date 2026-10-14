# CE Review: Rust Photostaff Replacement

- Run ID: `20261011T013021Z-photostaff-rust`
- Mode: `autofix`
- Base: `70cfb51e52eb103ce9bd9b8cbbd13484f98371d6`
- Branch: `codex/photostaff-rust`
- Intent source: explicit implementation plan in the task conversation
- Verdict: pass after autofix; no unresolved P0-P2 findings

## Coverage

Reviewed the Node worker removal and the Rust daemon, database migration, public API and shared contracts, UI, health reporting, systemd unit, Debian packaging, appliance manifests, docs, and tests. The review used correctness, reliability, security, performance, API-contract, data-migration, testing, maintainability, project-standards, agent-accessibility, TypeScript, adversarial, and deployment lenses sequentially in the main thread.

The new files were untracked during the formal Git diff scope. They were included through direct file inspection and targeted/full test execution; they were not omitted from the implementation review.

## Applied Findings

| ID | Severity | Autofix class | Finding | Resolution | Verification |
|---|---|---|---|---|---|
| PS-001 | P1 | safe_auto | Cache cleanup could race another process generating unjournaled temporary files. | Added a cross-process shared/exclusive cache lock and held it across generation, publication, recovery, and cleanup. | Two lock-contention tests plus Rust suite. |
| PS-002 | P1 | safe_auto | Lease loss or shutdown could leave media tools and the lease-renewal task running past job cancellation. | Added cancellation fencing, process-group guards, TERM/KILL escalation, and cleanup inside `run_job` before return. | Command timeout/descendant tests, lease fencing tests, Clippy. |
| PS-003 | P1 | safe_auto | A stale worker could mutate scan, reservation, journal, or asset state after another worker reclaimed the job. | Fenced all state-changing operations with the current, unexpired job lease and made retry/recovery transactions atomic. | Multi-worker reservation and journal recovery race tests. |
| PS-004 | P1 | safe_auto | Source identity checks only covered the open descriptor and missed rename-replacement of the pathname. | Reopened source and sidecar through the storage-pool dirfd before and after publication and compared full identity. | Path replacement regression test. |
| PS-005 | P2 | safe_auto | Large hashing, cache scans, publication, and fsync operations could block Tokio worker threads and delay heartbeats. | Moved hashing and cache filesystem work to blocking workers; cache locks move with publication so cancellation cannot expose an unlocked background write. | 35 Rust tests and Clippy with warnings denied. |
| PS-006 | P1 | safe_auto | Space reservation covered one intermediate output although decode scratch, thumbnail, and preview can coexist. | Reserved three times the configured per-file intermediate cap with transactional multi-worker accounting. | Concurrent reservation test and full Rust suite. |
| PS-007 | P1 | safe_auto | Non-empty derivative files could be published without proving they were decodable. | Added `vipsheader` as a required tool and decode-validation step after durable file sync. | Rust suite, package dependency review, full CI. |
| PS-008 | P2 | safe_auto | GIF derivative input selected only the default frame. | Passed `fd[n=-1]` to libvips for GIF input. | GIF argument regression test. |
| PS-009 | P2 | safe_auto | Nested-directory media with the same stem could create a false XMP ambiguity. | Restricted sibling matching to the same parent directory. | Sidecar sibling regression test. |
| PS-010 | P2 | safe_auto | Photostaff system-health severity was implemented without explicit warning/critical contract assertions. | Added unavailable-without-work and unavailable-with-queued-work API assertions. | Focused API suite: 176 tests passed. |

## Residual Actionable Work

None. No downstream-resolver todo was created.

## Advisory Outputs

- The macOS development host cannot validate real `openat2`, systemd notify/watchdog, cgroup cleanup, Debian `amd64`/`arm64` package contents, power-loss timing, or physical NAS detach/reattach. These remain release/target-device acceptance checks.
- A true million-entry scan and forced disk exhaustion were not run locally; the implementation uses streaming `read_dir`, batched SQLite state, bounded command output, and transactional reservations, but target-scale observation is still required.
- The daemon intentionally refuses READY when required media tools are missing. Local `npm run dev` can therefore report `TOOL_UNAVAILABLE` when `exiftool`, libvips, FFmpeg, LibRaw, or HEIF tools are not installed, while API/web development remains available.

## Deployment Verification

1. Back up the SQLite database and both `photos`/`photostaff` cache paths before upgrade; rollback requires restoring them together.
2. After package install, confirm migration `023_photostaff_reliability`, run `PRAGMA foreign_key_check`, and compare asset, metadata, FTS, RTree, upload-reservation, and job counts with the backup.
3. Confirm `zos-photo-worker.service` is disabled/absent and `zos-photostaff.service` preserves the prior enabled/active state.
4. Validate READY/WATCHDOG, stale/unavailable health thresholds, restart recovery, NAS detach/attach, media-tool timeout/crash, source replacement rejection, and journal recovery on target hardware.
5. Inspect the Debian payload to ensure it contains `zos-photostaff` and the new unit, and contains no `apps/photo-worker`, Sharp, exifr, or retired unit runtime.

## Verification Completed

- `cargo test -p zos-photostaff --locked`: 35 passed
- Focused Rust Clippy with `-D warnings`: passed
- Focused API/DB/UI Vitest selection: 176 passed
- `npm run version:check`: passed (`0.9.13`)
- `make ci`: passed, including workspace Rust checks/tests/release build, TypeScript typecheck, ESLint, all Vitest tests, docs checks/tests/build, and protocol binding verification
- `git diff --check`: passed

Warnings were limited to the existing `ts-rs` inability to parse `deny_unknown_fields` and the existing Vite large-chunk advisory.
