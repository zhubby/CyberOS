# Device Wireless And Bluetooth Review

- Mode: interactive autofix
- Scope: device settings, Wi-Fi migration, BlueZ/hostd, Bluetooth transfer, VOD audio, database, Web, documentation, and packaging changes in the current dirty working tree on `main`
- Intent: implement the user-provided two-stage device wireless and Bluetooth plan
- Untracked scope: all new Bluetooth, Wi-Fi read-only, browser shared-entry, test, and systemd files were manually included even though the default tracked diff omits them
- Verdict: ready after verification; no unresolved P0-P3 findings remain

## Findings

No unresolved findings remain after the autofix pass.

## Requirements Completeness

- Met: `Settings > Devices` contains Wireless and Bluetooth pages with localized search metadata.
- Met: Wi-Fi mutation, saved network, hotspot, and radio controls moved to Wireless settings; the network panel is read-only, auto-scans only while enabled, and clears stale scan results when disabled.
- Met: BlueZ D-Bus status, multi-adapter selection, bounded scanning, pairing challenges, trust, connection, disconnection, and forgetting are implemented through hostd with strict protocol parsing.
- Met: Bluetooth preferences persist only user-selected adapter, audio, and inbox settings; BlueZ remains authoritative for pairing and trust.
- Met: persistent OBEX send/receive queues enforce NAS path, mount, symlink, trust, free-space, cancellation, cleanup, and collision rules.
- Met: VOD accepts only stable enumerated Bluetooth audio IDs, applies them to the next playback, verifies the output actually opened, and falls back to system ALSA/HDMI with visible status.
- Met: Debian, appliance, systemd, documentation, localization, database migration, notifications, and protocol fixtures cover both phases.

## Applied Fixes

- Bound pairing responses to the exact challenge, adapter, and device, and serialized multi-adapter discovery windows.
- Moved pairing challenges ahead of adapter controls, added alert-dialog semantics and focus, and cleared stale PIN input.
- Distinguished unknown Wi-Fi radio state from an explicitly disabled radio.
- Preserved receiving preferences while exposing storage-offline, invalid-directory, permission, and free-space pause reasons.
- Removed interrupted receive partial files during transfer-service recovery and refreshed service health during progress.
- Added a browser-safe `@zos/shared` entry so Vite does not bundle Node-only modules.
- Kept Bluetooth inbox settings readable and writable when BlueZ/hostd is offline while retaining live validation for adapter and audio selections.
- Added strict runtime parsing for Bluetooth transfer SSE payloads and local validation for malformed Bluetooth API requests.
- Rejected unknown Bluetooth hostd request fields before deserialization.
- Allowed `AF_BLUETOOTH` in the OBEX service sandbox and made VOD request BlueZ and BlueALSA services.
- Verified mpv obtained real audio output parameters before accepting Bluetooth audio startup, enabling the existing fallback when ALSA silently continues without sound.
- Made the pairing challenge surface opaque while sticky so scrolled device controls cannot show through it.
- Preserved the compact Ethernet apply layout at 320px by raising the container-query selector specificity above the generic action-row rule.
- Disabled Wireless scan and hotspot controls while the Wi-Fi radio is off, cleared stale scan results on shutdown, and added a regression test.
- Updated the Network panel description in English and Simplified Chinese to describe its read-only Wi-Fi role.

## Learnings & Past Solutions

- No `docs/solutions/` directory or applicable project solution record exists.

## Agent-Native Gaps

- The feature has typed local HTTP APIs, but Bluetooth operations are not yet first-class entries in the separate MCP capability catalog. This was not part of the explicit device-settings plan and does not block this delivery.

## Schema Drift Check

- Migration `036_bluetooth_transfers` adds only Bluetooth transfer and service-health state. Existing migration ordering and schema tests cover it; no unrelated schema drift was identified.

## Deployment Notes

- Back up SQLite before upgrading because migration 036 has no reverse migration.
- Verify `bluetooth.service`, `bluealsa.service`, `zos-hostd.service`, `zos-bluetoothd.service`, and `zos-vod-player.service` on the target appliance.
- Exercise one real pairing challenge, trusted receive, multi-file send, Bluetooth playback, disconnect fallback, and inbox-offline pause before release.
- Confirm the installed `bluez-obexd`, `bluez-alsa-utils`, `libasound2-plugin-bluez`, and user-session D-Bus packages expose their expected Debian units and activation files.

## Coverage

- Headless browser verification passed at 1440px, 820px, 560px, 390px, and 320px with no horizontal overflow.
- Browser coverage included Wireless radio on/off, scan, saved profiles, hotspot management, read-only Network Wi-Fi, Bluetooth unavailable and multi-adapter states, pairing challenge focus, trust/connect actions, audio fallback, inbox pause reasons, file selection, transfer queue states, notifications, and English/Simplified Chinese copy.
- Focused Wi-Fi regression tests passed: 2 tests in `SystemWifiManagement.test.ts`.
- Final repository verification passed: `npm run typecheck`, `npm run lint`, `npm test` (163 Vitest files, 1059 passed and 5 skipped, plus Rust and docs tests), `npm run build`, `npm run protocol:check`, and `npm run version:check`.
- Residual environment risk: no real Bluetooth adapter, OBEX peer, BlueALSA device, Debian package installation, or appliance boot was available in this local review.
- Suppressed findings: 0.
- Failed reviewers: 0; project instructions required the reviewer lenses to run sequentially in the main thread.
