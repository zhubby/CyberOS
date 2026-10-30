import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMusicPlayer,
  MusicApiError,
  musicCoverUrl,
  musicRequest,
  sendMusicCommand,
} from "./music-api.js";
import { playMediaFile } from "../tv/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Music remote API", () => {
  it("sends trusted song IDs and the queue revision, preserving duplicate songs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: { queueVersion: 8 } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    await sendMusicCommand({
      type: "replace",
      trackIds: ["song-a", "song-a"],
      expectedQueueVersion: 7,
      expectedSessionId: "movie",
    });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/music/player/command");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "replace",
      trackIds: ["song-a", "song-a"],
      expectedQueueVersion: 7,
      expectedSessionId: "movie",
    });
  });

  it("keeps conflict status and code for an explicit takeover", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: "Video is playing",
              code: "SESSION_CONFLICT",
            }),
            { status: 409 },
          ),
        ),
    );
    await expect(getMusicPlayer()).rejects.toMatchObject({
      statusCode: 409,
      code: "SESSION_CONFLICT",
      message: "Video is playing",
    });
    await expect(musicRequest("/player")).rejects.toBeInstanceOf(MusicApiError);
  });

  it("encodes artwork keys as one path component", () => {
    expect(musicCoverUrl("album/cover.jpg")).toBe(
      "/api/music/artwork/album%2Fcover.jpg",
    );
    expect(musicCoverUrl(null)).toBeUndefined();
  });
});

describe("TV music takeover", () => {
  it("only sends a takeover session after the caller supplies confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ status: {} }))),
      );
    vi.stubGlobal("fetch", fetchMock);
    await playMediaFile("movie", 12);
    await playMediaFile("movie", 12, "music-session");
    const requests = fetchMock.mock.calls.map(
      (call) =>
        JSON.parse(String((call[1] as RequestInit).body)) as Record<
          string,
          unknown
        >,
    );
    expect(requests).toEqual([
      { startPositionSeconds: 12 },
      { startPositionSeconds: 12, expectedSessionId: "music-session" },
    ]);
  });
});
