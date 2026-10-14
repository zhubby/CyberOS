---
status: complete
priority: p1
issue_id: "004"
tags: [rust, terminal, packaging, protocol]
dependencies: []
---

# Replace terminal-helper with Rust termux

## Problem Statement

The Node.js `terminal-helper` relies on `node-pty`, has limited integration coverage, and does not follow the hardened Unix daemon patterns established by `hostd`. Replace it atomically with a Rust `termux` daemon and a versioned protocol.

## Findings

- The helper owns the Unix socket and PTY attachment while tmux owns persistent shell processes and scrollback.
- The API depends on ready/output ordering, partial JSONL frames, recoverable disconnects, and acknowledged destroy operations.
- Packaging, CM5 deployment, systemd, configuration, runtime home, and documentation all reference the old helper.

## Proposed Solutions

### Option 1: Rust termux with tmux persistence

Use native Linux PTYs and a versioned streaming protocol while retaining tmux session semantics.

**Pros:** Preserves product behavior, removes `node-pty`, follows hostd security patterns.

**Cons:** Requires coordinated protocol, packaging, and host migration.

**Effort:** Large

**Risk:** High

## Recommended Action

Implement the approved Rust `termux` plan as a single atomic release with no legacy runtime fallback.

## Technical Details

Affected components include `apps/termux`, the API termux client, shared protocol types, Cargo/npm workspaces, Debian/systemd deployment, CM5 checks, and operational documentation.

## Acceptance Criteria

- [x] Rust daemon implements PTY, tmux lifecycle, limits, peer credential checks, backpressure, and graceful shutdown.
- [x] TypeScript and Rust implement and test Termux Protocol v1 with shared fixtures.
- [x] API and configuration use `termux` names without changing browser-facing terminal behavior.
- [x] Debian upgrades retire the old unit, migrate configuration and home safely, and install only the Rust binary.
- [x] Focused integration tests and the repository quality gates pass.
- [x] Documentation describes the new runtime and rollback checks.

## Work Log

### 2026-09-23 - Implementation started

**By:** Codex

**Actions:**
- Audited terminal-helper, API broker, hostd, tmux policy, packaging, release, and CM5 paths.
- Locked the Rust/native PTY, protocol v1, complete rename, and atomic replacement design.

**Learnings:**
- Keeping tmux is necessary to preserve current reconnect and scrollback semantics.
- Connection capacity must remain separate from managed tmux session capacity so destroy operations remain available.

### 2026-09-23 - Implementation completed

**By:** Codex

**Actions:**
- Replaced the Node helper and `node-pty` with the non-root Rust `zos-termux` daemon, native PTYs, tmux lifecycle management, and Termux Protocol v1.
- Renamed the runtime, socket, environment, configuration, home, systemd, packaging, CM5, and documentation surfaces to `termux` with atomic upgrade migration.
- Hardened active-socket detection, PTY cleanup, handshake buffering, strict UUID/Base64 parsing, partial tmux initialization, home migration ordering, and systemd path escaping during autofix review.
- Prepared release version `0.8.0` and removed the obsolete Node runtime and permission repair hook.

**Verification:**
- Typecheck, lint, version check, shell syntax, production build, and `git diff --check` passed.
- Rust: 89 passed, including a real tmux/native-PTY integration test; Vitest: 645 passed and 4 skipped; docs: 5 passed.
- Focused Termux client, protocol, socket ownership, cleanup, migration, and packaging tests passed.
- Review artifact: `.context/compound-engineering/ce-review/20260923-1628-rust-termux/`.

**Deployment boundary:**
- This macOS host has neither `dpkg-buildpackage` nor `systemd-analyze`; real Debian package installation, systemd sandbox validation, and CM5 acceptance remain release gates.
