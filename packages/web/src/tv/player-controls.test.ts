import { describe, expect, it } from "vitest";
import type { VodPlayerStatus } from "@zos/shared";
import { gamepadConnectionTransition, playbackCommandForKey, vodPlayerPollDelay } from "./player-controls.js";

const status = {
  state: "playing",
  sessionId: "session-1"
} as VodPlayerStatus;

describe("TV player controls", () => {
  it("polls active playback faster than terminal states", () => {
    expect(vodPlayerPollDelay(status)).toBe(1_000);
    expect(vodPlayerPollDelay({ ...status, state: "stopped" })).toBe(5_000);
  });

  it("maps remote keys to session-scoped player commands", () => {
    expect(playbackCommandForKey(status, "MediaPlayPause")).toEqual({ type: "toggle-pause", sessionId: "session-1" });
    expect(playbackCommandForKey(status, "ArrowLeft")).toEqual({ type: "seek-relative", sessionId: "session-1", seconds: -10 });
    expect(playbackCommandForKey(status, "F6")).toEqual({ type: "seek-relative", sessionId: "session-1", seconds: -10 });
    expect(playbackCommandForKey(status, "F7")).toEqual({ type: "seek-relative", sessionId: "session-1", seconds: 10 });
    expect(playbackCommandForKey(status, "Enter")).toEqual({ type: "toggle-pause", sessionId: "session-1" });
    expect(playbackCommandForKey(status, "ArrowUp")).toEqual({ type: "cycle-audio-track", sessionId: "session-1" });
    expect(playbackCommandForKey(status, "ArrowDown")).toEqual({ type: "cycle-subtitle-track", sessionId: "session-1" });
    expect(playbackCommandForKey(status, "F9")).toEqual({ type: "cycle-audio-track", sessionId: "session-1" });
    expect(playbackCommandForKey(status, "F10")).toEqual({ type: "cycle-subtitle-track", sessionId: "session-1" });
    expect(playbackCommandForKey(status, "AudioTrack")).toEqual({ type: "cycle-audio-track", sessionId: "session-1" });
    expect(playbackCommandForKey(status, "Subtitle")).toEqual({ type: "cycle-subtitle-track", sessionId: "session-1" });
    expect(playbackCommandForKey(status, "MediaStop")).toEqual({ type: "stop", sessionId: "session-1" });
  });

  it("reports only real gamepad connection transitions", () => {
    expect(gamepadConnectionTransition(null, "degraded")).toBeNull();
    expect(gamepadConnectionTransition("degraded", "ready")).toBe("connected");
    expect(gamepadConnectionTransition("ready", "unavailable")).toBe("disconnected");
    expect(gamepadConnectionTransition("degraded", "unavailable")).toBeNull();
  });

  it("does not control a terminal session", () => {
    expect(playbackCommandForKey({ ...status, state: "stopped" }, "MediaPlayPause")).toBeNull();
  });
});
