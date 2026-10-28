import type { VodPlayerCommand, VodPlayerStatus } from "@cyberos/shared";

export function isActiveVodPlayback(status: VodPlayerStatus | null): boolean {
  return status?.state === "starting" || status?.state === "playing" ||
    status?.state === "paused" || status?.state === "recovering";
}

export function vodPlayerPollDelay(status: VodPlayerStatus | null): number {
  return isActiveVodPlayback(status) ? 1_000 : 5_000;
}

export function playbackCommandForKey(
  status: VodPlayerStatus | null,
  key: string
): Exclude<VodPlayerCommand, { type: "play" }> | null {
  const sessionId = status?.sessionId;
  if (!sessionId || !isActiveVodPlayback(status)) return null;
  if (["Escape", "BrowserBack", "GoBack", "MediaStop"].includes(key)) return { type: "stop", sessionId };
  if (["MediaPlayPause", "MediaPlay", " ", "Enter"].includes(key)) return { type: "toggle-pause", sessionId };
  if (["ArrowLeft", "F6"].includes(key)) return { type: "seek-relative", sessionId, seconds: -10 };
  if (["ArrowRight", "F7"].includes(key)) return { type: "seek-relative", sessionId, seconds: 10 };
  if (["ArrowUp", "F9", "AudioTrack", "a", "A"].includes(key)) return { type: "cycle-audio-track", sessionId };
  if (["ArrowDown", "F10", "Subtitle", "s", "S"].includes(key)) return { type: "cycle-subtitle-track", sessionId };
  return null;
}

export function gamepadConnectionTransition(
  previous: "ready" | "degraded" | "unavailable" | null,
  next: "ready" | "degraded" | "unavailable"
): "connected" | "disconnected" | null {
  if (previous === null || previous === next) return null;
  if (next === "ready") return "connected";
  if (previous === "ready") return "disconnected";
  return null;
}
