## Code Review Results

**Scope:** `codex/restore-photos-public-contract` against `origin/main`.
**Intent:** Keep `photostaff` as an internal implementation identifier while restoring the public Photos naming and `/api/photos/*` contract.
**Mode:** autofix, sequential main-thread personas per project instructions.

**Reviewers:** correctness, testing, maintainability, project-standards, agent-native,
learnings, api-contract, adversarial, kieran-typescript.

### Applied Fixes

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 1 | `README.md`, `docs/src/content/docs/reference/systemd.md`, `docs/src/content/docs/start/local-development.md`, `docs/src/content/docs/components/operations-backup.md` | Capitalized Photostaff still read as a public product name instead of an explicitly internal service identifier | project-standards, api-contract | 0.97 | `safe_auto -> review-fixer` |
| 2 | `apps/api/src/routes/photos.test.ts` | Public response fields, export URL prefix, and write forms of removed legacy routes lacked explicit regression assertions | testing, api-contract | 0.94 | `safe_auto -> review-fixer` |
| 3 | `apps/web/src/i18n/resources.ts` | The Chinese settings section still used the generic label “照片” instead of the public product name “相册” | project-standards, kieran-typescript | 0.99 | `safe_auto -> review-fixer` |

- Product-facing documentation now uses Photos and labels lowercase `photostaff` as the internal module or service identifier.
- API tests now reject both read and write forms of legacy Photostaff routes and guard `photos`/`photo` response fields plus the Photos export URL.
- The Chinese workspace and settings surfaces consistently name the product “相册”.
- No unresolved actionable findings remain.

### Learnings & Past Solutions

- No `docs/solutions/` directory or relevant prior solution was present.

### Agent-Native Gaps

- None. The restored Photos HTTP endpoints retain programmatic parity with the web UI.

### Coverage

- Suppressed findings: 0; failed reviewers: 0 (sequential main-thread review).
- Public API, web boundary types, panel/settings identifiers, local-storage migration, i18n, documentation, and retained internal identifiers were reviewed.
- Full gates passed: typecheck, lint, Rust workspace tests, 124 Vitest files with 813 passed and 4 skipped, 5 documentation tests, and the production build.
- Browser acceptance covered desktop plus 820/560/390/320px, dark/light themes, English/Chinese, the legacy stored-panel migration, the map download empty state, and the Photos/相册 settings labels.
- Residual risk is limited to third-party clients that adopted the short-lived `/api/photostaff/*` routes; removal is intentional and explicitly required.

---

> **Verdict:** Ready with fixes.
>
> **Reasoning:** The product/API boundary consistently uses Photos while database, daemon, configuration, and data-directory identifiers remain internal Photostaff contracts. The removed endpoints and field names are guarded by regression tests, and the public naming was verified in both supported languages and themes.
>
> **Fix order:** All confirmed findings were fixed and queued for final verification in this run.
