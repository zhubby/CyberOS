# Code Review Results

**Scope:** `abb162f2d101aa1423bc8f6a3812f1e9c0ffe67f` -> working tree (53 files, including 17 manually inspected untracked feature files)
**Intent:** Add a storage-pool-scoped Photo Library V1 with safe indexing, cached derivatives, chronological browsing, uploads, exports, approval-gated mutations, packaging, and operator documentation.
**Mode:** autofix

**Reviewers:** correctness, testing, maintainability, project-standards, agent-native, learnings, security, performance, api-contract, data-migrations, reliability, adversarial, kieran-typescript, frontend-races, schema-drift, deployment-verification

- security and adversarial: new filesystem reads, writes, uploads, cache access, and approval-gated mutations
- performance and reliability: recursive image processing, derivative caching, leases, polling, and ZIP exports
- api-contract: new `/api/photos` route family and shared response types
- data-migrations and schema-drift: new photo asset, job, and upload-reservation tables
- kieran-typescript and frontend-races: new TypeScript worker, API, polling, selection, and dialog flows
- deployment-verification: new native worker, Sharp dependency, HEIC tooling, and systemd unit

### P1 -- High

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 1 | `apps/photo-worker/src/processor.ts:62` | Worker could scan an offline, replaced, or nested foreign mount | security, reliability, adversarial | 0.94 | `safe_auto -> review-fixer` |
| 2 | `apps/api/src/routes/photos.ts:161` | Latest queued refresh blocked every upload after the first file | correctness, api-contract, frontend-races | 0.98 | `safe_auto -> review-fixer` |
| 3 | `apps/api/src/routes/photos.ts:181` | Exists-then-publish upload flow allowed target races | correctness, security | 0.91 | `safe_auto -> review-fixer` |
| 4 | `packages/db/src/migrations/production.ts:349` | Pending assets changed an already-applied migration contract | data-migrations, correctness | 0.99 | `safe_auto -> review-fixer` |

### P2 -- Moderate

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 5 | `apps/api/src/routes/photos.ts:428` | Cached derivatives incorrectly depended on the live photo mount | reliability, api-contract | 0.92 | `safe_auto -> review-fixer` |
| 6 | `apps/api/src/routes/approvals.ts:302` | Applied photo mutations could leave the timeline stale | correctness, reliability | 0.88 | `safe_auto -> review-fixer` |
| 7 | `apps/web/src/components/workspace/PhotoLibraryPanel.tsx:148` | Polling could overlap or miss externally completed scans | frontend-races, correctness | 0.87 | `safe_auto -> review-fixer` |
| 8 | `apps/photo-worker/src/media.ts:41` | Removed photos left hash-addressed derivatives unbounded | performance, reliability | 0.90 | `safe_auto -> review-fixer` |

### P3 -- Low

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 9 | `apps/web/src/components/workspace/PhotoLibraryPanel.tsx:424` | Mobile icon-only controls lost accessible names | project-standards, correctness | 0.95 | `safe_auto -> review-fixer` |

### Requirements Completeness

- [x] Persist and validate one storage-pool-scoped photo library directory.
- [x] Recursively index supported photos with EXIF date fallback and safe stale cleanup.
- [x] Generate and safely clean cached thumbnails/previews, including HEIC/HEIF conversion.
- [x] Expose timeline, status, media, upload, export, scan, move, and delete APIs.
- [x] Add a responsive Photos Workspace panel with configuration, timeline, selection, and lightbox.
- [x] Preserve approval, traversal, symlink, mount identity, and storage-pool boundaries.
- [x] Add focused tests, packaging, systemd integration, and documentation.
- [x] Pass typecheck, lint, full tests, build, browser verification, and review.

### Applied Fixes

- Added production mount-source verification, start/end mount identity checks, and per-device recursive scan boundaries.
- Replaced pending photo assets with additive migration `018_photo_upload_reservations` and transactional hash/path reservations.
- Based upload availability on a completed initial full scan, preserving multi-file uploads while refresh jobs run.
- Published uploads with hard-link no-clobber semantics and released reservations when files are indexed or stale.
- Kept cached WebP derivatives available offline while requiring live mount validation for originals and GIF previews.
- Enqueued scoped full scans after successful or partially applied photo approvals.
- Serialized frontend polling, refreshed on external completions, handled refresh failures, and restored mobile labels.
- Removed old, unreferenced generated derivatives only after a complete successful full scan.

### Agent-Native Gaps

- Photo actions are available through the local HTTP API and approval system, but ZOS Agent has no dedicated photo-library tool vocabulary. This is advisory for a later agent-parity iteration and does not block the requested UI/API V1.

### Schema Drift Check

- Clean: SQLite migration order is explicit through `018_photo_upload_reservations`; there is no generated schema snapshot to drift, and migration tests pass.

### Deployment Notes

- Pre-deploy: back up the SQLite database and confirm target-architecture Sharp installation plus `libheif-examples` availability.
- Verify: `zos-photo-worker.service` is active, migration `018_photo_upload_reservations` exists in `schema_migrations`, and a full scan reaches `ready` or an explained `degraded` state.
- Rollback: the additive reservation table can remain in SQLite if an older package is restored; stop the photo worker before restoring a database snapshot.
- Monitor: photo-worker journal errors, derivative cache growth under `/zos/state/photos`, and storage-pool mount identity failures.

### Coverage

- Suppressed: 0 findings below the confidence threshold.
- Residual risks: real HEIC conversion and systemd mount behavior require target Debian amd64/arm64 deployment verification.
- Testing gaps: no physical HEIC fixture or live nested-mount integration test was run on this macOS host; deterministic conversion, mount-runner, path-safety, and packaging tests cover the local gate.
- Untracked scope: all 17 untracked Photo V1 files were inspected directly and included in focused/full verification.
- Failed reviewers: none; repository policy required the selected personas to be applied sequentially in the main thread.

---

> **Verdict:** Ready to merge
>
> **Reasoning:** All nine synthesized findings were fixed and re-verified. The explicit Photo V1 acceptance criteria are met, and no residual actionable finding remains.
>
> **Fix order:** Complete
