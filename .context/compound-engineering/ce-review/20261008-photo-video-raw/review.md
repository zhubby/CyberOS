# Code Review Results

**Scope:** `a9ab7836a5fa84d0b8afbbadb6b89b896e2bc602` -> working tree (34 files, including 1 reviewed untracked test file)
**Intent:** Extend the Photos timeline, derivative worker, media API, UI, packaging, and documentation to support common video and RAW formats without changing the database or `PhotoAssetRecord` wire contract.
**Mode:** autofix

**Review lenses:** correctness, testing, maintainability, project standards, security, performance, API contract, reliability, TypeScript, and frontend interaction behavior.

### P2 -- Moderate

| # | File | Issue | Confidence | Route |
|---|------|-------|------------|-------|
| 1 | `apps/api/src/routes/photos.ts:171` | Transcoded video cache keys used indexed metadata and could serve stale content after an in-place source replacement before a rescan | 0.94 | `safe_auto -> review-fixer` |
| 2 | `apps/photo-worker/src/media.ts:216` | RAW conversion accepted any created output path without verifying that Sharp could decode the result | 0.92 | `safe_auto -> review-fixer` |

### P3 -- Low

| # | File | Issue | Confidence | Route |
|---|------|-------|------------|-------|
| 3 | `apps/web/package.json:12` | The Web workspace imported the shared media contract without declaring the workspace dependency explicitly | 0.99 | `safe_auto -> review-fixer` |
| 4 | `apps/web/src/components/workspace/PhotoLibraryPanel.tsx:369` | Timeline navigation intercepted arrow keys while focus was inside native video controls | 0.89 | `safe_auto -> review-fixer` |
| 5 | `apps/web/src/styles/photos.css:389` | The video canvas used a hardcoded background instead of the existing semantic surface token | 0.96 | `safe_auto -> review-fixer` |

### Requirements Completeness

- [x] Shared, case-insensitive image/video/RAW classification and MIME mapping.
- [x] Sharp image handling, `dcraw_emu` RAW conversion, and FFprobe/FFmpeg video poster generation.
- [x] Failure isolation, command timeout/output limits, temporary cleanup, path safety, and unchanged-media cache reuse.
- [x] Upload support and `/api/photos/:id/video` with Range streaming, transcode caching, and concurrent request deduplication.
- [x] Unified timeline, video and RAW badges, native video playback, image/RAW zoom, and responsive behavior.
- [x] Debian/appliance runtime dependencies and updated user, API, development, and troubleshooting documentation.
- [x] Focused tests, full typecheck/lint/test/build, diff validation, and desktop/narrow-screen browser checks.

### Applied Fixes

- Built transcode cache identities from the live source file size and modification time.
- Verified RAW decoder output is a decodable image before derivative generation and retained sanitized failure messages.
- Declared the Web workspace's direct dependency on `@zos/shared`.
- Preserved native video-control arrow-key handling inside the lightbox.
- Reused the semantic deep-input background token for the video canvas.
- Expanded regression coverage for all supported extensions, RAW cleanup/failure isolation, media safety limits, Range streaming, transcode deduplication, cache invalidation, and storage-boundary failures.

### Residual Actionable Work

- None.

### Advisory Outputs

- Target Debian `amd64` and `arm64` package acceptance should include real `dcraw_emu`, FFmpeg, and representative camera RAW fixtures before release.

### Coverage

- Suppressed findings: 0.
- Unresolved actionable findings: 0.
- Verification: typecheck passed; lint passed; 109 Vitest files and 665 tests passed with 4 skipped; Rust and documentation tests passed; build passed; `git diff --check` passed.
- Browser verification passed at desktop and `820`, `560`, `390`, and `320` px widths, including real MP4 poster and playback requests.

---

> **Verdict:** Ready to merge
>
> **Reasoning:** All synthesized findings were fixed and re-verified. The requested video and RAW support is complete without a database migration or wire-shape change.

