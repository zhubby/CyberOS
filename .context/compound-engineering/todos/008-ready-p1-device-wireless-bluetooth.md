---
status: complete
priority: p1
issue_id: "008"
tags: [devices, wifi, bluetooth, bluez, obex, audio]
dependencies: []
---

# Device Wireless And Bluetooth Management

## Problem Statement

ZOS needs a dedicated Devices settings group. Wi-Fi management must move out of the read-only network panel, while Bluetooth needs complete adapter/device management followed by controlled audio output and NAS-backed file transfer.

## Findings

- The Wi-Fi migration and BlueZ D-Bus management are complete in the current working tree.
- hostd provides bounded discovery, pairing challenges and asynchronous failures, focused tests, and regenerated protocol bindings.
- The second phase is implemented across database settings, VOD audio routing, NAS path safety, persistent transfer state, OBEX, web UI, systemd, and Debian packaging.
- Existing storage-scope, mount-readiness, operation-notification, and SSE patterns are reused.

## Proposed Solutions

### Option 1: Staged Native Services

**Approach:** Finish hostd device control, then add persisted Bluetooth preferences, validated VOD audio IDs, and a non-root `zos-bluetoothd` service for OBEX queues and the trusted-device inbox.

**Pros:** Preserves least privilege, gives durable transfer state, and follows the approved two-stage plan.

**Cons:** Requires coordinated changes across Rust, TypeScript, SQLite, systemd, and the web UI.

**Effort:** Large

**Risk:** High

## Recommended Action

Implement Option 1 serially. Keep hostd responsible for privileged BlueZ adapter/device control, VOD responsible for validated playback selection and fallback, and `zos-bluetoothd` responsible for OBEX transfer lifecycle under the `zos` user.

## Technical Details

Affected areas include `apps/hostd`, `apps/api`, `apps/web`, `apps/vod-player`, `packages/shared`, `packages/db`, `packages/nas-tools`, `packaging`, and Bluetooth/network documentation.

## Acceptance Criteria

- [x] Wi-Fi management exists only in Devices settings; the network panel is read-only and radio-aware.
- [x] BlueZ adapter, discovery, pairing challenge, trust, connection, and unpair operations are typed, tested, and observable.
- [x] Discovery stops automatically after about 15 seconds and asynchronous pairing failures reach status/UI.
- [x] Bluetooth settings persist default adapter, audio target, receive toggle, and inbox scope without copying BlueZ secrets.
- [x] VOD accepts only enumerated Bluetooth audio IDs and falls back to existing output with an observable reason.
- [x] Multi-file OBEX send queues and trusted-device receive use persistent records, SSE progress, notifications, and NAS safety checks.
- [x] `zos-bluetoothd`, BlueALSA, OBEX, D-Bus, Debian/appliance, localization, and documentation changes are complete.
- [x] Focused tests, full repository checks, build, and responsive browser verification pass.
- [x] Full code review is completed and residual findings are resolved or recorded.

## Work Log

### 2026-10-20 - Continued Implementation

**By:** Codex

**Actions:**
- Recovered the completed first-phase implementation state.
- Identified remaining hostd reliability work and second-phase service boundaries.
- Began focused testing and implementation in dependency order.

**Learnings:**
- Existing working-tree changes include unrelated MCP/capability work and must be preserved.
- Runtime Bluetooth state remains authoritative in BlueZ; SQLite stores only user preferences and transfer records.

### 2026-10-20 - Verification And Completion

**By:** Codex

**Actions:**
- Completed both planned phases, including Wi-Fi migration, BlueZ device management, Bluetooth audio fallback, and persistent OBEX send/receive flows.
- Completed the full code review and resolved all P0-P3 findings.
- Exercised the responsive UI headlessly at 1440px, 820px, 560px, 390px, and 320px, including English and Simplified Chinese, pairing, transfers, notifications, and unavailable/error states.
- Fixed the browser-discovered pairing overlay, compact Ethernet layout, radio-off Wireless controls/stale scan state, and Network description issues.
- Passed `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run protocol:check`, and `npm run version:check`.

**Learnings:**
- Local mocks and headless coverage validate UI and protocol behavior, but real BlueZ hardware, OBEX peers, BlueALSA output, Debian installation, and appliance boot still require target-device acceptance testing.
- Development services can contend with VOD timeout tests; the final clean full-suite run passed after the development server was stopped.

## Notes

- Do not commit or push without explicit user direction.
- No-Bluetooth hosts must remain healthy and display an actionable unavailable state.
