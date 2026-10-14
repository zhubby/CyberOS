## Code Review Results

**Scope:** `f2033b0e58eb27f09d07b2be89d6737d21339b2c` to the current working tree (87 tracked/untracked entries). The 19 untracked Rust, IPC client, systemd, Cargo, and toolchain files were intentionally included because they are the core implementation, despite the normal autofix exclusion for untracked files.

**Intent:** Replace the root Node share helper with a Rust host integration daemon named `zos-hostd`, preserve share/storage/Docker/NetworkManager behavior, migrate configuration and packaging, and remove the old runtime implementation and name.

**Mode:** autofix; sequential main-thread fallback required by repository instructions. No review subagents were dispatched.

**Reviewers:** correctness, testing, maintainability, project standards, agent-native, learnings, security, API contract, data migration, reliability, adversarial, TypeScript, CLI readiness, and deployment verification.

### P1 -- High

All confirmed high-severity findings were fixed and verified; none remains open.

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 1 | `apps/hostd/src/shares.rs:648` | Caller-provided NAS roots could authorize paths outside hostd's configured roots | security, correctness | 0.99 | `safe_auto -> review-fixer`, applied |
| 2 | `apps/hostd/src/shares.rs:657` | Lexical containment allowed a share symlink to resolve outside its NAS root | security, adversarial | 0.99 | `safe_auto -> review-fixer`, applied |
| 3 | `apps/hostd/src/shares.rs:802` | Unvalidated NFS client strings could inject extra export clients or options | security, API-contract | 0.99 | `safe_auto -> review-fixer`, applied |
| 4 | `scripts/versioning.mjs:175` | The pure Rust workspace directory made the required pre-package version check fail because it has no package.json | correctness, project-standards | 1.00 | `safe_auto -> review-fixer`, applied |

### P2 -- Moderate

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 5 | `apps/hostd/src/command.rs:68` | Command timeout previously excluded blocked stdin writes and could hang hostd | reliability | 0.98 | `safe_auto -> review-fixer`, applied |
| 6 | `apps/hostd/src/storage.rs:547` | Orphan RAID cleanup inspected the wrong sysfs holders directory | correctness | 0.99 | `safe_auto -> review-fixer`, applied |
| 7 | `packaging/systemd/zos-hostd.service:11` | A unit-level socket override would ignore the socket path migrated into TOML | deployment, data-migration | 0.98 | `safe_auto -> review-fixer`, applied |
| 8 | `packaging/scripts/build-deb.sh:62` | Debian source copying could include stale local Rust target output | project-standards, deployment | 0.96 | `safe_auto -> review-fixer`, applied |
| 9 | `apps/hostd/src/shares.rs:264` | A later service reload failure restored files but left earlier services running the failed transaction's configuration | correctness, reliability | 0.97 | `safe_auto -> review-fixer`, applied |

### Applied Fixes

- Added a Rust workspace and `zos-hostd` binary with versioned, bounded JSONL IPC over `/run/zos/hostd.sock`, peer UID checks, domain locks, bounded command output, and command timeouts.
- Ported shares, storage, Docker daemon, and NetworkManager operations; removed the Node `apps/share-helper` implementation and old unit.
- Added authoritative hostd NAS-root loading, client-root equality checks, realpath containment, and strict NFS CIDR validation.
- Read child stdout/stderr concurrently and included stdin delivery in command deadlines.
- Hardened Docker and NetworkManager atomic updates, race checks, rollback state, credential redaction, and symlink handling.
- Corrected RAID holder inspection and expanded storage rollback coverage.
- Reloaded attempted share services after restoring configuration files on a failed apply.
- Migrated `[shares].helper_socket_path` to `[hostd].socket_path`, removed persisted `helperSocketPath`, and preserved config ownership, mode, and backups.
- Updated API clients, shared types, systemd, Debian packaging, installer, appliance, CI, and documentation to the hostd name and protocol.
- Made npm version discovery ignore non-npm directories matched by workspace globs, preserving `apps/hostd` as a pure Rust crate.

### Residual Actionable Work

None. The remaining items require security/operations policy rather than a safe local autofix, so no downstream todo files were created.

### Learnings & Past Solutions

- No `docs/solutions/` directory exists, so there were no repository solution notes to apply.

### Agent-Native Gaps

None. Hostd is an internal privilege boundary; supported actions remain reachable through the existing API and approval workflows.

### Schema Drift Check

- Clean: migration `016_hostd_config` only transforms JSON settings data and does not introduce unrelated schema objects.

### Deployment Notes

- Pre-deploy: back up `/zos/config`, `/zos/state`, SQLite state, and the current package; verify Rust 1.95.0 is available to the package build.
- Upgrade: stop writer services and timers, install the package, confirm the TOML backup and migrated `[hostd].socket_path`, and verify the retired `zos-share-helper.service` is disabled.
- Verify: `systemctl is-active zos-hostd.service zos-api.service`, inspect both journals, then run `/health`, `/api/roots/readiness`, `/api/system/health`, one index pass, and representative approved share/storage/network operations.
- Rollback: configuration and database migrations have no general reverse migration. Restore the matching package, config, and state backup together.
- Release gate: build and install the Debian package on Linux `amd64` and `arm64`; this macOS review host cannot validate systemd sandbox paths or real privileged commands.

### Coverage

- Suppressed: 0 findings below the confidence threshold; dropped malformed findings: 0.
- Full gate passed twice: `make ci` (typecheck, Rustfmt, Clippy, ESLint, 46 Rust tests, 605 Vitest tests, documentation tests, release build, and docs build).
- `npm run version:check` passed at version `0.6.0`; `git diff --check` and `cargo fmt --all --check` passed.
- Focused coverage includes IPC framing/errors, command output and timeout bounds, TOML/SQLite migration, configured-root and symlink containment, NFS injection, service rollback reloads, storage rollback/sysfs behavior, Docker race/rollback behavior, NetworkManager credential/recovery behavior, and packaging declarations.
- Inherited trust risk: hostd authenticates UID, while API, worker, and several jobs share the `zos` UID. A compromised peer process can bypass API approval workflows. Separating the API into a dedicated hostd socket group or using a capability-scoped broker requires an explicit architecture decision.
- Inherited timeout risk: API deadlines (30/35/120 seconds) do not cancel hostd work and can expire while a multi-command operation continues. A cancellable request protocol or operation-status model requires a contract decision.
- Inherited service risk: disabling one sharing protocol while sharing remains globally enabled does not refresh a previously running service for that protocol. The correct policy depends on whether ZOS owns or shares those host services.
- Durability risk: several rename/remove paths do not fsync parent directories, and fstab recovery writes in place. Power-loss guarantees need Linux filesystem-level verification.
- Installer supply-chain risk: the host installer executes rustup bootstrap content fetched from the configured HTTPS URL without a pinned checksum.
- Expected non-blocking output remained: one React i18next test warning and Vite's existing large-chunk warning.

---

> **Verdict:** Ready with fixes; Linux package acceptance remains a release gate.
>
> **Reasoning:** All confirmed implementation defects found in autofix review were repaired and the complete local quality gate passes. Remaining concerns are inherited architecture or deployment risks that should not be changed silently in autofix mode.
