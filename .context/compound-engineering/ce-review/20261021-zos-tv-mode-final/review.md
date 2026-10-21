# Code Review Results

- Scope: `97c4372` to working tree, 76 implementation files plus 3 review/task records
- Intent: deliver a complete CM5 television mode with a ZOS-owned TV shell, native mpv playback, media administration, reversible desktop switching, packaging, health reporting, and operator documentation
- Mode: autofix
- Reviewers: correctness, testing, maintainability, project-standards, agent-native, learnings, security, performance, API-contract, reliability, adversarial, CLI-readiness, kieran-typescript, frontend-races

## Findings

All confidence-qualified findings were fixed during the review. No unresolved P0-P3 findings remain.

## Applied Fixes

| # | Severity | File | Issue | Reviewers | Confidence | Disposition |
|---|---|---|---|---|---|---|
| 1 | P1 | `packaging/scripts/zos-tv-mode:205` | Failed rollback deleted the only desktop restoration snapshot even when restoration failed. | correctness, reliability | 0.99 | Preserved the snapshot until restoration succeeds and added a functional failure test. |
| 2 | P1 | `packaging/systemd/zos-tv-prepare.service:12` | The Wayland runtime directory used mode `0750` instead of the required private `0700`. | correctness, security | 0.98 | Aligned Debian scripts, units, Nix, and packaging assertions on `0700`. |
| 3 | P1 | `packaging/systemd/zos-tv-weston.service:4` | Stopping `zos-tv.target` did not stop its Weston, Chromium, CEC, or preparation services. | correctness, reliability | 0.99 | Added `PartOf=zos-tv.target` across native and Nix service graphs. |
| 4 | P1 | `packaging/debian/prerm:5` | Package removal ignored desktop restoration failure and could remove the recovery command while HDMI remained black. | reliability, deployment | 0.96 | Package removal now aborts when TV disable cannot restore the previous runtime. |
| 5 | P1 | `packages/api/src/routes/media.ts:250` | TV library playback omitted the configured Bluetooth output device. | correctness, API-contract | 0.98 | Passed the selected device to native playback and asserted the command contract. |
| 6 | P1 | `packages/web/src/tv/TvApp.tsx:597` | Player polling repeatedly recreated the input effect, so the ten-minute idle screen timer could never expire. | correctness, frontend-races | 0.98 | Kept one listener/timer lifecycle and read current state through a ref. |
| 7 | P2 | `packages/web/src/tv/TvApp.tsx:463` | Older search requests could overwrite newer TV search results. | frontend-races, correctness | 0.97 | Added request cancellation with `AbortController`. |
| 8 | P2 | `packages/web/src/components/settings/SettingsMediaPage.tsx:79` | Polling could overwrite unsaved metadata form input, and stale candidate searches could cross title boundaries. | frontend-races, correctness | 0.97 | Added request sequencing and limited form synchronization to initial load. |
| 9 | P2 | `crates/vod-player/src/mpv.rs:440` | A configured DRM connector leaked into Wayland playback arguments. | correctness, reliability | 0.94 | Restricted connector arguments to DRM output and extended the Rust test. |
| 10 | P2 | `packages/web/src/tv/TvApp.tsx:123` | Completed titles were presented as resumable and restarted at the end position. | correctness | 0.95 | Completed progress now starts playback from the beginning and uses Play copy. |

## Requirements Completeness

- [x] Media sources and redacted TMDB settings are implemented.
- [x] The local-first catalog and deterministic match states remain integrated with the indexer.
- [x] The TV shell provides remote focus, details, seasons, search, offline Pinyin input, and idle black screen.
- [x] TV and Web clients share one VOD session with progress, audio-track, and subtitle controls.
- [x] Weston/Chromium TV mode is reversible and preserves prior desktop state.
- [x] CEC has explicit component health and keyboard fallback.
- [x] Unit, integration, browser, packaging, lint, type, and build checks pass.
- [x] CM5 documentation covers install, rollback, health, and 4K SDR acceptance.
- [x] No unresolved P0/P1 review findings remain.

## Coverage

- `make ci` passed after final fixes: protocol drift, typecheck, Astro diagnostics, ESLint, Clippy, all TypeScript/Rust/docs tests, and production build.
- Focused TV/API/packaging suite passed: 24 tests.
- Browser smoke passed at 1920x1080: full viewport, no overflow, initial Library focus, search open/back flow, and no application console or page errors.
- Shell syntax checks passed for TV scripts, maintainer scripts, installer, and appliance builder.
- No `docs/solutions/` directory exists, so there were no institutional solution documents to apply.
- Agent parity is present through media/TV/VOD APIs and the `zos-tv-mode` CLI; Nix hosts deliberately reject imperative mode changes.

## Residual Risk

- Nix is not installed on this host, so `nix flake check` and the NixOS VM assertions were not run locally.
- Real CM5 DRM, HDMI-CEC, hardware decoding, Bluetooth audio, and the documented 4K SDR soak test require deployment hardware validation.
- Vite reports the existing large-chunk warning; the build succeeds and the TV entry point remains functional.

## Verdict

Ready to merge. No confidence-qualified actionable findings remain; native Linux/Nix CI and CM5 hardware acceptance remain the authoritative deployment checks.
