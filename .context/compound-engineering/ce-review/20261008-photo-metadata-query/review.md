# Code Review Results

**Scope:** `56aee8fe5763364f135b4f9a3c3eff1565f71224` -> working tree (38 implementation files, including 4 untracked source/test files)
**Intent:** Preserve bounded photo/video metadata and XMP sidecars, index normalized and arbitrary scalar fields, expose privacy-aware query/map/Agent surfaces, and add multi-file upload plus responsive Web workflows.
**Mode:** autofix

**Review lenses:** correctness, testing, data integrity, migration safety, API contract, security/privacy, performance, reliability, TypeScript, and frontend interaction behavior.

### P2 -- Moderate

| # | File | Issue | Confidence | Resolution |
|---|------|-------|------------|------------|
| 1 | `apps/photo-worker/src/metadata.ts:436` | Real exifr XMP output uses namespace groups such as `dc`, `xmp`, `exif`, and `tiff`; the first normalization pass missed common sidecar title, creator, rating, capture time, camera, and keyword fields | 0.99 | Applied and covered with a real XML sidecar parse test |
| 2 | `apps/photo-worker/src/metadata.ts:153` | Scalar-size accounting did not guarantee that escaped JSON remained below the 512 KiB serialized document limit | 0.98 | Applied exact serialized-byte accounting and boundary tests |
| 3 | `packages/db/src/repositories/photo-metadata.ts:601` | Advanced `contains` and `prefix` treated `%`, `_`, and `\\` as SQL LIKE syntax instead of literal user data | 0.99 | Applied parameterized LIKE escaping and operator coverage |
| 4 | `packages/agent/src/pi-agent.ts:558` | Returning `distanceMeters` allowed repeated nearby searches to triangulate sensitive photo locations even though exact GPS fields were redacted | 0.94 | Removed distance from Agent output while retaining local location filters and sorting |
| 5 | `apps/web/src/components/workspace/PhotoMapView.tsx:310` | Whole-world MapLibre bounds normalized both `-180` and `180` to `-180`, producing a zero-width search; wrapped viewports also needed explicit antimeridian handling | 0.97 | Added span-aware viewport conversion and regression tests |
| 6 | `apps/web/src/styles/photos.css:125` | Common photo filters overflowed their container and became inaccessible in split desktop and `820px` layouts | 0.99 | Converted the filter row to responsive wrapping with stable control widths |
| 7 | `apps/web/src/styles/photos.css:939` | At `320px`, wrapped filters compressed the result grid to zero height, making timeline and map results unreachable | 0.99 | Added a bounded mobile content flow with panel scrolling and stable result height |

### Requirements Completeness

- [x] Migration 019 adds normalized metadata, scalar values, keywords, FTS5, GPS RTree, map settings, indexes, and cascading cleanup while preserving `photo_assets`.
- [x] Metadata extraction covers image/RAW exifr sources, one-pass ffprobe video documents, bounded scalar/JSON cleaning, timezone-aware capture selection, and XMP sidecar precedence/fingerprints.
- [x] Query services cover common and arbitrary-field filters, `all/any`, all requested operators, facets, keyset cursors, antimeridian/polar distance handling, field catalogs, details, map clusters, and progressive index status.
- [x] API and Agent surfaces preserve the legacy timeline contract, validate the 64 KiB query body, hide sensitive metadata by default, enforce session-root isolation, and stream validated local raster PMTiles with Range support.
- [x] Upload, move, trash, and ZIP export associate sidecars without changing original-download bytes; the Web uploader handles multiple media and XMP files in media-first order.
- [x] Web timeline/map, common filters, advanced builder, metadata inspector, sensitive reveal, offline map fallback, local geolocation opt-in, and responsive layouts use existing ZOS tokens and components.
- [x] User, API, database, Agent, troubleshooting, and capability documentation reflects the local-only metadata and raster-map boundaries.

### Applied Fixes

- Parsed namespace-qualified XMP sidecars and retained embedded parse warnings/UserComment data.
- Enforced leaf, scalar, depth, binary/MakerNote, and exact serialized JSON limits.
- Added atomic replacement rollback/stale-index cleanup tests and literal LIKE behavior.
- Removed Agent distance leakage and fixed whole-world/antimeridian map bounds.
- Reworked responsive filter wrapping and mobile result scrolling after browser inspection.

### Residual Actionable Work

- None.

### Advisory Outputs

- Before release, run target `amd64` and `arm64` acceptance with representative JPEG/HEIC/RAW camera files containing EXIF, IPTC, XMP, ICC/JFIF, serial/GPS fields, plus real ffprobe video metadata.
- Exercise raster PNG/JPEG/WebP PMTiles archives with real tile directories and intentionally truncated/corrupt payloads on mounted and offline NAS pools; unit coverage currently emphasizes header/type, path, and Range boundaries.
- Migration 019 has no reverse migration. Before deployment, stop SQLite writers/timers, back up the package/config/data directory and SQLite files, install, start the photo worker to enqueue stale assets, monitor index status and journald, and restore the matching backup for rollback.

### Coverage

- Suppressed findings: 0.
- Unresolved actionable findings: 0.
- Verification: `make ci` passed; 110 Vitest files with 699 passed and 4 skipped; Rust, documentation tests, typecheck, lint, and production build passed; `git diff --check` passed.
- Browser verification passed at `1440/820/560/390/320px` in dark and light themes, including timeline, local-map fallback, mobile viewer/download, and DOM overflow checks.
- Build advisory: Vite still reports a non-failing chunk-size warning.

---

> **Verdict:** Ready to merge
>
> **Reasoning:** The requested metadata/index/query surface is implemented end to end, confirmed privacy and responsive defects were fixed, and no unresolved P0/P1 or other actionable findings remain.
