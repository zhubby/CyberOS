## Code Review Results

**Scope:** `442bc0e` -> working tree (69 files, 6,263 insertions, 146 deletions)
**Intent:** Add approval-gated, policy-resolved Host Access grants to Compose Apps and single-container creation without exposing arbitrary host sources. Keep unverified Docker/systemd proxy capabilities unavailable and report coverage honestly.
**Mode:** autofix

**Reviewers:** correctness, testing, maintainability, project-standards, agent-native, learnings, security, performance, API-contract, data-migrations, reliability, adversarial, kieran-typescript, julik-frontend-races, schema-drift, deployment-verification

### Applied Fixes

- Made approval, job, operation, event, and private-draft linking transactional.
- Added migration `033_docker_host_access_draft_links` and compatibility handling for both pre-release `032` schema variants.
- Pinned approved Compose services to immutable image IDs and revalidated image/resource fingerprints before execution.
- Replaced optimistic Compose Host Access status with container image, label, fingerprint, and proxy-socket inspection.
- Returned `503` for unavailable host dependencies while preserving `400` for invalid configuration and `409` for drift.
- Added periodic transactional expiration of private drafts and synchronized approval/job/operation failure state.
- Restored preserved Docker proxy sockets after daemon restart and limited recovery scans to hashed grant directories.
- Rebuilt nested Docker proxy fields by allowlist, removed network namespace paths, and disabled filter-based label probing.
- Required full-project apply for both pending and repair states.
- Opened NAS capacity anchors with `O_NOFOLLOW | O_DIRECTORY`, checked hostd ownership through the descriptor, and changed permissions through the open handle.
- Blocked unavailable/invalid picker submissions, required degraded acknowledgement, and included configured/runtime/degraded/unavailable states in copied coverage reports.

### Learnings & Past Solutions

- No `docs/solutions/` directory exists, so no institutional solution document was available for this change.

### Agent-Native Gaps

- Docker Host Access can be managed through the web/API approval flow, but the repository has no first-class agent tool for selecting grants or producing the coverage report. This is advisory because the approved plan did not expand the agent tool surface.

### Schema Drift Check

- Clean: SQLite schema is migration-driven; migration order, both pre-release upgrade shapes, and `foreign_key_check` are covered by tests.

### Deployment Notes

- Keep `ZOS_HOST_ACCESS_DOCKER_COMPATIBLE=0` until Netdata and `prom/node-exporter` pass the target-host allow/deny, redaction, reconnect, timeout, and load suite.
- Before deployment, back up `/zos/state`, confirm migration `033_docker_host_access_draft_links` applies once, and verify `PRAGMA foreign_key_check` returns no rows.
- Verify `zos-host-accessd.service`, `zos-hostd.service`, and `zos-api.service`; inspect `/api/docker/host-access` reason codes before granting any capability.
- Roll back the package and matching SQLite state together if migration/runtime verification fails; there is no general reverse migration.

### Coverage

- Suppressed: no remaining confidence-qualified code findings after two autofix rounds.
- Untracked file excluded from formal diff scope: `apps/web/src/components/workspace/HostAccessPicker.test.ts`; it was still executed directly and passed.
- Residual risks: Docker metadata compatibility and systemd facade compatibility are intentionally unavailable.
- Testing gaps: real collector validation on `192.168.11.91` was not authorized or performed; proxy concurrency/timeout/response-limit paths have focused unit coverage but not target-host end-to-end load coverage.
- Browser coverage completed at 1440, 820, 560, 390, and 320 px before the final backend hardening; the later UI change only maps already-rendered coverage chips to existing state tokens and passed typecheck/build.

---

> **Verdict:** Ready to merge
>
> **Reasoning:** All confirmed code findings were fixed and the full typecheck, lint, test, Rust clippy, and production build gates pass. Docker metadata and systemd status remain disabled until their explicit operational gates are satisfied.

