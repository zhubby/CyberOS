import { describe, expect, it } from "vitest";
import type { TerminalTab, TerminalTabState } from "../api.js";
import {
  shouldInitializeTerminalTabs,
  terminalTabLabel,
  terminalTabNavigationTarget
} from "./terminal-tabs.js";

const tabs: TerminalTab[] = [tab("first", 1), tab("second", 2), tab("third", 3)];

describe("terminal tab helpers", () => {
  it("uses localized default labels and preserves custom titles", () => {
    const translate = (_key: string, options?: Record<string, unknown>) => `Terminal ${options?.number}`;
    expect(terminalTabLabel(tabs[0]!, translate)).toBe("Terminal 1");
    expect(terminalTabLabel({ ...tabs[1]!, customTitle: "Build" }, translate)).toBe("Build");
  });

  it("wraps arrow navigation and supports Home and End", () => {
    expect(terminalTabNavigationTarget(tabs, "first", "ArrowLeft")).toBe("third");
    expect(terminalTabNavigationTarget(tabs, "third", "ArrowRight")).toBe("first");
    expect(terminalTabNavigationTarget(tabs, "second", "Home")).toBe("first");
    expect(terminalTabNavigationTarget(tabs, "second", "End")).toBe("third");
  });

  it("initializes a new root and imports an unregistered legacy session once", () => {
    const state: TerminalTabState = { initialized: true, tabs, activeTabId: "first", maxSessions: 32 };
    expect(shouldInitializeTerminalTabs({ ...state, initialized: false }, null)).toBe(true);
    expect(shouldInitializeTerminalTabs(state, "legacy")).toBe(true);
    expect(shouldInitializeTerminalTabs(state, "first")).toBe(false);
    expect(shouldInitializeTerminalTabs(state, null)).toBe(false);
  });
});

function tab(id: string, ordinal: number): TerminalTab {
  return {
    id,
    rootId: "local",
    ordinal,
    customTitle: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z"
  };
}
