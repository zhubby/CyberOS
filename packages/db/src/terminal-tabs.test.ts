import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateTerminalTab,
  createTerminalTab,
  deleteTerminalTab,
  getTerminalTabState,
  initializeTerminalTabs,
  openCyberOsDb,
  renameTerminalTab,
  type CyberOsDatabase
} from "./index.js";

describe("terminal tab repository", () => {
  let tempDir: string;
  let db: CyberOsDatabase;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-terminal-tabs-"));
    db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("initializes a new tab set exactly once", () => {
    expect(getTerminalTabState(db, 4)).toMatchObject({
      initialized: false,
      tabs: [],
      activeTabId: null,
      maxSessions: 4
    });

    const initialized = initializeTerminalTabs(db, { maxSessions: 4 });
    expect(initialized.tabs).toEqual([
      expect.objectContaining({ ordinal: 1, customTitle: null })
    ]);
    expect(initialized.activeTabId).toBe(initialized.tabs[0]?.id);
    expect(initializeTerminalTabs(db, { maxSessions: 4 })).toEqual(initialized);
  });

  it("keeps global ordinals monotonic after deletion", () => {
    const first = initializeTerminalTabs(db, { maxSessions: 5 });
    const second = createTerminalTab(db, { maxSessions: 5 });

    expect(deleteTerminalTab(db, { id: second.activeTabId!, maxSessions: 5 })?.activeTabId).toBe(first.activeTabId);
    const third = createTerminalTab(db, { maxSessions: 5 });

    expect(third.tabs.map((tab) => tab.ordinal)).toEqual([1, 3]);
  });

  it("activates, renames, and chooses the right neighbor before the left", () => {
    const first = initializeTerminalTabs(db, { maxSessions: 5 });
    const second = createTerminalTab(db, { maxSessions: 5 });
    const third = createTerminalTab(db, { maxSessions: 5 });
    const firstId = first.tabs[0]!.id;
    const secondId = second.tabs[1]!.id;
    const thirdId = third.tabs[2]!.id;

    expect(activateTerminalTab(db, { id: secondId, maxSessions: 5 })?.activeTabId).toBe(secondId);
    expect(renameTerminalTab(db, { id: secondId, customTitle: "Build", maxSessions: 5 })?.tabs[1]?.customTitle).toBe("Build");
    expect(deleteTerminalTab(db, { id: secondId, maxSessions: 5 })?.activeTabId).toBe(thirdId);
    expect(deleteTerminalTab(db, { id: thirdId, maxSessions: 5 })?.activeTabId).toBe(firstId);
    expect(deleteTerminalTab(db, { id: firstId, maxSessions: 5 })).toMatchObject({
      initialized: true,
      tabs: [],
      activeTabId: null
    });
  });

  it("enforces the configured global session limit", () => {
    initializeTerminalTabs(db, { maxSessions: 2 });
    createTerminalTab(db, { maxSessions: 2 });

    expect(() => createTerminalTab(db, { maxSessions: 2 })).toThrow("Terminal session limit reached");
  });
});
