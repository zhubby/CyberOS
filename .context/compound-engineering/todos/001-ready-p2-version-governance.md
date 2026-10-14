---
status: complete
priority: p2
issue_id: "001"
tags: [release, versioning, observability, web]
dependencies: []
---

# Add ZOS Version Governance And Traceability

## Problem Statement

ZOS is fixed at version `0.1.0` across npm workspaces, Debian packaging, and the appliance manifest. Built installations do not expose enough immutable source and build metadata for operators to identify the exact deployed release.

## Findings

- The monorepo uses one release artifact but repeats the version across root/workspace manifests and internal dependency declarations.
- GitHub Actions already publishes `v*` tags and validates only the Debian changelog version.
- Debian staging excludes `.git`, so production traceability must be generated before or explicitly supplied during staging.
- The existing settings modal has grouped sections and system-information cards suitable for a dedicated version category.

## Proposed Solutions

### Option 1: Unified SemVer With Generated Build Metadata

**Approach:** Treat the root package version as canonical, synchronize all release manifests with a checked release script, generate immutable build metadata, expose it through the API, and display it in a dedicated settings section.

**Pros:**
- One product version across all components and artifacts
- Deterministic release validation and useful production diagnostics
- Fits the existing Git tag and Debian package workflow

**Cons:**
- Requires coordinated changes across scripts, API, UI, packaging, and CI

**Effort:** 4-6 hours

**Risk:** Medium

### Option 2: Independent Workspace Versions

**Approach:** Version every app and package independently.

**Pros:**
- Precise library-level release history

**Cons:**
- Adds release complexity without value because workspaces are not published independently

**Effort:** 6-10 hours

**Risk:** High

## Recommended Action

Implement Option 1 with SemVer, a manual `release` command, strict version consistency checks, build-time metadata, a read-only API, and a dedicated settings category. Establish `0.2.0` as the first governed version.

## Technical Details

**Affected areas:**
- Root and workspace npm manifests
- Release/build scripts and generated metadata contract
- Shared types, Fastify routes, and tests
- React settings navigation, version page, responsive styling, and i18n
- Debian/appliance packaging, GitHub Actions, and deployment documentation

**Database changes:** None.

## Acceptance Criteria

- [x] A release command synchronizes the unified SemVer across all required manifests and internal dependencies.
- [x] CI can verify version consistency and tagged release identity.
- [x] Builds record version, commit, tag/branch, time, source, and dirty status without requiring Git at runtime.
- [x] `/api/system/build-info` exposes only the public build metadata contract with graceful unknown values.
- [x] Settings contains a dedicated localized version category; no version is added to the main workspace.
- [x] Debian and appliance builds consume the dynamic product version and preserve metadata.
- [x] Focused tests plus typecheck, lint, full tests, and build pass.
- [x] UI is checked in a browser at desktop and mobile sizes.
- [x] Code review is completed and actionable findings are resolved.

## Work Log

### 2026-09-14 - Implementation Started

**By:** Codex

**Actions:**
- Audited current version sources, package workflow, API system information, and settings UI.
- Chose unified SemVer, manual release preparation, full build metadata, and a dedicated settings category.

**Learnings:**
- The existing release workflow and settings architecture can be extended without replacing either subsystem.

### 2026-09-14 - Implementation And Review Completed

**By:** Codex

**Actions:**
- Unified the product at `0.2.0` and added release preparation, consistency checks, build metadata generation, API exposure, packaging propagation, and the dedicated settings version page.
- Added monotonic version validation and direct-main-push CI coverage during autofix review.
- Rejected invalid build timestamps at the API boundary so malformed metadata cannot crash the web formatter.
- Verified English and Simplified Chinese layouts at desktop and 390px mobile widths.
- Passed `npm run version:check`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `git diff --check`.

**Learnings:**
- Runtime provenance should be generated before packaging because Debian staging intentionally excludes `.git`.
- Version-policy CI needs an explicit base for both pull requests and direct branch pushes.

## Notes

- The implementation must not automatically commit, tag, push, or publish.
- Unknown build metadata must not prevent development or production startup.
