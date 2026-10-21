export const DEFAULT_SPLIT_WIDTH = 560;
export const MIN_CHAT_WIDTH = 560;
export const MIN_WORKSPACE_WIDTH = 460;
export const SPLIT_WIDTH_STORAGE_KEY = "zos:split-width";

interface SplitWidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserViewportWidth(): number {
  return typeof window === "undefined" ? DEFAULT_SPLIT_WIDTH + MIN_WORKSPACE_WIDTH : window.innerWidth;
}

function browserStorage(): SplitWidthStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function clampSplitWidth(value: number, viewportWidth = browserViewportWidth()): number {
  return Math.min(
    Math.max(value, MIN_CHAT_WIDTH),
    Math.max(MIN_CHAT_WIDTH, viewportWidth - MIN_WORKSPACE_WIDTH)
  );
}

export function readStoredSplitWidth(
  storage: SplitWidthStorage | null = browserStorage(),
  viewportWidth = browserViewportWidth()
): number {
  const raw = storage?.getItem(SPLIT_WIDTH_STORAGE_KEY);
  const parsed = Number(raw ?? DEFAULT_SPLIT_WIDTH);
  return Number.isFinite(parsed) ? clampSplitWidth(parsed, viewportWidth) : DEFAULT_SPLIT_WIDTH;
}

export function writeStoredSplitWidth(value: number, storage: SplitWidthStorage | null = browserStorage()): void {
  storage?.setItem(SPLIT_WIDTH_STORAGE_KEY, String(value));
}
