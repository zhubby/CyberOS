import { describe, expect, it } from "vitest";
import { eventToTranscriptMessage } from "./events.js";
import type { AgentEvent } from "../api.js";

describe("event helpers", () => {
  it("converts non-empty agent messages into transcript messages", () => {
    const event: AgentEvent = {
      id: 42,
      sessionId: "session-1",
      jobId: "job-1",
      runId: "run-1",
      sequence: 1,
      type: "agent.message",
      audience: "chat",
      transcriptSequence: 7,
      payload: { content: "Done" },
      createdAt: "2026-08-21T00:00:00.000Z"
    };

    expect(eventToTranscriptMessage(event)).toEqual({
      id: "event:42",
      role: "assistant",
      content: "Done",
      createdAt: "2026-08-21T00:00:00.000Z",
      sequence: 7
    });
  });

  it("ignores non-message events and empty message payloads", () => {
    expect(
      eventToTranscriptMessage({
        id: 1,
        sessionId: "session-1",
        jobId: "job-1",
        runId: "run-1",
        sequence: 1,
        type: "job.running",
        audience: "chat",
        transcriptSequence: null,
        payload: { content: "ignored" },
        createdAt: "2026-08-21T00:00:00.000Z"
      })
    ).toBeNull();
    expect(
      eventToTranscriptMessage({
        id: 2,
        sessionId: "session-1",
        jobId: "job-1",
        runId: "run-1",
        sequence: 2,
        type: "agent.message",
        audience: "chat",
        transcriptSequence: 2,
        payload: { content: "" },
        createdAt: "2026-08-21T00:00:00.000Z"
      })
    ).toBeNull();
    expect(
      eventToTranscriptMessage({
        id: 3,
        sessionId: "session-1",
        jobId: "job-1",
        runId: "run-1",
        sequence: 3,
        type: "agent.message",
        audience: "chat",
        transcriptSequence: 3,
        payload: { content: null },
        createdAt: "2026-08-21T00:00:00.000Z"
      })
    ).toBeNull();
  });

  it("converts failed jobs into visible assistant messages", () => {
    expect(
      eventToTranscriptMessage({
        id: 4,
        sessionId: "session-1",
        jobId: "job-1",
        runId: "run-1",
        sequence: 4,
        type: "job.failed",
        audience: "chat",
        transcriptSequence: 4,
        payload: { error: "Pi model is unavailable" },
        createdAt: "2026-08-21T00:00:00.000Z"
      })
    ).toEqual({
      id: "event:4",
      role: "assistant",
      content: "Agent failed: Pi model is unavailable",
      createdAt: "2026-08-21T00:00:00.000Z",
      sequence: 4
    });
  });

  it("ignores agent.failed events to avoid duplicate failure transcript entries", () => {
    expect(
      eventToTranscriptMessage({
        id: 5,
        sessionId: "session-1",
        jobId: "job-1",
        runId: "run-1",
        sequence: 5,
        type: "agent.failed",
        audience: "chat",
        transcriptSequence: null,
        payload: { error: "Pi model is unavailable" },
        createdAt: "2026-08-21T00:00:00.000Z"
      })
    ).toBeNull();
  });

  it("does not turn notification events into chat replies", () => {
    expect(eventToTranscriptMessage({
      id: 6,
      sessionId: "session-1",
      jobId: "job-1",
      runId: "run-1",
      sequence: 6,
      type: "job.failed",
      audience: "notification",
      transcriptSequence: null,
      payload: { error: "Docker failed" },
      createdAt: "2026-08-21T00:00:00.000Z"
    })).toBeNull();
  });
});
