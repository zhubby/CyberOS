import type { AgentEvent, TranscriptMessage } from "../api.js";

export type TranscriptPhase = "idle" | "loading" | "ready" | "error";

export interface TranscriptState {
  sessionId: string | null;
  phase: TranscriptPhase;
  messages: TranscriptMessage[];
  streamSequences: Record<string, number>;
}

export type TranscriptAction =
  | { type: "prepare" }
  | { type: "begin"; sessionId: string }
  | { type: "snapshot"; sessionId: string; messages: TranscriptMessage[] }
  | { type: "event"; sessionId: string; message: TranscriptMessage; runId?: string }
  | { type: "stream"; sessionId: string; event: AgentEvent }
  | { type: "optimistic"; sessionId: string; message: TranscriptMessage }
  | { type: "acknowledge"; sessionId: string; optimisticId: string; message: TranscriptMessage }
  | { type: "rollback"; sessionId: string; optimisticId: string }
  | { type: "failed"; sessionId: string | null }
  | { type: "reset" };

export const initialTranscriptState: TranscriptState = {
  sessionId: null,
  phase: "idle",
  messages: [],
  streamSequences: {}
};

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  if (action.type === "reset") {
    return initialTranscriptState;
  }
  if (action.type === "prepare") {
    return { sessionId: null, phase: "loading", messages: [], streamSequences: {} };
  }
  if (action.type === "begin") {
    return { sessionId: action.sessionId, phase: "loading", messages: [], streamSequences: {} };
  }
  if (state.sessionId !== action.sessionId) {
    return state;
  }

  if (action.type === "snapshot") {
    return {
      ...state,
      phase: "ready",
      messages: mergeTranscriptMessages(action.messages, state.messages)
    };
  }
  if (action.type === "stream") {
    return reduceStreamEvent(state, action.event);
  }
  if (action.type === "event") {
    const streamId = action.runId ? `stream:${action.runId}` : null;
    const persistedAssistantContent = action.message.role === "assistant"
      ? action.message.content
      : null;
    const removedStreamRunIds = state.messages.flatMap((message) =>
      message.id.startsWith("stream:")
        && (message.id === streamId || message.content === persistedAssistantContent)
        ? [message.id.slice("stream:".length)]
        : []
    );
    return {
      ...state,
      messages: mergeTranscriptMessages(
        state.messages.filter((message) =>
          message.id !== streamId
          && !(
            persistedAssistantContent !== null
            && message.id.startsWith("stream:")
            && message.content === persistedAssistantContent
          )
        ),
        [action.message]
      ),
      streamSequences: withoutKeys(
        state.streamSequences,
        action.runId ? [...removedStreamRunIds, action.runId] : removedStreamRunIds
      )
    };
  }
  if (action.type === "optimistic") {
    return {
      ...state,
      messages: mergeTranscriptMessages(state.messages, [action.message])
    };
  }
  if (action.type === "acknowledge") {
    return {
      ...state,
      messages: mergeTranscriptMessages(
        state.messages.filter((message) => message.id !== action.optimisticId),
        [action.message]
      )
    };
  }
  if (action.type === "rollback") {
    return {
      ...state,
      messages: state.messages.filter((message) => message.id !== action.optimisticId)
    };
  }
  return {
    ...state,
    phase: "error"
  };
}

function reduceStreamEvent(state: TranscriptState, event: AgentEvent): TranscriptState {
  if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") {
    return state;
  }
  if (event.payload.role !== "assistant") return state;
  const runId = event.runId;
  const sequence = event.sequence;
  const previousSequence = state.streamSequences[runId] ?? -1;
  if (sequence <= previousSequence) return state;
  const content = typeof event.payload.content === "string" ? event.payload.content : "";
  const streamId = `stream:${runId}`;
  const withoutCurrent = state.messages.filter((message) => message.id !== streamId);
  return {
    ...state,
    messages: content
      ? mergeTranscriptMessages(withoutCurrent, [{
          id: streamId,
          role: "assistant",
          content,
          createdAt: event.createdAt,
          sequence: null,
          turnSequence: event.transcriptTurnSequence,
          streaming: event.type !== "message_end"
        }])
      : withoutCurrent,
    streamSequences: { ...state.streamSequences, [runId]: sequence }
  };
}

function withoutKeys(values: Record<string, number>, keys: string[]): Record<string, number> {
  if (keys.length === 0) return values;
  const next = { ...values };
  for (const key of keys) delete next[key];
  return next;
}

export function mergeTranscriptMessages(
  ...messageGroups: TranscriptMessage[][]
): TranscriptMessage[] {
  const messagesById = new Map<string, TranscriptMessage>();
  for (const messages of messageGroups) {
    for (const message of messages) {
      messagesById.set(message.id, message);
    }
  }
  return [...messagesById.values()].sort((left, right) => {
    if (left.turnSequence === null) return right.turnSequence === null ? 0 : 1;
    if (right.turnSequence === null) return -1;
    if (left.turnSequence !== right.turnSequence) {
      return left.turnSequence - right.turnSequence;
    }
    if (left.sequence === null) return right.sequence === null ? 0 : 1;
    if (right.sequence === null) return -1;
    return left.sequence - right.sequence;
  });
}
