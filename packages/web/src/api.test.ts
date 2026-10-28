import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalTab, initializeTerminalTabs, type TerminalTabState } from "./api.js";

const terminalState: TerminalTabState = {
  initialized: true,
  tabs: [],
  activeTabId: null,
  maxSessions: 4
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal tab requests", () => {
  it("initializes tabs without declaring an empty JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(terminalState));
    vi.stubGlobal("fetch", fetchMock);

    await expect(initializeTerminalTabs()).resolves.toEqual(terminalState);

    expect(fetchMock).toHaveBeenCalledWith("/api/terminal/tabs/initialize", { method: "POST" });
  });

  it("creates a tab without declaring an empty JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(terminalState));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createTerminalTab()).resolves.toEqual(terminalState);

    expect(fetchMock).toHaveBeenCalledWith("/api/terminal/tabs", { method: "POST" });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" }
  });
}
