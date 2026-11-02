export function getInitialEventId(headerValue: string | string[] | undefined, queryValue: string | undefined): number {
  const rawHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  for (const value of [rawHeader, queryValue]) {
    if (!value?.trim()) continue;
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

export function getAgentMessageRole(payload: unknown): "assistant" | "user" {
  if (payload && typeof payload === "object" && "role" in payload) {
    const role = (payload as { role?: unknown }).role;
    return role === "user" ? "user" : "assistant";
  }
  return "assistant";
}

export function getAgentMessageContent(payload: unknown): string {
  if (payload && typeof payload === "object" && "content" in payload) {
    const content = (payload as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }
  return "";
}

export function getFailedJobMessageContent(payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    return typeof error === "string" && error ? `Agent failed: ${error}` : "";
  }
  return "";
}
