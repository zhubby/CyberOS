import { describe, expect, it } from "vitest";
import { eventToTranscriptMessage, reduceAgentToolActivities } from "./events.js";
import type { AgentEvent } from "../api.js";

describe("event helpers", () => {
  it("restores tool snapshots by call ID even when Pi completion has a different run ID", () => {
    const event = (id: number, type: string, runId: string): AgentEvent => ({
      id, sessionId: "session-1", jobId: "job-1", runId, sequence: id,
      type, audience: "chat", transcriptSequence: null, transcriptTurnSequence: 1,
      payload: { id: "tool-1", name: "status", isError: false },
      createdAt: "2026-11-02T00:00:00.000Z"
    });
    const started = reduceAgentToolActivities([], event(1, "tool_execution_start", "live-run"));
    expect(started).toMatchObject([{ id: "tool-1", status: "running" }]);
    const completed = reduceAgentToolActivities(started, event(2, "tool_execution_end", "pi-entry:result"));
    expect(completed).toEqual([{ id: "tool-1", runId: "pi-entry:result", name: "status", status: "completed" }]);
    expect(reduceAgentToolActivities(completed, event(3, "turn_end", "live-run"))).toBe(completed);
  });

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
      transcriptTurnSequence: 3,
      payload: { content: "Done" },
      createdAt: "2026-08-21T00:00:00.000Z"
    };

    expect(eventToTranscriptMessage(event)).toEqual({
      id: "event:42",
      role: "assistant",
      content: "Done",
      createdAt: "2026-08-21T00:00:00.000Z",
      sequence: 7,
      turnSequence: 3
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
        transcriptTurnSequence: 1,
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
        transcriptTurnSequence: 1,
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
        transcriptTurnSequence: 1,
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
        transcriptTurnSequence: 1,
        payload: { error: "Pi model is unavailable" },
        createdAt: "2026-08-21T00:00:00.000Z"
      })
    ).toEqual({
      id: "event:4",
      role: "assistant",
      content: "Agent failed: Pi model is unavailable",
      createdAt: "2026-08-21T00:00:00.000Z",
      sequence: 4,
      turnSequence: 1
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
        transcriptTurnSequence: 1,
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
      transcriptTurnSequence: 1,
      payload: { error: "Docker failed" },
      createdAt: "2026-08-21T00:00:00.000Z"
    })).toBeNull();
  });
});
