import type { VodPlayerCommand, VodPlayerStatus } from "@zos/shared";

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
  if (["MediaPlayPause", "MediaPlay", " "].includes(key)) return { type: "toggle-pause", sessionId };
  if (key === "ArrowLeft") return { type: "seek-relative", sessionId, seconds: -10 };
  if (key === "ArrowRight") return { type: "seek-relative", sessionId, seconds: 10 };
  if (["AudioTrack", "a", "A"].includes(key)) return { type: "cycle-audio-track", sessionId };
  if (["Subtitle", "s", "S"].includes(key)) return { type: "cycle-subtitle-track", sessionId };
  return null;
}
