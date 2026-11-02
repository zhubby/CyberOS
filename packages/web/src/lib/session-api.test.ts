import { afterEach, describe, expect, it, vi } from "vitest";
import { getTranscript } from "../api.js";

afterEach(() => vi.unstubAllGlobals());

describe("chat history snapshot", () => {
  it("retains the event cursor and current runtime alongside the persisted transcript", async () => {
    const snapshot = {
      transcript: [],
      lastEventId: 208,
      activeJob: null,
      liveEvents: []
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot))));
    expect(await getTranscript("session-1")).toEqual(snapshot);
  });
});
