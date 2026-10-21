import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { VodPlayerStatus } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { VodPlayerControls } from "./VodPlayerControls.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

const status: VodPlayerStatus = {
  state: "playing",
  sessionId: "session-1",
  serviceInstanceId: "instance-1",
  revision: 4,
  rootId: "local",
  storagePoolId: "pool",
  relativePath: "movies/clip.mp4",
  fileName: "clip.mp4",
  mediaFileId: null,
  videoOutput: "drm",
  positionSeconds: 30,
  durationSeconds: 120,
  volume: 75,
  retryCount: 0,
  nextRetryAt: null,
  audioDeviceId: null,
  effectiveAudioDeviceId: null,
  audioFallbackReason: null,
  audioTracks: [],
  subtitleTracks: [],
  selectedAudioTrackId: null,
  selectedSubtitleTrackId: null,
  capabilities: { mpvAvailable: true, drmAvailable: true, audioAvailable: true, hardwareDecode: "enabled", error: null },
  error: null,
  errorCode: null,
  updatedAt: "2026-09-15T00:00:00.000Z"
};

describe("VodPlayerControls", () => {
  it("renders stable busy controls", () => {
    const html = renderToStaticMarkup(createElement(VodPlayerControls, {
      status,
      busy: true,
      onCommand: vi.fn(),
      onRetry: vi.fn()
    }));
    expect(html).toContain("clip.mp4");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("vod-player-controls");
  });

  it("renders recovery state and retry metadata", () => {
    const html = renderToStaticMarkup(createElement(VodPlayerControls, {
      status: { ...status, state: "recovering", retryCount: 2, nextRetryAt: new Date(Date.now() + 2_000).toISOString() },
      busy: false,
      onCommand: vi.fn(),
      onRetry: vi.fn()
    }));
    expect(html).toContain("vod-player-message");
    expect(html).toContain("is-recovering");
  });

  it("explains Bluetooth audio fallback", () => {
    const html = renderToStaticMarkup(createElement(VodPlayerControls, {
      status: { ...status, audioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF", audioFallbackReason: "BlueALSA device unavailable" },
      busy: false,
      onCommand: vi.fn(),
      onRetry: vi.fn()
    }));
    expect(html).toContain("Bluetooth audio was unavailable");
    expect(html).toContain("BlueALSA device unavailable");
  });

  it("exposes audio and subtitle track selection", () => {
    const html = renderToStaticMarkup(createElement(VodPlayerControls, {
      status: {
        ...status,
        audioTracks: [{ id: 1, language: "eng", title: "Stereo", default: true, forced: false, external: false }],
        subtitleTracks: [{ id: 2, language: "zho", title: "简体中文", default: true, forced: false, external: false }],
        selectedAudioTrackId: 1,
        selectedSubtitleTrackId: 2
      },
      busy: false,
      onCommand: vi.fn(),
      onRetry: vi.fn()
    }));
    expect(html).toContain("Audio track");
    expect(html).toContain("Stereo · ENG");
    expect(html).toContain("Subtitles off");
    expect(html).toContain("简体中文 · ZHO");
  });
});
