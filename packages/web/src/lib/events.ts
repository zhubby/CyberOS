import type { AgentEvent, TranscriptMessage } from "../api.js";

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
  const content = typeof event.payload.content === "string" ? event.payload.content : "";
  if (!content) {
    return null;
  }
  return {
    id: `event:${event.id}`,
    role: event.payload.role === "user" ? "user" : "assistant",
    content,
    createdAt: event.createdAt,
    sequence: event.transcriptSequence ?? null
  };
}

function failedJobToTranscriptMessage(event: AgentEvent): TranscriptMessage | null {
  const error = typeof event.payload.error === "string" ? event.payload.error : "";
  if (!error) {
    return null;
  }
  return {
    id: `event:${event.id}`,
    role: "assistant",
    content: `Agent failed: ${error}`,
    createdAt: event.createdAt,
    sequence: event.transcriptSequence ?? null
  };
}

export function getEventJobId(event: AgentEvent): string | null {
  return typeof event.payload.jobId === "string" ? event.payload.jobId : null;
}
