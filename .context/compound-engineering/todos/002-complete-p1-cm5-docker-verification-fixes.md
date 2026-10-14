---
status: complete
priority: p1
issue_id: "002"
tags: [docker, cm5, deployment, verification]
dependencies: []
---

# CM5 Docker Verification Fixes

## Problem Statement

CM5 acceptance exposed helper state ownership churn, unknown image occupancy,
and unsupported memory controls. Runtime smoke testing does not establish
Registry/Compose integration, data persistence, or backup recoverability.

## Findings

- Root helper and non-root services share the parent StateDirectory and log directory.
- Engine 26 returns unknown image container counts even with an active RustFS container.
- The host reports no memory limit support; UI/API do not expose capabilities.
- RustFS data is a Docker volume outside the configured NAS backup roots.

## Proposed Solutions

Use the deployed nested StateDirectory fix without moving existing recovery
materials. Derive unknown occupancy from container ImageID, including stopped
containers. Publish nullable Engine capability flags and reject unsupported or
unknown requested limits in the UI and API. Record layered acceptance and an
isolated persistence/backup recovery procedure in the tracked documentation.

## Recommended Action

Implement sequentially on the current main checkout, with focused regression
tests, full quality gates, and browser checks. Do not commit, deploy, reboot the
CM5, change existing credentials, or mutate RustFS data in this work item.

## Acceptance Criteria

- [x] Helper does not declare the shared parent StateDirectory or LogsDirectory.
- [x] Unknown Engine occupancy is resolved using container image IDs.
- [x] Unknown/occupied image removal is blocked in the UI; server checks remain.
- [x] Resource capability flags reach summary, UI, and API validation.
- [x] Regression tests cover false/unknown flags and stopped image references.
- [x] Tracked docs separate smoke acceptance from full production acceptance.
- [x] Full quality gates and browser desktop/narrow checks pass.
- [x] Code review completes; remaining operational acceptance is explicitly reported.

## Work Log

### 2026-09-16 - Implementation Started

- User authorized fixing the issues from CM5 verification.
- Worktree was clean; main remains selected under the user's earlier direction.
- Existing .zos verification records were read without exposing credentials.
- No institutional solutions or critical-patterns files exist yet.

### 2026-09-16 - Implementation and Verification

- Preserved the deployed recovery path while isolating the root helper StateDirectory.
- Derived running/stopped image references by ImageID; incomplete metadata preserves Engine counts.
- Added nullable host resource capabilities, shared API/UI validation, swap dependencies,
  explicit unavailable-input clearing, and confirmation-page feedback.
- Used a browser-safe shared subpath and mirrored its alias in Vitest; no dependencies added.
- Added socket/API integration and shared/UI tests, including absence of mutation/history side effects.
- Updated tracked CM5, API, workspace, capability, troubleshooting and backup/restore documentation.
- Full tests: 80 Vitest files / 531 tests, plus documentation content tests.
- Browser checks used isolated localhost fixtures at desktop/520px: capability states,
  disabled controls, retained inputs, explicit clearing, final confirmation lock and unknown occupancy.
- No new page errors after the browser-safe entry fix. Screenshots are ignored .zos artifacts.
- Temporary fixture servers stopped; original development server preserved.
- No remote deployment, host reboot, credential changes or RustFS data mutation performed.
- Final gates passed: version check (0.3.0), typecheck, lint, full tests, production build;
  docs browser smoke passed both tests. git diff --check is clean.
- Sequential ce:review autofix plus supplementary inline review completed; confirmation feedback
  and test alias findings resolved, no residual actionable code findings.
- Operational gaps remain release-owned: native CM5 deployment, both startup orders,
  private Registry/Compose live paths, reboot, object persistence and isolated backup restore.
