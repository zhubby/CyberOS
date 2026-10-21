import type { TerminalTab, TerminalTabState } from "../api.js";

export type TerminalTabNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function terminalTabLabel(
  tab: TerminalTab,
  translate: (key: string, options?: Record<string, unknown>) => unknown
): string {
  return tab.customTitle ?? String(translate("workspace.terminal.defaultTabTitle", { number: tab.ordinal }));
}

export function terminalTabNavigationTarget(
  tabs: TerminalTab[],
  activeTabId: string,
  key: TerminalTabNavigationKey
): string | null {
  if (!tabs.length) {
    return null;
  }
  if (key === "Home") {
    return tabs[0]!.id;
  }
  if (key === "End") {
    return tabs.at(-1)!.id;
  }
  const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
  const offset = key === "ArrowRight" ? 1 : -1;
  return tabs[(currentIndex + offset + tabs.length) % tabs.length]!.id;
}

export function shouldInitializeTerminalTabs(state: TerminalTabState, legacySessionId: string | null): boolean {
  return !state.initialized
    || Boolean(legacySessionId && !state.tabs.some((tab) => tab.id === legacySessionId));
}
