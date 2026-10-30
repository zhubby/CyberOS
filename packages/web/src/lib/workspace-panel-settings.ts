export const WORKSPACE_PANEL_STORAGE_KEY = "cyberos:last-workspace-panel";

export const WORKSPACE_PANEL_IDS = [
  "files",
  "photos",
  "music",
  "terminal",
  "downloads",
  "monitoring",
  "docker",
  "virtualMachines",
  "network",
  "storage",
  "shares"
] as const;

export type WorkspacePanelId = typeof WORKSPACE_PANEL_IDS[number];

export const DEFAULT_WORKSPACE_PANEL: WorkspacePanelId = "files";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readStoredWorkspacePanel(storage: StorageLike | null = browserStorage()): WorkspacePanelId {
  try {
    const storedPanel = storage?.getItem(WORKSPACE_PANEL_STORAGE_KEY) ?? null;
    return isWorkspacePanelId(storedPanel) ? storedPanel : DEFAULT_WORKSPACE_PANEL;
  } catch {
    return DEFAULT_WORKSPACE_PANEL;
  }
}

export function writeStoredWorkspacePanel(
  panel: WorkspacePanelId,
  storage: StorageLike | null = browserStorage()
): void {
  try {
    storage?.setItem(WORKSPACE_PANEL_STORAGE_KEY, panel);
  } catch {
    // Panel switching still works for the current session when persistence is unavailable.
  }
}

function isWorkspacePanelId(value: string | null): value is WorkspacePanelId {
  return value !== null && (WORKSPACE_PANEL_IDS as readonly string[]).includes(value);
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
