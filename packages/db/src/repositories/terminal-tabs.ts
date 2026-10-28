import { randomUUID } from "node:crypto";
import type { TerminalTab, TerminalTabState } from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";

interface DbTerminalTabRow {
  id: string;
  ordinal: number;
  custom_title: string | null;
  created_at: string;
  updated_at: string;
}

interface DbTerminalTabStateRow {
  active_tab_id: string | null;
  next_ordinal: number;
  initialized_at: string;
  updated_at: string;
}

export function getTerminalTab(db: CyberOsDatabase, id: string): TerminalTab | null {
  const row = db.prepare(`
    SELECT id, ordinal, custom_title, created_at, updated_at
    FROM terminal_tabs
    WHERE id = ?
  `).get(id) as DbTerminalTabRow | undefined;
  return row ? mapTerminalTab(row) : null;
}

export function getTerminalTabState(db: CyberOsDatabase, maxSessions: number): TerminalTabState {
  const state = getTerminalState(db);
  return {
    initialized: Boolean(state),
    tabs: listTerminalTabs(db),
    activeTabId: state?.active_tab_id ?? null,
    maxSessions
  };
}

export function initializeTerminalTabs(
  db: CyberOsDatabase,
  input: { maxSessions: number }
): TerminalTabState {
  const initialize = db.transaction(() => {
    if (!getTerminalState(db)) {
      createTerminalState(db);
      insertTerminalTab(db, input.maxSessions);
    }
    return getTerminalTabState(db, input.maxSessions);
  });
  return initialize.immediate();
}

export function createTerminalTab(
  db: CyberOsDatabase,
  input: { maxSessions: number }
): TerminalTabState {
  const create = db.transaction(() => {
    if (!getTerminalState(db)) createTerminalState(db);
    insertTerminalTab(db, input.maxSessions);
    return getTerminalTabState(db, input.maxSessions);
  });
  return create.immediate();
}

export function activateTerminalTab(
  db: CyberOsDatabase,
  input: { id: string; maxSessions: number }
): TerminalTabState | null {
  const activate = db.transaction(() => {
    const tab = getTerminalTab(db, input.id);
    if (!tab) return null;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE terminal_tab_state
      SET active_tab_id = ?, updated_at = ?
      WHERE id = 1
    `).run(tab.id, now);
    return getTerminalTabState(db, input.maxSessions);
  });
  return activate.immediate();
}

export function renameTerminalTab(
  db: CyberOsDatabase,
  input: { id: string; customTitle: string | null; maxSessions: number }
): TerminalTabState | null {
  const rename = db.transaction(() => {
    const tab = getTerminalTab(db, input.id);
    if (!tab) return null;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE terminal_tabs
      SET custom_title = ?, updated_at = ?
      WHERE id = ?
    `).run(input.customTitle, now, tab.id);
    db.prepare("UPDATE terminal_tab_state SET updated_at = ? WHERE id = 1").run(now);
    return getTerminalTabState(db, input.maxSessions);
  });
  return rename.immediate();
}

export function deleteTerminalTab(
  db: CyberOsDatabase,
  input: { id: string; maxSessions: number }
): TerminalTabState | null {
  const remove = db.transaction(() => {
    const tab = getTerminalTab(db, input.id);
    if (!tab) return null;
    const state = getTerminalState(db);
    const now = new Date().toISOString();
    if (state?.active_tab_id === tab.id) {
      const replacement = db.prepare(`
        SELECT id
        FROM terminal_tabs
        WHERE id <> ?
        ORDER BY
          CASE WHEN ordinal > ? THEN 0 ELSE 1 END,
          CASE WHEN ordinal > ? THEN ordinal ELSE -ordinal END
        LIMIT 1
      `).get(tab.id, tab.ordinal, tab.ordinal) as { id: string } | undefined;
      db.prepare(`
        UPDATE terminal_tab_state
        SET active_tab_id = ?, updated_at = ?
        WHERE id = 1
      `).run(replacement?.id ?? null, now);
    } else {
      db.prepare("UPDATE terminal_tab_state SET updated_at = ? WHERE id = 1").run(now);
    }
    db.prepare("DELETE FROM terminal_tabs WHERE id = ?").run(tab.id);
    return getTerminalTabState(db, input.maxSessions);
  });
  return remove.immediate();
}

function insertTerminalTab(
  db: CyberOsDatabase,
  maxSessions: number,
  requestedId?: string
): TerminalTab {
  const count = db.prepare("SELECT COUNT(*) AS count FROM terminal_tabs").get() as { count: number };
  if (count.count >= maxSessions) {
    throw new Error("Terminal session limit reached");
  }
  const state = getTerminalState(db);
  if (!state) throw new Error("Terminal tab state is not initialized");
  const now = new Date().toISOString();
  const tab: TerminalTab = {
    id: requestedId ?? randomUUID(),
    ordinal: state.next_ordinal,
    customTitle: null,
    createdAt: now,
    updatedAt: now
  };
  db.prepare(`
    INSERT INTO terminal_tabs (id, ordinal, custom_title, created_at, updated_at)
    VALUES (@id, @ordinal, @customTitle, @createdAt, @updatedAt)
  `).run(tab);
  db.prepare(`
    UPDATE terminal_tab_state
    SET active_tab_id = ?, next_ordinal = ?, updated_at = ?
    WHERE id = 1
  `).run(tab.id, tab.ordinal + 1, now);
  return tab;
}

function createTerminalState(db: CyberOsDatabase): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO terminal_tab_state (id, active_tab_id, next_ordinal, initialized_at, updated_at)
    VALUES (1, NULL, 1, ?, ?)
  `).run(now, now);
}

function listTerminalTabs(db: CyberOsDatabase): TerminalTab[] {
  const rows = db.prepare(`
    SELECT id, ordinal, custom_title, created_at, updated_at
    FROM terminal_tabs
    ORDER BY ordinal ASC
  `).all() as DbTerminalTabRow[];
  return rows.map(mapTerminalTab);
}

function getTerminalState(db: CyberOsDatabase): DbTerminalTabStateRow | null {
  return (db.prepare(`
    SELECT active_tab_id, next_ordinal, initialized_at, updated_at
    FROM terminal_tab_state
    WHERE id = 1
  `).get() as DbTerminalTabStateRow | undefined) ?? null;
}

function mapTerminalTab(row: DbTerminalTabRow): TerminalTab {
  return {
    id: row.id,
    ordinal: row.ordinal,
    customTitle: row.custom_title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
