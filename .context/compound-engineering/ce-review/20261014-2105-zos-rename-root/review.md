## Code Review Results

**Scope:** `3634387` to the current working tree, including the complete ZOS rename, npm and Rust identities, configuration, persistent paths, Debian packaging, systemd units, workflows, documentation, UI assets, and the untracked canonical path module and tests.

**Intent:** Rename the product and brand to ZOS, use `zos` for machine-facing identities, place production-owned data under `/zos`, and require mounted data roots to be direct children of `/zos/data`.

**Mode:** autofix; sequential main-thread execution required by repository instructions.

**Reviewers:** correctness, testing, maintainability, project standards, agent-native, learnings, security, API contract, reliability, CLI readiness, adversarial, and TypeScript.

### Findings

No actionable code findings remain after the autofix review.

### Applied Fixes

- Passed the configured `appsRoot` to the API's default Docker Compose service so development writes stay inside the isolated ZOS root instead of falling back to `/zos/apps`.
- Added an API regression test that creates a managed Compose App and verifies both its returned path and materialized file location.
- Canonicalized and constrained installer, deployment, locale, and ACL backup overrides to their ZOS-owned roots.
- Rejected the filesystem root as an ACL tool `ZOS_ROOT` and added shell and Node regression coverage for backup paths outside the configured root.
- Required the VOD refresh helper to keep its persistent session state under `/zos/state/vod-player`, matching the shared configuration validator and systemd sandbox.

### Requirements Completeness

- Met: public product copy and formal branding use `ZOS`; machine-facing package scopes, Rust crates, binaries, services, users, environment variables, sockets, and file names use `zos` or `ZOS` as appropriate.
- Met: production configuration is fixed at `/zos/config/config.toml`, the database is `/zos/state/zos.sqlite`, runtime sockets are under `/run/zos`, and packaged program files are under `/usr/lib/zos`.
- Met: canonical persistent directories are derived from `/zos`, including `config`, `state`, `data`, `apps`, `iso`, `vm`, `logs`, `home`, `deploy`, and `system-backups`.
- Met: NAS roots must be direct children of `/zos/data`; the reserved backup root is `/zos/data/backup`.
- Met: development defaults to `.zos/dev-root` and managed Compose App files follow the configured development root.
- Met: pre-ZOS in-place migration is intentionally unsupported and documented; installation requires backup followed by a fresh install or rebuilt image.
- Met: the existing ignored pre-ZOS user-generated history directory was preserved and not deleted.

### Residual Actionable Work

None in the source tree. Debian package installation and appliance acceptance remain release-owned checks.

### Learnings & Past Solutions

- No applicable repository solution notes were present under `docs/solutions/`.

### Agent-Native Gaps

None introduced. The rename preserves the existing API and UI action surface while changing product identities and storage locations.

### Deployment Notes

- This is an intentionally incompatible product boundary. Do not attempt an in-place migration from the pre-ZOS layout.
- Back up all required data before installation, then use a fresh ZOS install or rebuild the appliance image.
- Verify `/zos/config`, `/zos/state`, `/zos/data`, service ownership, timers, readiness, indexing, backup, Docker Apps, terminal, and VOD playback on the target host.
- Do not remove the historical pre-ZOS development directory unless its owner explicitly decides it is no longer needed.

### Coverage

- Suppressed findings: 0; dropped malformed findings: 0; failed reviewers: 0.
- `make ci` completed on the final source tree, covering protocol generation checks, TypeScript/Astro checks, Rust formatting and clippy, ESLint, Rust/Vitest/docs tests, and production builds.
- Focused API and packaging verification passed: 172 tests passed and 4 Linux-only tests were skipped on macOS.
- The independently rerun Docker Compose suite passed all 12 tests after one unrelated concurrent timeout-test failure in an earlier broad run.
- Documentation browser smoke passed 2 tests after installing Chromium.
- Headless application browser checks passed at 1280x720 and 390x844 for the main Chat and Workspace surfaces plus Overview, Advanced, and Version settings; ZOS branding and development paths rendered correctly, no document-level horizontal overflow was present, and the browser reported no page or console errors.
- Static scans found no tracked old-brand strings or names, `/srv`, `/etc/zos`, `/var/lib/zos`, or `/var/log/zos` remnants outside the intentionally preserved ignored history directory.
- A real Debian package was not installed on this macOS host; systemd, permissions, mounted storage, and target hardware remain release gates.

---

> **Verdict:** Ready for Debian package and appliance acceptance.
>
> **Reasoning:** No confirmed source-level findings remain, canonical paths are enforced across application configuration and host tooling, and local CI plus browser smoke pass. The remaining checks require a Debian/systemd target with real mounted storage.
