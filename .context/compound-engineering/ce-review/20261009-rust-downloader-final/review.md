## Code Review Results

**Scope:** `34f4350332ceae06ec6bb72f5e32ea3b6ace0c11` to the current working tree, including all untracked Rust downloader and focused test files.

**Intent:** Completely replace the Node downloader with a Rust 1.95 service, preserve existing tasks and partial files, and add crash-safe publication, bounded storage use, retry/recovery, segmented transfers, checksums, worker health, API/UI contracts, and native Debian packaging.

**Mode:** autofix; sequential main-thread fallback required by repository instructions.

**Reviewers:** correctness, testing, maintainability, project standards, agent-native, learnings, security, performance, API contract, data migration, reliability, adversarial, TypeScript, schema drift, and deployment verification.

### Findings

No actionable code findings remain after the autofix review.

### Applied Fixes

- Corrected multiline SQL construction and added database state-machine coverage.
- Fenced publish journals from task claims and expired-task recovery, verified journal identity during finalization, and made completion idempotent.
- Added an advisory partial-file lock so a live publisher cannot race crash recovery before rename.
- Synchronized the parent directory during both normal publication and post-rename recovery.
- Stopped lease renewal as soon as pause/cancel is requested, preserved cancel priority, and prevented panics from leaving immortal lease heartbeats.
- Removed process-local task deduplication that could strand a reclaimed task after panic.
- Preserved only durable single-stream and segmented offsets across restart.
- Enforced per-hop HTTPS downgrade rejection, usable strong validators, full DNS pinning with address fallback, and stable transient HTTP retry classification.
- Changed backoff so the first automatic retry starts at the configured base delay while retaining bounded jitter.
- Applied ACL entries before the final `0660` mask, and retained file/directory durability ordering.
- Added aggregate segmented-transfer speed to the checkpoint transaction.
- Added Rust-side settings validation matching the TypeScript ranges.

### Requirements Completeness

- Met: Node runtime removal, Cargo workspace integration, Rust 1.95, Tokio/reqwest/rustls/rusqlite, migration 022, settings/API/UI/SSE/health contracts, systemd service, and Debian binary installation.
- Met: SSRF and redirect policy, multi-address pinning, timeouts, single/segmented transfers, bounded segments, durable checkpoints, checksum validation, reservations, openat2/renameat2 publication, journal recovery, leases, heartbeats, retry policy, and clean shutdown requeue.
- Met locally: unit and controlled HTTP coverage for 200/206/416, Range ignored, validator changes, truncated bodies, header/read timeout, retry statuses, private redirects, multi-address fallback, out-of-order ranges, size limits, checksum mismatch, pause/cancel, publication recovery, and legacy-schema preservation.
- Release validation required: real Debian package installation, systemd sandbox behavior, ACL behavior on the target filesystem, forced process kills at each publication boundary, power-loss recovery, and physical NAS offline/online recovery.

### Residual Actionable Work

None in the source tree. The remaining work is release-owned hardware and operating-system acceptance.

### Learnings & Past Solutions

- No applicable repository solution notes were found under `docs/solutions/`.

### Agent-Native Gaps

None. Download creation, control, retry, deletion, settings, status, and health remain available through the same public API used by the web UI.

### Schema Drift Check

- Clean: migration `022_downloader_reliability` only extends downloader state and adds its four owned tables plus claim/heartbeat indexes.
- The legacy fixture applies the Node migration catalog through 021, preserves queued/running/paused/failed rows and a `.part`, then upgrades through the normal `openZosDb` path.

### Deployment Notes

- Back up the current package, SQLite state, `/zos/config`, `/zos/state`, and downloader partial files before switching runtimes; rollback requires the matching pre-upgrade database and partial-file backup.
- Verify migration 022 before starting the downloader, then confirm `zos-downloader.service`, worker heartbeat freshness, `/api/downloads`, and `/api/system/health`.
- Exercise a large segmented transfer, a checked transfer, service restart during transfer, forced exit around publication, disk reserve exhaustion, and NAS detach/reattach before release.
- Monitor downloader/API journals for `database`, `storage`, `source_changed`, `disk_space`, and repeated retry-wait transitions.

### Coverage

- Suppressed findings: 0; dropped malformed findings: 0; failed reviewers: 0.
- `make ci` passed on the final tree: typecheck, Astro check, rustfmt, clippy with `-D warnings`, ESLint, all Rust/Vitest/docs tests, release build, Web build, docs build, and internal-link validation.
- `zos-downloader`: 29 Rust tests passed, including controlled HTTP and persistence/recovery tests.
- Focused API/database/Web tests: 22 passed; the schema migration suite passed 10 tests.
- `cargo check` passed for `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu`; `npm run version:check` and `git diff --check` passed.
- Browser checks passed at 1440, 820, 560, 390, and 320 px; the host had no mounted storage pool, so the create dialog itself remained component-tested rather than exercised against a live pool.
- A real `.deb` was not built or installed on this macOS host; Linux package and appliance acceptance remain release gates.

---

> **Verdict:** Ready for Linux release acceptance.
>
> **Reasoning:** No confirmed source-level findings remain, all local quality gates and both Linux target checks pass, and the high-risk network, persistence, publication, control, and upgrade paths now have focused coverage. The remaining checks require a real Debian/systemd/NAS environment rather than more local source changes.
