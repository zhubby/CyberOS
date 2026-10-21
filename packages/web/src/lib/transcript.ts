import type { TranscriptMessage } from "../api.js";

export type TranscriptPhase = "idle" | "loading" | "ready" | "error";

export interface TranscriptState {
  sessionId: string | null;
  phase: TranscriptPhase;
  messages: TranscriptMessage[];
}

export type TranscriptAction =
  | { type: "prepare" }
  | { type: "begin"; sessionId: string }
  | { type: "snapshot"; sessionId: string; messages: TranscriptMessage[] }
  | { type: "event"; sessionId: string; message: TranscriptMessage }
  | { type: "optimistic"; sessionId: string; message: TranscriptMessage }
  | { type: "acknowledge"; sessionId: string; optimisticId: string; message: TranscriptMessage }
  | { type: "rollback"; sessionId: string; optimisticId: string }
  | { type: "failed"; sessionId: string | null }
  | { type: "reset" };

export const initialTranscriptState: TranscriptState = {
  sessionId: null,
  phase: "idle",
  messages: []
};

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  if (action.type === "reset") {
    return initialTranscriptState;
  }
  if (action.type === "prepare") {
    return { sessionId: null, phase: "loading", messages: [] };
  }
  if (action.type === "begin") {
    return { sessionId: action.sessionId, phase: "loading", messages: [] };
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
  if (action.type === "event" || action.type === "optimistic") {
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

export function mergeTranscriptMessages(
  ...messageGroups: TranscriptMessage[][]
): TranscriptMessage[] {
  const messagesById = new Map<string, TranscriptMessage>();
  for (const messages of messageGroups) {
    for (const message of messages) {
      messagesById.set(message.id, {
        ...message,
        sequence: message.sequence ?? null
      });
    }
  }
  const merged = [...messagesById.values()];
  if (merged.some((message) => message.sequence === null)) {
    return merged;
  }
  return merged.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
}
