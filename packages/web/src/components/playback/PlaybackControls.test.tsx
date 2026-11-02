import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MusicPlayerStatus } from "@cyberos/shared";
import { initI18n } from "../../i18n/index.js";
import { PlaybackBar } from "./PlaybackBar.js";
import { PlaybackMenu } from "./PlaybackMenu.js";
import { PlaybackControls, usePlaybackControls } from "./PlaybackControls.js";
import { usePlayback } from "./PlaybackProvider.js";
import { useMusicRemote } from "../music/MusicProvider.js";

vi.mock("./PlaybackProvider.js", () => ({ usePlayback: vi.fn(), useOptionalPlayback: vi.fn(() => null) }));
vi.mock("../music/MusicProvider.js", () => ({ useMusicRemote: vi.fn() }));

const track = { id: "item-1", trackId: "track-1", storagePoolId: "pool-1", relativePath: "song.flac", title: "Retained song", artist: "Artist", album: null, durationSeconds: 180, coverKey: null };
const status: MusicPlayerStatus = {
  owner: null, state: "idle", sessionId: null, serviceInstanceId: "instance-1", revision: 2, queueVersion: 3,
  queue: [], currentItemId: null, repeat: "off", shuffle: false, positionSeconds: 30, durationSeconds: null, volume: 80,
  audioDeviceId: null, effectiveAudioDeviceId: null, error: null, errorCode: null, updatedAt: "2026-11-02T00:00:00Z"
};
let playback: ReturnType<typeof usePlayback>;
let music: ReturnType<typeof useMusicRemote>;

function Surface() {
  const c = usePlaybackControls(false);
  return createElement(PlaybackControls, { c, variant: "menu" });
}

beforeEach(async () => {
  await initI18n();
  playback = {
    dock: { available: false, state: "idle" }, dockVisible: false, barExpanded: false, barVisible: false,
    collapseBar: vi.fn(), expandBar: vi.fn(), nas: null, error: null, browser: null, target: "nas", setTarget: vi.fn(),
    playerOpen: false, setPlayerOpen: vi.fn(), fullscreen: false, videoRef: createRef<HTMLVideoElement>(),
    refresh: vi.fn(async () => {}), control: vi.fn(async () => {}), playBrowser: vi.fn(async () => {}),
    stopBrowser: vi.fn(), toggleBrowser: vi.fn(async () => {}), updateBrowser: vi.fn()
  };
  music = { status: { ...status }, busy: false, error: null, libraryVersion: 0, drawerOpen: false, setDrawerOpen: vi.fn(), execute: vi.fn(async () => {}), refresh: vi.fn(async () => {}) };
  vi.mocked(usePlayback).mockImplementation(() => playback);
  vi.mocked(useMusicRemote).mockImplementation(() => music);
});

