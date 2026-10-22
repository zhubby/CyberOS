# ZOS TV Gamepad Input Review

- Mode: autofix
- Scope: `main..4e0425201cd9c6b33dce0309096367dc0df13f3a`, including TV gamepad support and the CM5 TV runtime restoration fixes released as `1.5.19`
- Intent: add optional generic evdev gamepad control for the Chromium TV shell and fullscreen mpv without making CEC or a connected controller a TV startup dependency
- Verdict: ready to merge; no unresolved P0-P3 code findings and CM5 release validation passed

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

- Built `zos_1.5.19_arm64.deb` natively on the CM5 and verified its SHA256, build metadata, gamepad binary, CEC script, and systemd unit before deployment.
- The managed deployment completed successfully and restored the enabled and active TV target. Core services, storage readiness, system health, monitoring, and the committed legacy migration state remained healthy.
- A deliberate TV target stop left Weston, Chromium, and CEC with `Result=success` and no failed units. Restarting the target returned all five TV services to active and `/api/tv/status` to ready.
- Browser acceptance confirmed `v1.5.19` and commit `4e0425201cd9c6b33dce0309096367dc0df13f3a`, rendered Gamepad health in Media settings, completed a Bluetooth scan, and received the exact Agent reply `验收通过` in a new session.
- No supported physical gamepad was connected during release acceptance, so button mappings and reconnect behavior on real Xbox hardware remain a residual hardware check rather than a release blocker.

## Coverage

- Final local `make check` passed at `1.5.19`; the CM5 native Debian build also passed Rust release builds and tests, Web/API/Worker/Docs builds, 169 Vitest files with 1078 tests, and 5 documentation tests.
- Focused tests cover gamepad capability detection, mappings, hysteresis, repeat, button deduplication, multiple devices, health recovery, hostd pairing policy, API status, UI status, and packaging declarations.
- Headless Chromium verification passed at 1920x1080 and 390x844. The TV shell and F8 search rendered without overflow or console errors; media settings exposed Gamepad health; and a page-local Xbox status fixture rendered the Gamepad2 icon, Paired/Trusted/Connected badges, and trust, disconnect, send, and forget actions without layout overlap.
- Nix could not be run locally because it is not installed on this macOS host; native Linux CI remains authoritative for `nix flake check` and the NixOS VM test.
- Residual risk: the CM5 BlueZ adapter, Weston compositor, CEC device, Chromium shell, and disconnected Gamepad service were exercised, but no physical Xbox controller was available to validate evdev mappings or reconnect behavior.
- Suppressed findings: 0.
- Failed reviewers: 0; project instructions required the reviewer lenses to run sequentially in the main thread.

---

> **Verdict:** Ready to merge
>
> **Reasoning:** The code and repository gates are clean, the native arm64 package deployed successfully, and host plus browser acceptance passed. The remaining uncertainty is limited to input from a physically connected gamepad.
