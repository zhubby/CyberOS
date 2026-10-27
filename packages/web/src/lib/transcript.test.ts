import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "../api.js";
import type { AgentEvent } from "../api.js";
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

  it("merges assistant stream updates by run sequence and ignores duplicates and stale updates", () => {
    let state = transcriptReducer(initialTranscriptState, { type: "begin", sessionId: "session-1" });
    state = transcriptReducer(state, {
      type: "stream",
      sessionId: "session-1",
      event: streamEvent("message_start", 1, "")
    });
    state = transcriptReducer(state, {
      type: "stream",
      sessionId: "session-1",
      event: streamEvent("message_update", 3, "Hello world")
    });
    state = transcriptReducer(state, {
      type: "stream",
      sessionId: "session-1",
      event: streamEvent("message_update", 2, "Hello")
    });
    state = transcriptReducer(state, {
      type: "stream",
      sessionId: "session-1",
      event: streamEvent("message_update", 3, "Duplicate")
    });
    state = transcriptReducer(state, {
      type: "stream",
      sessionId: "session-1",
      event: streamEvent("message_end", 4, "Hello world")
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: "stream:run-1",
        role: "assistant",
        content: "Hello world",
        streaming: false
      })
    ]);
    expect(state.streamSequences).toEqual({ "run-1": 4 });
  });

  it("replaces a completed stream when a replayed projection has a stable entry run", () => {
    let state = transcriptReducer(initialTranscriptState, { type: "begin", sessionId: "session-1" });
    state = transcriptReducer(state, {
      type: "stream",
      sessionId: "session-1",
      event: streamEvent("message_end", 4, "Done")
    });
    state = transcriptReducer(state, {
      type: "event",
      sessionId: "session-1",
      runId: "pi-entry:assistant-10",
      message: message("event:10", 2, "Done")
    });

    expect(state.messages.map((item) => item.id)).toEqual(["event:10"]);
    expect(state.streamSequences).toEqual({});
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

function streamEvent(type: "message_start" | "message_update" | "message_end", sequence: number, content: string): AgentEvent {
  return {
    schemaVersion: 1,
    id: sequence,
    sessionId: "session-1",
    jobId: "job-1",
    type,
    audience: "chat",
    transcriptSequence: null,
    source: "pi",
    sourceId: `run-1:${sequence}`,
    runId: "run-1",
    sequence,
    payload: { role: "assistant", content },
    createdAt: "2026-10-27T00:00:00.000Z"
  };
}
