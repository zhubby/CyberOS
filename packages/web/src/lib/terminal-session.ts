const TERMINAL_SESSION_KEY_PREFIX = "zos:terminal-session:v2:";
const LEGACY_TERMINAL_SESSION_KEY_PREFIX = "zos:terminal-session:";

export interface TerminalSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createTerminalSessionId(): string {
  if (typeof window !== "undefined") {
    try {
      if (typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch {
      // Some embedded browsers expose crypto but block randomUUID.
    }
  }
  return "00000000-0000-4000-8000-000000000000".replace(/[0]/gu, () => Math.floor(Math.random() * 16).toString(16));
}

export function readStoredTerminalSessionId(rootId: string, storage = browserStorage()): string | null {
  if (!storage) {
    return null;
  }
  try {
    const value = storage.getItem(terminalSessionKey(rootId)) ?? storage.getItem(legacyTerminalSessionKey(rootId));
    return value?.trim() || null;
  } catch {
    return null;
  }
}

export function writeStoredTerminalSessionId(
  rootId: string,
  sessionId: string,
  storage = browserStorage()
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(terminalSessionKey(rootId), sessionId);
  } catch {
    // Storage may be unavailable in private browsing or restricted embeds.
  }
}

export function clearStoredTerminalSessionId(rootId: string, storage = browserStorage()): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(terminalSessionKey(rootId));
    storage.removeItem(legacyTerminalSessionKey(rootId));
  } catch {
    // Storage may be unavailable in private browsing or restricted embeds.
  }
}

function terminalSessionKey(rootId: string): string {
  return `${TERMINAL_SESSION_KEY_PREFIX}${rootId}`;
}

function legacyTerminalSessionKey(rootId: string): string {
  return `${LEGACY_TERMINAL_SESSION_KEY_PREFIX}${rootId}`;
}

function browserStorage(): TerminalSessionStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
