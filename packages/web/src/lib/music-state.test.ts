import { describe, expect, it } from "vitest";
import {
  acceptMusicSnapshot,
  activeLyricIndex,
  moveQueueItem,
  parseMusicLyrics,
} from "./music-state.js";

describe("music remote state", () => {
  it("rejects old revisions and old service instances", () => {
    const current = {
      serviceInstanceId: "a",
      revision: 8,
      updatedAt: "2026-10-30T10:00:00Z",
    };
    expect(acceptMusicSnapshot(current, { ...current, revision: 7 })).toBe(
      current,
    );
    expect(
      acceptMusicSnapshot(current, {
        ...current,
        serviceInstanceId: "old",
        updatedAt: "2026-10-30T09:00:00Z",
      }),
    ).toBe(current);
    expect(
      acceptMusicSnapshot(current, {
        ...current,
        serviceInstanceId: "b",
        revision: 0,
        updatedAt: "2026-10-30T10:01:00Z",
      }).serviceInstanceId,
    ).toBe("b");
  });

  it("preserves duplicate tracks through queue item identities", () => {
    expect(moveQueueItem(["first", "duplicate", "last"], "last", -1)).toEqual([
      "first",
      "last",
      "duplicate",
    ]);
    expect(moveQueueItem(["first"], "first", -1)).toEqual(["first"]);
  });
});

describe("local lyrics", () => {
  it("supports multiple timestamps, offsets and fractional seconds", () => {
    const lines = parseMusicLyrics(
      "[ar:Artist]\n[offset:500]\n[00:01.20][00:03.000]Repeated\n[00:02.00]Middle",
    );
    expect(lines).toEqual([
      { seconds: 1.7, text: "Repeated" },
      { seconds: 2.5, text: "Middle" },
      { seconds: 3.5, text: "Repeated" },
    ]);
    expect(activeLyricIndex(lines, 2.6)).toBe(1);
    expect(activeLyricIndex(lines, 0)).toBe(-1);
  });

  it("keeps plain text and renders lyrics as data", () => {
    expect(parseMusicLyrics("First\n<script>plain text</script>")).toEqual([
      { seconds: null, text: "First" },
      { seconds: null, text: "<script>plain text</script>" },
    ]);
  });
});
