import { describe, expect, it } from "vitest";
import { getPlaybackDockState, readPlaybackBarExpanded, writePlaybackBarExpanded } from "./playback-dock-state.js";

describe("playback dock presentation", () => {
  const music = { queue: [], state: "paused", error: null } as const;
  const video = { state: "playing", error: null } as const;
  const browser = { playing: true, session: { state: "ready", error: null } } as const;

  it("has no restore entry without a session or recoverable queue", () => {
    expect(getPlaybackDockState({ nas: null, browser: null, target: "nas", error: null })).toEqual({ available: false, state: "idle" });
  });

  it("retains a paused queue after NAS ownership is released", () => {
    expect(getPlaybackDockState({ nas: { owner: null, music: { ...music, queue: ["retained"] }, video }, browser: null, target: "nas", error: null })).toEqual({ available: true, state: "paused" });
  });

  it("shows the selected target without borrowing another target's playing state", () => {
    const nas = { owner: "music", music, video } as const;
    expect(getPlaybackDockState({ nas, browser, target: "nas", error: null }).state).toBe("paused");
    expect(getPlaybackDockState({ nas, browser, target: "browser", error: "NAS offline" }).state).toBe("playing");
  });

  it("retains NAS playback and errors when the browser session is absent", () => {
    const nas = { owner: "video", music, video } as const;
    expect(getPlaybackDockState({ nas, browser: null, target: "browser", error: null }).state).toBe("playing");
    expect(getPlaybackDockState({ nas: { ...nas, video: { ...video, error: "Output lost" } }, browser: null, target: "nas", error: null }).state).toBe("error");
  });

  it("keeps failed browser sessions accessible", () => {
    expect(getPlaybackDockState({ nas: null, browser: { ...browser, session: { state: "error", error: "Stream failed" } }, target: "browser", error: null })).toEqual({ available: true, state: "error" });
  });
});

describe("tab-local playback dock preference", () => {
  it("defaults to expanded and restores collapse across refreshes", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readPlaybackBarExpanded(storage)).toBe(true);
    writePlaybackBarExpanded(storage, false);
    expect(readPlaybackBarExpanded(storage)).toBe(false);
    writePlaybackBarExpanded(storage, true);
    expect(readPlaybackBarExpanded(storage)).toBe(true);
  });

  it("does not break playback if browser storage is blocked", () => {
    const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readPlaybackBarExpanded(storage)).toBe(true);
    expect(() => writePlaybackBarExpanded(storage, false)).not.toThrow();
  });
});
