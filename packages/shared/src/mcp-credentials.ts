import type { AgentMcpAuthMode } from "./types.js";

const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto"
]);

export interface AgentMcpCredentials {
  bearerToken?: string;
  headers?: Record<string, string>;
}

export function agentMcpCredentialHeaders(
  authMode: AgentMcpAuthMode,
  credentials: AgentMcpCredentials
): Record<string, string> {
  if (authMode === "bearer" && credentials.bearerToken) {
    return { Authorization: `Bearer ${credentials.bearerToken}` };
  }
  if (authMode === "headers" && credentials.headers) return { ...credentials.headers };
  return {};
}

export function validateAgentMcpCredentials(
  authMode: AgentMcpAuthMode,
  value: unknown
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP credentials must be an object");
  }
  const credentials = value as AgentMcpCredentials;
  const unknownFields = Object.keys(credentials).filter((key) => key !== "bearerToken" && key !== "headers");
  if (unknownFields.length > 0) throw new Error("MCP credentials contain unknown fields");
  if (authMode === "none") {
    if (credentials.bearerToken || Object.keys(credentials.headers ?? {}).length > 0) {
      throw new Error("Unauthenticated MCP servers cannot store credentials");
    }
    return [];
  }
  if (authMode === "bearer") {
    const token = credentials.bearerToken;
    if (typeof token !== "string" || !token.trim() || token.length > 8_192 || /[\r\n\0]/u.test(token)) {
      throw new Error("Bearer token must contain between 1 and 8192 safe characters");
    }
    if (credentials.headers && Object.keys(credentials.headers).length > 0) {
      throw new Error("Bearer authentication cannot include custom headers");
    }
    return ["Authorization"];
  }
  const headers = credentials.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("Custom MCP authentication requires secret headers");
  }
  const entries = Object.entries(headers);
  if (entries.length < 1 || entries.length > 20) {
    throw new Error("MCP secret headers must contain between 1 and 20 entries");
  }
  const normalizedNames = new Set<string>();
  for (const [rawName, headerValue] of entries) {
    const name = rawName.trim();
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(name) || FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-")) {
      throw new Error(`MCP secret header is not allowed: ${rawName}`);
    }
    if (normalizedNames.has(lower)) throw new Error(`Duplicate MCP secret header: ${name}`);
    if (typeof headerValue !== "string" || !headerValue || headerValue.length > 8_192 || /[\r\n\0]/u.test(headerValue)) {
      throw new Error(`MCP secret header value is invalid: ${name}`);
    }
    normalizedNames.add(lower);
  }
  if (credentials.bearerToken) throw new Error("Custom header authentication cannot include a bearer token");
  return entries.map(([name]) => name).sort((left, right) => left.localeCompare(right));
}
