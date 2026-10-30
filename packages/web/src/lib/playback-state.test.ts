import { expect, it } from "vitest";
import { playbackControlTarget, acceptPlaybackRevision } from "./playback-state.js";
it("keeps browser and NAS transport independent", () => {
  expect(playbackControlTarget("browser", true)).toBe("browser");
  expect(playbackControlTarget("nas", true)).toBe("nas");
  expect(playbackControlTarget("browser", false)).toBe("nas");
});
it("rejects older updates from the same service instance", () => {
  const latest = { serviceInstanceId: "one", revision: 9, updatedAt: "2026-10-30T00:00:00Z" };
  expect(acceptPlaybackRevision(latest, { ...latest, revision: 8 })).toBe(latest);
  expect(acceptPlaybackRevision(latest, { ...latest, revision: 10 }).revision).toBe(10);
});
