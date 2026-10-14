import { randomUUID } from "node:crypto";
import type { TerminalTab, TerminalTabState } from "@zos/shared";
import type { ZosDatabase } from "../connection.js";

interface DbTerminalTabRow {
  id: string;
  root_id: string;
  ordinal: number;
  custom_title: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTerminalTabSetRow {
  root_id: string;
  active_tab_id: string | null;
  next_ordinal: number;
  initialized_at: string;
  updated_at: string;
}

export function getTerminalTab(db: ZosDatabase, id: string): TerminalTab | null {
  const row = db.prepare(`
    SELECT id, root_id, ordinal, custom_title, created_at, updated_at
    FROM terminal_tabs
    WHERE id = ?
  `).get(id) as DbTerminalTabRow | undefined;
  return row ? mapTerminalTab(row) : null;
}

export function getTerminalTabState(
  db: ZosDatabase,
  rootId: string,
  maxSessions: number
): TerminalTabState {
  const set = getTerminalTabSet(db, rootId);
  return {
    initialized: Boolean(set),
    tabs: listTerminalTabs(db, rootId),
    activeTabId: set?.active_tab_id ?? null,
    maxSessions
  };
}

export function initializeTerminalTabs(
  db: ZosDatabase,
  input: { rootId: string; maxSessions: number; legacySessionId?: string }
): TerminalTabState {
  const initialize = db.transaction(() => {
    const existingSet = getTerminalTabSet(db, input.rootId);
    if (!existingSet) {
      createTerminalTabSet(db, input.rootId);
      insertTerminalTab(db, input.rootId, input.maxSessions, input.legacySessionId);
    } else if (input.legacySessionId) {
      const existingTab = getTerminalTab(db, input.legacySessionId);
      if (existingTab && existingTab.rootId !== input.rootId) {
        throw new Error("Terminal session is not available");
      }
      if (!existingTab) {
        insertTerminalTab(db, input.rootId, input.maxSessions, input.legacySessionId);
      }
    }
    return getTerminalTabState(db, input.rootId, input.maxSessions);
  });
  return initialize.immediate();
}

export function createTerminalTab(
  db: ZosDatabase,
  input: { rootId: string; maxSessions: number }
): TerminalTabState {
  const create = db.transaction(() => {
    if (!getTerminalTabSet(db, input.rootId)) {
      createTerminalTabSet(db, input.rootId);
    }
    insertTerminalTab(db, input.rootId, input.maxSessions);
    return getTerminalTabState(db, input.rootId, input.maxSessions);
  });
  return create.immediate();
}

export function activateTerminalTab(
  db: ZosDatabase,
  input: { id: string; maxSessions: number }
): TerminalTabState | null {
  const activate = db.transaction(() => {
    const tab = getTerminalTab(db, input.id);
    if (!tab) {
      return null;
    }
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE terminal_tab_sets
      SET active_tab_id = ?, updated_at = ?
      WHERE root_id = ?
    `).run(tab.id, now, tab.rootId);
    return getTerminalTabState(db, tab.rootId, input.maxSessions);
  });
  return activate.immediate();
}

export function renameTerminalTab(
  db: ZosDatabase,
  input: { id: string; customTitle: string | null; maxSessions: number }
): TerminalTabState | null {
  const rename = db.transaction(() => {
    const tab = getTerminalTab(db, input.id);
    if (!tab) {
      return null;
    }
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE terminal_tabs
      SET custom_title = ?, updated_at = ?
      WHERE id = ?
    `).run(input.customTitle, now, tab.id);
    db.prepare("UPDATE terminal_tab_sets SET updated_at = ? WHERE root_id = ?").run(now, tab.rootId);
    return getTerminalTabState(db, tab.rootId, input.maxSessions);
  });
  return rename.immediate();
}

export function deleteTerminalTab(
  db: ZosDatabase,
  input: { id: string; maxSessions: number }
): TerminalTabState | null {
  const remove = db.transaction(() => {
    const tab = getTerminalTab(db, input.id);
    if (!tab) {
      return null;
    }
    const set = getTerminalTabSet(db, tab.rootId);
    const now = new Date().toISOString();
    if (set?.active_tab_id === tab.id) {
      const replacement = db.prepare(`
        SELECT id
        FROM terminal_tabs
        WHERE root_id = ? AND id <> ?
        ORDER BY
          CASE WHEN ordinal > ? THEN 0 ELSE 1 END,
          CASE WHEN ordinal > ? THEN ordinal ELSE -ordinal END
        LIMIT 1
      `).get(tab.rootId, tab.id, tab.ordinal, tab.ordinal) as { id: string } | undefined;
      db.prepare(`
        UPDATE terminal_tab_sets
        SET active_tab_id = ?, updated_at = ?
        WHERE root_id = ?
      `).run(replacement?.id ?? null, now, tab.rootId);
    } else {
      db.prepare("UPDATE terminal_tab_sets SET updated_at = ? WHERE root_id = ?").run(now, tab.rootId);
    }
    db.prepare("DELETE FROM terminal_tabs WHERE id = ?").run(tab.id);
    return getTerminalTabState(db, tab.rootId, input.maxSessions);
  });
  return remove.immediate();
}

function insertTerminalTab(
  db: ZosDatabase,
  rootId: string,
  maxSessions: number,
  requestedId?: string
): TerminalTab {
  const count = db.prepare("SELECT COUNT(*) AS count FROM terminal_tabs").get() as { count: number };
  if (count.count >= maxSessions) {
    throw new Error("Terminal session limit reached");
  }
  const set = getTerminalTabSet(db, rootId);
  if (!set) {
    throw new Error("Terminal tab set is not initialized");
  }
  const now = new Date().toISOString();
  const tab: TerminalTab = {
    id: requestedId ?? randomUUID(),
    rootId,
    ordinal: set.next_ordinal,
    customTitle: null,
    createdAt: now,
    updatedAt: now
  };
  db.prepare(`
    INSERT INTO terminal_tabs (id, root_id, ordinal, custom_title, created_at, updated_at)
    VALUES (@id, @rootId, @ordinal, @customTitle, @createdAt, @updatedAt)
  `).run(tab);
  db.prepare(`
    UPDATE terminal_tab_sets
    SET active_tab_id = ?, next_ordinal = ?, updated_at = ?
    WHERE root_id = ?
  `).run(tab.id, tab.ordinal + 1, now, rootId);
  return tab;
}

function createTerminalTabSet(db: ZosDatabase, rootId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO terminal_tab_sets (root_id, active_tab_id, next_ordinal, initialized_at, updated_at)
    VALUES (?, NULL, 1, ?, ?)
  `).run(rootId, now, now);
}

function listTerminalTabs(db: ZosDatabase, rootId: string): TerminalTab[] {
  const rows = db.prepare(`
    SELECT id, root_id, ordinal, custom_title, created_at, updated_at
    FROM terminal_tabs
    WHERE root_id = ?
    ORDER BY ordinal ASC
  `).all(rootId) as DbTerminalTabRow[];
  return rows.map(mapTerminalTab);
}

function getTerminalTabSet(db: ZosDatabase, rootId: string): DbTerminalTabSetRow | null {
  return (db.prepare(`
    SELECT root_id, active_tab_id, next_ordinal, initialized_at, updated_at
    FROM terminal_tab_sets
    WHERE root_id = ?
  `).get(rootId) as DbTerminalTabSetRow | undefined) ?? null;
}

function mapTerminalTab(row: DbTerminalTabRow): TerminalTab {
  return {
    id: row.id,
    rootId: row.root_id,
    ordinal: row.ordinal,
    customTitle: row.custom_title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
