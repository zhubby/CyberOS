---
status: ready
priority: p1
issue_id: "009"
tags: [cm5, tv, media-library, hdmi, cec, frontend, packaging]
dependencies: []
---

# Build ZOS TV Mode For CM5

## Problem Statement

The deployed CM5 currently exposes a Debian desktop over HDMI. ZOS can play a
selected video through its VOD service, but it has no appliance-style local UI
for browsing and playing a managed movie and series library with a TV remote.

## Findings

- `zos-vod-player` already owns playback state and can launch mpv through
  DRM/KMS, but selection and controls live in the desktop Web UI.
- The generic file index has no movie, series, season, episode, artwork, or
  match-correction model.
- The package does not manage a kiosk compositor, browser shell, CEC input, or
  reversible display-manager state.
- Product decisions are captured in the approved ZOS TV implementation plan in
  the originating Codex task.

## Proposed Solutions

### Option 1: ZOS TV Shell

**Approach:** Add a dedicated React TV entry point, a separate media catalog,
Wayland kiosk services, CEC navigation, and integrate them with the existing
mpv VOD daemon.

**Pros:** One ZOS media library and playback state; reuses current Web, API,
database, packaging, and VOD patterns.

**Cons:** Cross-cutting implementation and real CM5 hardware validation.

**Effort:** Large

**Risk:** High

### Option 2: Kodi Integration

**Approach:** Launch Kodi as the local frontend and leave ZOS as a separate
management plane.

**Pros:** Mature playback and CEC support.

**Cons:** Duplicates media state and bypasses the existing ZOS player model.

**Effort:** Medium

**Risk:** Medium

## Recommended Action

Implement Option 1 as the approved product direction. Deliver a vertical slice
in dependency order: media persistence and scanner, API and settings, TV shell,
player protocol, then reversible kiosk packaging and CM5 validation.

## Technical Details

- Add isolated media catalog tables and repositories rather than extending the
  generic file index with scraper-specific state.
- Scope every media source and playback file through configured NAS roots and
  storage pools.
- Serve a separately built `/tv/` application from the existing API process.
- Run Chromium and mpv as Wayland clients in a non-root kiosk session.
- Preserve and restore the existing display manager when TV mode is disabled.

## Acceptance Criteria

- [ ] Administrators can configure movie and series source directories and a redacted TMDB token.
- [ ] The indexer creates a local-first movie and episode catalog with deterministic match states.
- [ ] `/tv/` supports remote-focus navigation, details, seasons, search, full offline Pinyin candidates, and idle black screen.
- [ ] TV and Web clients control one VOD session with progress, audio tracks, and subtitle tracks.
- [ ] TV mode starts a Wayland kiosk instead of the Debian desktop and can restore the previous desktop state.
- [ ] CEC navigation has explicit health reporting and keyboard fallback.
- [ ] Unit, integration, browser, packaging, build, lint, and type checks pass.
- [ ] CM5 documentation includes installation, rollback, health checks, and 4K SDR acceptance steps.
- [ ] Full code review completes with no unresolved P0/P1 findings.

## Work Log

### 2026-10-20 - Approved For Implementation

**By:** Codex

**Actions:**
- Inspected the existing VOD, indexer, Web, API, systemd, and appliance paths.
- Chose a ZOS-owned TV shell, explicit media sources, local metadata plus TMDB,
  CEC controls, offline Pinyin input, reversible desktop disablement, and 4K SDR
  as the first hardware target.

**Learnings:**
- Playback can extend the current mpv daemon, but DRM/KMS must move to Wayland
  while the persistent TV shell owns the display session.
- Media scraping requires a separate durable catalog and correction workflow.

## Notes

- Existing uncommitted VOD, Bluetooth, and MCP work must be preserved.
- Do not commit or push unless the user requests it.
