---
status: complete
priority: p2
issue_id: "003"
tags: [photos, api, worker, web, packaging]
dependencies: []
---

# Build Photo Library V1

## Problem Statement

ZOS has file browsing and image preview, but no photo-oriented library that can bind to a storage-pool directory, index media metadata, render a chronological photo wall, or manage photos in place.

## Findings

- Workspace navigation is extensible and existing file operations already enforce root, storage-pool, traversal, symlink, and approval boundaries.
- The generic index is optimized for file search; photos need separate EXIF metadata, pagination, processing state, and derivative-cache records.
- Production runs native Node.js services on Debian amd64 and arm64, so image processing and HEIC support must be packaged for both architectures.
- The repository has an established dense Workspace visual language and a reusable storage-directory picker.

## Proposed Solutions

### Option 1: Dedicated Photo Library Pipeline

**Approach:** Add photo settings and asset/job tables, a non-root photo worker, scoped API routes, cached WebP derivatives, and a first-class Workspace photo panel.

**Pros:** Keeps image decoding away from Fastify, scales to future photo features, preserves NAS safety boundaries.

**Cons:** Cross-cutting change with new service and package dependencies.

**Effort:** Large

**Risk:** Medium

## Recommended Action

Implement the approved V1 plan: one configured library, recursive chronological timeline, common images plus HEIC/HEIF, immediate and periodic indexing, basic viewer metadata, and approval-gated batch move/delete.

## Technical Details

**Affected areas:**
- Shared contracts and SQLite repositories/migrations
- API photo routes and photo processing worker
- Workspace Photos panel, API client, i18n, and styles
- Debian/systemd packaging and operator documentation

## Acceptance Criteria

- [x] Persist and validate one storage-pool-scoped photo library directory.
- [x] Index supported photos recursively with EXIF date fallback and safe stale cleanup.
- [x] Generate cached thumbnails/previews, including HEIC/HEIF conversion.
- [x] Expose paginated timeline, status, media, upload, download/export, scan, move, and delete APIs.
- [x] Add the responsive Photos Workspace panel, configuration flow, timeline, selection, and lightbox.
- [x] Preserve approval gating and all NAS traversal, symlink, and mount-readiness protections.
- [x] Add focused unit/integration tests and update packaging/docs.
- [x] Pass typecheck, lint, tests, build, browser verification, and code review.

## Work Log

### 2026-09-22 - Implementation Started

**By:** Codex

**Actions:**
- Confirmed product decisions and existing architecture.
- Selected a dedicated worker with SQLite jobs and hash-addressed derivatives.
- Confirmed sharp Node 22/Linux architecture support and Debian HEIC tooling availability.

**Learnings:**
- Existing approval records support multi-proposal file batches.
- Existing storage picker can be generalized for photo-library directory selection.

### 2026-09-23 - Implementation Completed

**By:** Codex

**Actions:**
- Added the photo schema, upload reservations, worker, API, Workspace panel, packaging, and documentation.
- Hardened mount identity, path traversal, concurrent upload publication, cache cleanup, and approval refresh behavior.
- Verified the full quality gate and responsive browser workflows at desktop and 320px widths.

**Verification:**
- Typecheck, lint, build, and `git diff --check` passed.
- Rust: 71 passed; Vitest: 641 passed and 4 skipped; docs: 5 passed.
- Browser: timeline, selection labels, keyboard lightbox, focus restoration, offline cached media, and horizontal overflow checks passed.
- Review artifact: `.context/compound-engineering/ce-review/20260923-photo-library-v1/`.

## Notes

- Out of scope: accounts, face recognition, maps, smart search, favorites, manual albums, share links, editing, RAW, and video.
- Existing uncommitted user changes must remain untouched.
