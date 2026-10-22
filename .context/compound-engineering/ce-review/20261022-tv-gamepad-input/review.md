# ZOS TV Gamepad Input Review

- Mode: autofix
- Scope: current dirty working tree on `main`, including the untracked `crates/tv-gamepad` crate and gamepad systemd unit
- Intent: add optional generic evdev gamepad control for the Chromium TV shell and fullscreen mpv without making CEC or a connected controller a TV startup dependency
- Verdict: no unresolved P0-P3 code findings; browser and CM5 hardware validation remain release gates

## Findings

No unresolved findings remain after the autofix pass.

## Requirements Completeness

- Met: capability-based `/dev/input/event*` discovery, one-second rescans, non-exclusive reads, hotplug recovery, multiple devices, button deduplication, stick hysteresis, and direction repeat are implemented.
- Met: Xbox-compatible navigation, confirm, back, seek, track, subtitle, and search mappings are shared by the browser shell and mpv reserved keys.
- Met: the sleep overlay consumes the first key press before navigation or playback behavior.
- Met: explicit Bluetooth pairing auto-trusts only BlueZ gamepad devices and attempts connection without rolling back a successful pair or trust operation.
- Met: `TvModeStatus.gamepad` is visible in the API, CLI status, media settings, and TV shell transitions while remaining optional in overall readiness.
- Met: Debian, appliance, Nix package/module, release versioning, documentation, and systemd hardening include the new binary and unit.
- Met: CEC and the five existing Weston/CEC CM5 hotfix files remain compatible and were not reverted.

## Applied Fixes

- Allowed health to recover when Wayland becomes available after the gamepad service starts.
- Gave TV notices one timer owner so a controller transition cannot erase a later playback failure.
- Prevented overflow while normalizing extreme evdev axis ranges.
- Bounded the evdev event queue and terminated `wtype` after two seconds.
- Added a real executable regression test for `wtype` failure followed by recovery.

## Learnings & Past Solutions

- The existing TV mode todo records the established kiosk, CEC, and CM5 deployment constraints; the implementation extends those boundaries without changing the required-component readiness contract.

## Agent-Native Gaps

- None. The feature is observable through the typed `/api/tv/status` contract and `zos-tv-mode status`; controller key injection itself is intentionally a local physical-input path.

## Deployment Notes

- Before deployment, build the arm64 Debian package and confirm `zos-tv-gamepad` plus `zos-tv-gamepad.service` are present in the artifact.
- After installation, verify `systemctl status zos-tv-gamepad.service`, `journalctl -u zos-tv-gamepad.service`, `/run/zos-tv/status/gamepad.json`, and `/api/tv/status`.
- Pair a real Xbox Series or Xbox One S controller from Web settings and confirm Paired, Trusted, and Connected, then exercise all mappings in both the library and mpv playback.
- Power-cycle the controller and reboot the CM5 with the controller off; TV mode must remain ready and controller input must recover without a service restart.
- Confirm controller, keyboard, and CEC input coexist without duplicate actions. Roll back by disabling the optional unit or installing the previous Debian package if input injection destabilizes the session.

## Coverage

- Full `make ci` passed after the final TypeScript timer fix, including protocol checks, Rust workspace tests, TypeScript and documentation checks, ESLint and Clippy, Vitest, and production builds.
- Focused tests cover gamepad capability detection, mappings, hysteresis, repeat, button deduplication, multiple devices, health recovery, hostd pairing policy, API status, UI status, and packaging declarations.
- Nix could not be run locally because it is not installed on this macOS host; native Linux CI remains authoritative for `nix flake check` and the NixOS VM test.
- Residual risk: no physical Xbox controller, target BlueZ adapter, CM5 evdev device, Weston compositor, or HDMI display is available in the local browser/test environment.
- Suppressed findings: 0.
- Failed reviewers: 0; project instructions required the reviewer lenses to run sequentially in the main thread.

---

> **Verdict:** Ready for browser and CM5 hardware validation
>
> **Reasoning:** The code and repository gates are clean. The remaining uncertainty is hardware and Linux runtime integration rather than an unresolved code finding.
