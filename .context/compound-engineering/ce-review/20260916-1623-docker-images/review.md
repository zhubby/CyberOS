## Code Review Results

**Scope:** `e07a3a2b7f30d6485d7c1335eab89bda30d2a8c8` to the working tree, focused on Docker images and Registry credentials.

**Intent:** Implement the user-approved image search/detail/pull/non-force removal and multi-Registry credential plan. Preserve existing Docker daemon changes, approval boundaries, and non-root service identities.

**Mode:** autofix; sequential main-thread review as required by repository instructions. This record closes the review completed before final verification; it does not claim independent subagent agreement.

**Review lenses:** correctness, testing, maintainability, project standards, API accessibility, security, API contracts, reliability, adversarial cases, TypeScript boundaries, and asynchronous frontend state.

- Security: persisted secrets and Engine/Compose authentication.
- API contracts: new image and Registry routes, summary fields, and validation/status mapping.
- Reliability: temporary configuration cleanup, operation timeouts, and credential rotation.
- Adversarial: destructive operations, malformed references, and encoded secret output.
- TypeScript/frontend state: browser-safe shared imports and modal/submission transitions.

### P1 -- High

These historical findings were fixed and verified; none remains open.

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 1 | `apps/api/src/lib/docker-compose.ts:105` | Empty Registry lists could inherit host authentication; setup failures and encoded output needed isolation, cleanup, and redaction | sequential security/reliability lens | 0.98 | `safe_auto -> review-fixer`, applied |
| 2 | `apps/api/src/lib/docker-client.ts:420` | Removing a tag needed an explicit check of all container ImageID references before Engine deletion | sequential correctness/security lens | 0.98 | `safe_auto -> review-fixer`, applied |
| 3 | `packages/shared/package.json:7` | Browser imports needed a dedicated shared image-parser export rather than the Node-dependent package entry point | sequential TypeScript lens | 0.96 | `safe_auto -> review-fixer`, applied |

### P2 -- Moderate

| # | File | Issue | Reviewer | Confidence | Route |
|---|------|-------|----------|------------|-------|
| 4 | `packages/db/src/repositories/docker-registry-credentials.ts:82` | Empty-password updates needed to retain the existing secret at the repository boundary | sequential correctness/API-contract lens | 0.98 | `safe_auto -> review-fixer`, applied |
| 5 | `packages/shared/src/docker-images.ts:25` | Reference validation and Registry normalization needed consistent repository/tag/digest, IPv6, and explicit-port handling | sequential correctness/adversarial lens | 0.96 | `safe_auto -> review-fixer`, applied |
| 6 | `apps/api/src/lib/docker-create.ts:142` | Automatic pulls needed fresh credentials at actual execution, including after the missing-image check | sequential correctness/reliability lens | 0.97 | `safe_auto -> review-fixer`, applied |
| 7 | `apps/web/src/styles/workspace.css:5121` | Notifications could obscure new modal controls; confirmations also needed live Engine-readiness guards | sequential frontend-state lens | 0.98 | `safe_auto -> review-fixer`, applied |

### Applied Fixes

- Compose `pull/up` always receives an isolated temporary Docker configuration, even for anonymous execution. Directory/file modes are `0700`/`0600`, and setup, success, failure, and timeout paths clean up temporary material.
- Plaintext, escaped, URL-encoded, Basic-auth, and Engine-auth credential representations are redacted before output truncation, including approval failure metadata.
- Empty Registry passwords retain existing secrets in both API and repository updates. Usernames reject colon/control characters incompatible with Basic authentication.
- Centralized browser-safe parsing validates image references and Registry aliases, preserves explicit port `80`, and supports IPv6 without credential fallback.
- Container creation validates before creating audit records and resolves current credentials only when pulling.
- Image removal inspects the target ID, checks stopped and running container references, and retains `force=false` and `noprune=true`.
- Image lists request shared size and container information. Unknown shared sizes map to `null` and display a dash.
- New modals use a scoped layer above notifications. Loading/submission/Engine guards prevent repeated or conflicting actions.
- Compose tests allow ordinary subprocess startup and retain a separate timeout-cleanup regression.

### Plan Coverage

- Met: shared image/Registry contracts and single-query image summary.
- Met: restricted SQLite setting records, stable UUIDs, normalized-address uniqueness, secret-preserving updates, and sanitized public results.
- Met: manual and automatic Engine pulls with optional current credentials, plus non-force confirmed removal outside approvals.
- Met: Compose execution-time credential loading and child-only temporary `DOCKER_CONFIG`.
- Met: image search/detail/pull/delete and Registry CRUD interfaces with bilingual copy and narrow-screen layouts.
- Met: API, workspace, status/capability, and security documentation.
- Met: unit/API/integration-fixture checks and desktop/520px browser regression. Real-host acceptance remains a release advisory, not a completed test.

### Residual Actionable Work

None. No unresolved code finding is assigned to a downstream resolver, so no todo files were created.

### Coverage

- Formal `ce:review` diff scope excluded untracked files without staging them. Supplementary main-thread inspection covered the new image modules: `docker-registry.ts`, Registry repository, `DockerImageManagement.tsx`, browser helpers, shared parser, and their tests. Earlier untracked daemon modules remain preserved and have their own review record.
- No subagents were dispatched. Historical suppression/drop counts were not retained across the continuation; no unverified aggregate count is asserted here.
- Full gates passed: `npm run typecheck`, `npm run lint`, `npm test` (77 Vitest files, 514 tests, plus documentation tests), and `npm run build`.
- Playwright regression passed at desktop and 520px: Registry CRUD/empty-password edits, search, pull validation/failure/lock/success, multi-tag details/removal, occupied-image rejection, and Engine availability transitions. No browser runtime errors were observed.
- Screenshots and the browser script are ignored local verification output under `.zos/verification`; they were not staged.
- Local Docker management is disabled. Browser Engine responses were simulated; actual private Registry pulls and Compose behavior need Linux acceptance.
- Registry secrets remain unencrypted inside restricted SQLite by the approved design. Device-state backups can contain them; do not expose database or temporary configuration contents in diagnostics.
- This feature does not broaden helper, systemd capabilities, daemon configuration, internet exposure, or authentication boundaries. Existing daemon-related worktree changes are outside this feature's privilege scope.

### Operational Advisory

- On the Linux target, verify private Engine pulls, automatic container pulls, and Compose `pull/up` with multiple Registries.
- Rotate/delete credentials between approval and execution and confirm that the latest store is used.
- Confirm occupied-image removal returns `409` and temporary Compose authentication directories are removed after failure/timeout.
- No remote deployment, commit, push, or release was performed for this implementation request.

---

> **Verdict:** Ready with fixes.
>
> **Reasoning:** All recorded code findings are resolved and local quality/browser gates pass. Real-host Registry/Compose acceptance is still required before claiming deployment validation.
