# Code Review Results

- Scope: `3135463ff0a49ebf63c96a636f8f16524d155338` to the complete working tree. The Rust crate, alert routes, repository, shared contracts, Web views, metrics contracts, and alerter unit were untracked and were manually included in the review scope.
- Intent: replace the Node monitor with layered Rust `zos-monitor` and `zos-alerter` processes while preserving metrics schema v3, and add first-phase alert evaluation, escalation, SMTP outbox, API, Web, packaging, and documentation support.
- Mode: headless review executed sequentially because repository instructions prohibit subagents.
- Reviewers: correctness, testing, maintainability, project standards, agent-native, learnings, security, performance, API contract, data migrations, reliability, adversarial, and TypeScript.

## Findings

No residual P0-P3 findings after confidence gating and the implementation review fixes.

## Applied Fixes

- Added migration `031_monitoring_unsilenced_event` without changing historical migration `028`, preserving event rows during upgrade.
- Made escalation delivery identities unique across silence expiry/cancellation restart epochs.
- Added controlled `409` conflicts when referenced contacts, groups, schedules, or policies are deleted.
- Added bounded `systemctl` execution, independent evaluation/delivery loops, ack-aware retry cancellation, configured stale cadence, and direct validated-IP plaintext SMTP delivery.
- Moved configuration value objects and production assembly to restore the intended domain/application/ports/adapters/runtime dependency direction.

## Learnings & Past Solutions

- No `docs/solutions/` directory or directly applicable prior solution was present.

## Agent-Native Gaps

- None. Monitoring and alert actions are exposed through stable HTTP APIs in addition to the Web UI.

## Schema Drift Check

- Clean. Migrations `028`-`031`, repository expectations, and fresh/upgrade schema tests agree; migration `031` preserves existing incident event rows and indexes.

## Deployment Notes

- Pre-deploy: run API migrations through `031` before starting `zos-alerter`; the alerter intentionally retries while the schema is unavailable.
- Verify: both Rust binaries are installed, `zos-monitor.service` and `zos-alerter.service` remain active, and `monitoring_alerter_state.last_evaluation_at` advances.
- Rollback: stop alerter first. The old TypeScript monitor can continue reading metrics schema v3; alert tables and derived series remain but are ignored.
- Monitor: metrics WAL/database size, pending delivery count, daemon CPU/RSS, collector failures, query latency, and incident continuity through restarts.

## Verification

- `make ci` passed on the final source tree.
- Rust workspace tests passed, including 41 monitor/alerter tests and golden TypeScript/Rust metrics parity.
- TypeScript typecheck, Clippy/ESLint, Vitest, documentation checks, production builds, and packaging tests passed.
- Runtime API checks passed for migration `031`, monitoring overview, rules, and incidents after restarting both Rust daemons against `.zos/dev-root`.
- Browser checks passed at 1440, 820, 560, 390, and 320 px in light and dark themes with no console errors or document-level horizontal overflow.
- `git diff --check` passed. Production `application` code has no dependency on `adapters` or `runtime`; the two matches are test-only imports.

## Residual Risks

- macOS cannot provide Linux `/proc` or systemd data, so host/systemd collectors correctly remain degraded in local runtime verification.
- The required 24-hour CM5 soak, average CPU below 1% per daemon, 256 MiB memory ceiling, restart continuity under appliance load, and production query latency below 500 ms were not validated locally.
- SMTP TLS modes were unit tested with local fixtures; production certificate, DNS, and relay policy still require target-environment acceptance.

## Verdict

Ready for CM5 soak and deployment acceptance. No unresolved code-review finding blocks that stage.
