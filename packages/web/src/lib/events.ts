import type { AgentEvent, AgentToolActivity, TranscriptMessage } from "../api.js";

export function reduceAgentToolActivities(activities: AgentToolActivity[], event: AgentEvent): AgentToolActivity[] {
  if (
    event.type !== "tool_execution_start"
    && event.type !== "tool_execution_update"
    && event.type !== "tool_execution_end"
  ) return activities;
  const { id, name } = event.payload;
  if (typeof id !== "string" || typeof name !== "string") return activities;
  const next: AgentToolActivity = {
    id,
    runId: event.runId,
    name,
    status: event.type === "tool_execution_end"
      ? event.payload.isError === true ? "failed" : "completed"
      : "running"
  };
  const existingIndex = activities.findIndex((activity) => activity.id === id);
  if (existingIndex === -1) return [...activities, next];
  return activities.map((activity, index) => index === existingIndex ? next : activity);
}

export function eventToTranscriptMessage(event: AgentEvent): TranscriptMessage | null {
  if (event.audience !== "chat") {
    return null;
  }
  if (event.type === "job.failed") {
    return failedJobToTranscriptMessage(event);
  }
  if (event.type !== "agent.message") {
    return null;
  }
  if (event.transcriptSequence === null) {
    return null;
  }
  const content = typeof event.payload.content === "string" ? event.payload.content : "";
  if (!content) {
    return null;
  }
  return {
    id: `event:${event.id}`,
    role: event.payload.role === "user" ? "user" : "assistant",
    content,
    createdAt: event.createdAt,
    sequence: event.transcriptSequence,
    turnSequence: event.transcriptTurnSequence
  };
}

function failedJobToTranscriptMessage(event: AgentEvent): TranscriptMessage | null {
  if (event.transcriptSequence === null) {
    return null;
  }
  const error = typeof event.payload.error === "string" ? event.payload.error : "";
  if (!error) {
    return null;
  }
  return {
    id: `event:${event.id}`,
    role: "assistant",
    content: `Agent failed: ${error}`,
    createdAt: event.createdAt,
    sequence: event.transcriptSequence,
    turnSequence: event.transcriptTurnSequence
  };
}

export function getEventJobId(event: AgentEvent): string | null {
  return typeof event.payload.jobId === "string" ? event.payload.jobId : null;
}
