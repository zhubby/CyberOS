## Code Review Results

**Scope:** `codex/managed-offline-map` working tree changes for the managed Photostaff basemap only; concurrent share-account changes were excluded.
**Intent:** Download, validate, persist, serve, and automatically load the fixed Natural Earth II 3.2.0 raster PMTiles archive.
**Mode:** autofix, sequential main-thread personas per project instructions.

**Reviewers:** correctness, testing, maintainability, project-standards, agent-native,
learnings, security, performance, api-contract, reliability, adversarial,
kieran-typescript, julik-frontend-races.

- Security: fixed remote asset, immutable digest, HTTPS mirror validation, filesystem publication, and Range serving.
- API contract: managed map DTO, endpoint removal, idempotent start, and archive response behavior.
- Reliability: concurrent starts, shutdown abort, partial cleanup, retry behavior, and atomic publication.
- Frontend races: polling lifecycle, automatic MapLibre initialization, and unmount behavior.

### Applied Fixes

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 1 | `apps/api/src/lib/photostaff-map.ts:142` | Concurrent starts during initial disk inspection could remove a valid archive and redownload it | correctness, reliability | 0.96 | `safe_auto -> review-fixer` |
| 2 | `packages/shared/src/photostaff-config.ts:5` | Managed local filename did not match the specified stable appliance path | api-contract, project-standards | 0.99 | `safe_auto -> review-fixer` |
| 3 | `apps/web/src/styles/photostaff.css:391` | Download CTA used an undefined contrast token in the light theme | correctness, julik-frontend-races | 0.94 | `safe_auto -> review-fixer` |
| 4 | `scripts/build-photostaff-basemap.sh:42` | Reusing an existing virtual environment weakened dependency reproducibility | maintainability, reliability | 0.87 | `safe_auto -> review-fixer` |
| 5 | `apps/api/src/lib/photostaff-map.test.ts:112` | Nullable deferred callback failed the full TypeScript gate | testing, kieran-typescript | 0.99 | `safe_auto -> review-fixer` |

- Initial archive inspection now has one shared promise, and concurrent POST requests reuse its result.
- The Release asset remains `natural-earth-ii-3.2.0-raster.pmtiles`; the managed local file is `natural-earth-ii-3.2.0.pmtiles`.
- The CTA uses the established primary-button state plus explicit readable text color and stable dimensions.
- The asset builder recreates its pinned Python environment with `venv --clear`.
- No unresolved actionable findings remain.

### Pre-existing Issues

- Excluded concurrent user work: `apps/api/src/lib/share-service.ts`, `apps/api/src/routes/approvals.ts`, `apps/api/src/routes/shares.ts`, share portions of `apps/api/src/server.test.ts`, `apps/web/src/api.ts`, `apps/web/src/i18n/resources.ts`, `docs/src/content/docs/reference/api.md`, `apps/web/src/components/workspace/ShareManagementPanel.tsx`, `apps/web/src/styles/workspace.css`, and untracked `ShareAccountDialog` files.

### Learnings & Past Solutions

- No relevant prior solution was found under `docs/solutions/`.

### Agent-Native Gaps

- None. The managed download and status operations are exposed through stable HTTP endpoints used by both UI and programmatic clients.

### Coverage

- Suppressed findings: 0; failed reviewers: 0 (sequential main-thread review).
- Full gates passed: typecheck, lint, 124 Vitest files with 811 passed and 4 skipped, Rust tests, docs tests, and production build.
- Asset validation passed for the 23,141,432-byte JPEG raster archive with SHA-256 `a9b54608526b54ef348862b15c43d0e79a9b491ad573ccbc121202d2f196f1ba`.
- Browser acceptance covered initial, downloading, failure/retry, automatic ready loading, Range 206, desktop, 820/560/390/320px, both themes, and Chinese/English.
- Residual risk: clients must be able to reach GitHub Releases or an operator-configured HTTPS byte-identical mirror.

---

> **Verdict:** Ready with fixes.
>
> **Reasoning:** The managed asset boundary, atomic publication path, retry and shutdown behavior, endpoint contract, and responsive UI states are covered by automated and browser tests. No residual actionable findings remain in the map scope.
>
> **Fix order:** All confirmed findings were fixed and re-verified in this run.