describe("sidebar playback", () => {
  it.each(["idle", "playing", "paused", "error"] as const)("keeps the %s entry available and initially closed", (state) => {
    if (state !== "idle") music.status = { ...status, owner: "music", queue: [track], currentItemId: track.id, state, error: state === "error" ? "Output lost" : null };
    const html = renderToStaticMarkup(createElement(PlaybackMenu, { onOpenBluetoothSettings: vi.fn() }));
    expect(html).toContain(`data-playback-state="${state}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("playback-menu-indicator");
    expect(html).not.toContain('class="playback-menu"');
    expect(html).not.toContain('class="playback-shell"');
    expect(html).not.toContain('disabled=""');
    expect(playback.control).not.toHaveBeenCalled();
    expect(playback.toggleBrowser).not.toHaveBeenCalled();
    expect(music.execute).not.toHaveBeenCalled();
  });

  it("shows the empty state, including service errors with no active session", () => {
    expect(renderToStaticMarkup(createElement(Surface))).toContain("No playback");
    playback.error = "NAS unavailable";
    const html = renderToStaticMarkup(createElement(Surface));
    expect(html).toContain('data-playback-state="error"');
    expect(html).toContain("No playback");
    expect(html).toContain('role="alert">NAS unavailable');
  });

  it("retains music controls when ownership has been released", () => {
    music.status = { ...status, state: "paused", queue: [track], currentItemId: track.id };
    const html = renderToStaticMarkup(createElement(Surface));
    expect(html).toContain('data-playback-state="paused"');
    expect(html).toContain("Retained song");
    expect(html).toContain('aria-label="Play"');
    expect(html).toContain('aria-label="Queue"');
    expect(html).toMatch(/<input[^>]*disabled[^>]*aria-label="Playback position"/u);
  });

  it("starts with output settings collapsed and keeps volume and queue available", () => {
    music.status = { ...status, owner: "music", state: "playing", queue: [track], currentItemId: track.id };
    const html = renderToStaticMarkup(createElement(Surface));
    expect(html).toContain('aria-label="Volume"');
    expect(html).toContain('aria-label="Queue"');
    expect(html).toContain('aria-label="Audio output: NAS default output"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Switch output");
    expect(html).not.toContain('class="playback-output-fields"');
    expect(playback.control).not.toHaveBeenCalled();
    expect(music.execute).not.toHaveBeenCalled();
  });

  it("summarizes effective output instead of the requested device", () => {
    music.status = { ...status, owner: "music", state: "paused", queue: [track], audioDeviceId: "bluetooth:pending-speaker", effectiveAudioDeviceId: null };
    const html = renderToStaticMarkup(createElement(Surface));
    expect(html).toContain('aria-label="Audio output: NAS default output"');
    expect(html).not.toContain("pending-speaker");
    music.status.effectiveAudioDeviceId = "bluetooth:actual-speaker";
    expect(renderToStaticMarkup(createElement(Surface))).toContain('aria-label="Audio output: Bluetooth audio output"');
  });

  it("does not imply a default output when the device is unavailable or unreported", () => {
    music.status = { ...status, state: "error", queue: [track], error: "Speaker lost", errorCode: "AUDIO_UNAVAILABLE", audioDeviceId: "bluetooth:lost-speaker" };
    const unavailable = renderToStaticMarkup(createElement(Surface));
    expect(unavailable).toContain('aria-label="Audio output: Configured speaker unavailable"');
    expect(unavailable).toContain('role="alert">Speaker lost');
    music.status = { ...status, queue: [track] };
    expect(renderToStaticMarkup(createElement(Surface))).toContain('aria-label="Audio output: Output not reported"');
  });

  it("shows the selected browser target independently of NAS music", () => {
    music.status = { ...status, owner: "music", state: "playing", queue: [track] };
    playback.target = "browser";
    playback.browser = {
      fileId: "file-1", title: "Browser movie", options: {}, position: 42, playing: false, volume: 0.6, muted: false,
      session: { id: "stream-1", fileId: "file-1", mode: "direct", state: "ready", url: "/movie.mp4", durationSeconds: 120, startPositionSeconds: 0, error: null, tracks: [], audioTrack: null, subtitleTrack: null, reason: null }
    };
    const html = renderToStaticMarkup(createElement(Surface));
    expect(html).toContain('data-playback-kind="browser"');
    expect(html).toContain('data-playback-state="paused"');
    expect(html).toContain("Browser movie");
    expect(html).toContain("Browser audio output");
    expect(html).not.toContain('aria-label="Previous song"');
    expect(html).not.toContain("<video");
    expect(html).not.toContain("Switch output");
  });

  it("retains the TV collapse preference and bottom restore entry", () => {
    playback.dock = { available: true, state: "paused" };
    playback.dockVisible = true;
    music.status = { ...status, queue: [track], currentItemId: track.id };
    const collapsed = renderToStaticMarkup(createElement(PlaybackBar, { onOpenBluetoothSettings: vi.fn() }));
    expect(collapsed).toContain('class="playback-shell is-collapsed"');
    expect(collapsed).toContain("data-playback-restore");
    expect(collapsed).not.toContain('class="shared-player-bar"');
    playback.barVisible = true;
    const expanded = renderToStaticMarkup(createElement(PlaybackBar, { onOpenBluetoothSettings: vi.fn() }));
    expect(expanded).toContain('class="shared-player-bar"');
    expect(expanded).toContain("Retained song");
    expect(expanded).toContain('aria-label="Collapse player"');
    expect(expanded).not.toContain("data-playback-restore");
  });
});
