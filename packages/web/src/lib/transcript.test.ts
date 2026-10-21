import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "../api.js";
import { initialTranscriptState, transcriptReducer } from "./transcript.js";

function message(id: string, sequence: number | null, content = id): TranscriptMessage {
  return {
    id,
    role: id.startsWith("event:") ? "assistant" : "user",
    content,
    createdAt: "2026-10-16T00:00:00.000Z",
    sequence
  };
}

describe("transcriptReducer", () => {
  it("merges SSE received during loading into the later snapshot", () => {
    let state = transcriptReducer(initialTranscriptState, { type: "begin", sessionId: "session-1" });
    state = transcriptReducer(state, {
      type: "event",
      sessionId: "session-1",
      message: message("event:2", 2)
    });
    state = transcriptReducer(state, {
      type: "snapshot",
      sessionId: "session-1",
      messages: [message("message:1", 1)]
    });

    expect(state.phase).toBe("ready");
    expect(state.messages.map((item) => item.id)).toEqual(["message:1", "event:2"]);
  });

  it("deduplicates and sorts persisted messages despite out-of-order arrival", () => {
    let state = transcriptReducer(initialTranscriptState, { type: "begin", sessionId: "session-1" });
    state = transcriptReducer(state, {
      type: "snapshot",
      sessionId: "session-1",
      messages: [message("event:3", 3), message("message:1", 1)]
    });
    state = transcriptReducer(state, {
      type: "event",
      sessionId: "session-1",
      message: message("event:2", 2)
    });
    state = transcriptReducer(state, {
      type: "event",
      sessionId: "session-1",
      message: message("event:2", 2, "updated")
    });

    expect(state.messages.map((item) => [item.id, item.content])).toEqual([
      ["message:1", "message:1"],
      ["event:2", "updated"],
      ["event:3", "event:3"]
    ]);
  });

  it("ignores late work from another session", () => {
    let state = transcriptReducer(initialTranscriptState, { type: "begin", sessionId: "session-1" });
    state = transcriptReducer(state, { type: "begin", sessionId: "session-2" });
    const current = state;

    expect(transcriptReducer(state, {
      type: "snapshot",
      sessionId: "session-1",
      messages: [message("message:old", 1)]
    })).toBe(current);
    expect(transcriptReducer(state, {
      type: "event",
      sessionId: "session-1",
      message: message("event:old", 2)
    })).toBe(current);
  });

  it("replaces an optimistic message with its canonical acknowledgement", () => {
    let state = transcriptReducer(initialTranscriptState, { type: "begin", sessionId: "session-1" });
    state = transcriptReducer(state, {
      type: "snapshot",
      sessionId: "session-1",
      messages: [message("message:1", 1)]
    });
    state = transcriptReducer(state, {
      type: "optimistic",
      sessionId: "session-1",
      message: message("local:pending", null)
    });
    state = transcriptReducer(state, {
      type: "acknowledge",
      sessionId: "session-1",
      optimisticId: "local:pending",
      message: message("message:2", 2)
    });

    expect(state.messages.map((item) => item.id)).toEqual(["message:1", "message:2"]);
  });

  it("rolls back optimistic messages and preserves legacy arrival order", () => {
    let state = transcriptReducer(initialTranscriptState, { type: "begin", sessionId: "session-1" });
    state = transcriptReducer(state, {
      type: "snapshot",
      sessionId: "session-1",
      messages: [message("message:legacy", null), message("event:legacy", null)]
    });
    state = transcriptReducer(state, {
      type: "optimistic",
      sessionId: "session-1",
      message: message("local:pending", null)
    });
    state = transcriptReducer(state, {
      type: "rollback",
      sessionId: "session-1",
      optimisticId: "local:pending"
    });

    expect(state.messages.map((item) => item.id)).toEqual(["message:legacy", "event:legacy"]);
  });

  it("keeps arrival order during a rolling upgrade with mixed sequence metadata", () => {
    let state = transcriptReducer(initialTranscriptState, { type: "begin", sessionId: "session-1" });
    state = transcriptReducer(state, {
      type: "snapshot",
      sessionId: "session-1",
      messages: [message("message:legacy", null), message("event:legacy", null)]
    });
    state = transcriptReducer(state, {
      type: "event",
      sessionId: "session-1",
      message: message("event:new", 1)
    });

    expect(state.messages.map((item) => item.id)).toEqual([
      "message:legacy",
      "event:legacy",
      "event:new"
    ]);
  });

  it("ends loading in an error phase without showing an empty ready state", () => {
    let state = transcriptReducer(initialTranscriptState, { type: "begin", sessionId: "session-1" });
    state = transcriptReducer(state, { type: "failed", sessionId: "session-1" });
    expect(state).toMatchObject({ sessionId: "session-1", phase: "error", messages: [] });
  });
});
