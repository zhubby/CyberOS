import type { StreamSession, VodPlayerState } from "@cyberos/shared";

const preferenceKey = "cyberos.playback-bar";

export function readPlaybackBarExpanded(storage?: Pick<Storage, "getItem">): boolean {
  try {
    return storage?.getItem(preferenceKey) !== "collapsed";
  } catch {
    return true;
  }
}

export function writePlaybackBarExpanded(storage: Pick<Storage, "setItem">, expanded: boolean): void {
  try {
    storage.setItem(preferenceKey, expanded ? "expanded" : "collapsed");
  } catch {
    // Storage restrictions must not affect the running playback session.
  }
}

export function getPlaybackDockState({ nas, browser, target, error }: {
  nas: {
    owner: "music" | "video" | null;
    music: { queue: readonly unknown[]; state: VodPlayerState; error: string | null };
    video: { state: VodPlayerState; error: string | null };
  } | null;
  browser: { playing: boolean; session: Pick<StreamSession, "state" | "error"> } | null;
  target: "browser" | "nas";
  error: string | null;
}): { available: boolean; state: "idle" | "playing" | "paused" | "error" } {
  const available = !!browser || !!nas?.owner || !!nas?.music.queue.length;
  if (!available) return { available, state: "idle" };
  if (target === "browser" && browser) {
    return { available, state: browser.session.state === "error" || browser.session.error ? "error" : browser.playing ? "playing" : "paused" };
  }
  const selected = nas?.owner === "video" ? nas.video : nas?.music;
  return { available, state: error || selected?.error ? "error" : selected?.state === "playing" && nas?.owner ? "playing" : "paused" };
}
