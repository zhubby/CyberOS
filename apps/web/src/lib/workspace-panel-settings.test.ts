import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_PANEL,
  readStoredWorkspacePanel,
  WORKSPACE_PANEL_IDS,
  WORKSPACE_PANEL_STORAGE_KEY,
  writeStoredWorkspacePanel
} from "./workspace-panel-settings.js";

describe("workspace panel settings helpers", () => {
  it("persists and restores every workspace panel", () => {
    const storage = createMemoryStorage();

    for (const panel of WORKSPACE_PANEL_IDS) {
      writeStoredWorkspacePanel(panel, storage);

      expect(storage.getItem(WORKSPACE_PANEL_STORAGE_KEY)).toBe(panel);
      expect(readStoredWorkspacePanel(storage)).toBe(panel);
    }
  });

  it("falls back to files for missing, stale, and invalid values", () => {
    const storage = createMemoryStorage();

    expect(readStoredWorkspacePanel(storage)).toBe(DEFAULT_WORKSPACE_PANEL);

    for (const value of ["", "file", "settings", "unknown-panel"]) {
      storage.setItem(WORKSPACE_PANEL_STORAGE_KEY, value);
      expect(readStoredWorkspacePanel(storage)).toBe(DEFAULT_WORKSPACE_PANEL);
    }
  });

  it("migrates the accidentally persisted photostaff panel id", () => {
    const storage = createMemoryStorage();
    storage.setItem(WORKSPACE_PANEL_STORAGE_KEY, "photostaff");

    expect(readStoredWorkspacePanel(storage)).toBe("photos");
  });

  it("keeps session-only behavior when storage operations fail", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      }
    };

    expect(readStoredWorkspacePanel(unavailableStorage)).toBe(DEFAULT_WORKSPACE_PANEL);
    expect(() => writeStoredWorkspacePanel("photos", unavailableStorage)).not.toThrow();
  });

  it("tolerates a browser that throws while exposing localStorage", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          throw new Error("storage unavailable");
        }
      }
    });

    try {
      expect(readStoredWorkspacePanel()).toBe(DEFAULT_WORKSPACE_PANEL);
      expect(() => writeStoredWorkspacePanel("terminal")).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow
      });
    }
  });
});

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}
