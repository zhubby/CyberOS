#!/usr/bin/env node

import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const BUILTIN_MAPPINGS = [
  ["/var/lib/sigmaos/vmstore", "/zos/vm"],
  ["/var/lib/sigmaos", "/zos/state"],
  ["/var/lib/sigmaos-termux", "/zos/home/termux"],
  ["/var/lib/sigmaos-vod-player", "/zos/state/vod-player"],
  ["/var/lib/sigmaos-share", "/zos/home/share"],
  ["/etc/sigmaos", "/zos/config"],
  ["/run/sigmaos", "/run/zos"]
];

const SCALAR_COLUMNS = [
  ["nas_roots", "path"],
  ["agent_provider_sessions", "session_file"],
  ["trash_entries", "trash_path"],
  ["file_operations", "source_path"],
  ["file_operations", "target_path"],
  ["storage_operations", "target_id"],
  ["photostaff_publish_journal", "thumbnail_temp_path"],
  ["photostaff_publish_journal", "thumbnail_path"],
  ["photostaff_publish_journal", "preview_temp_path"],
  ["photostaff_publish_journal", "preview_path"]
];

const JSON_COLUMNS = [
  ["trash_entries", "metadata_json"],
  ["file_operations", "metadata_json"],
  ["pending_approvals", "proposal_json"],
  ["storage_operations", "metadata_json"],
  ["vm_operations", "metadata_json"]
];

export function parsePathMappings(contents) {
  const mappings = [...BUILTIN_MAPPINGS];
  for (const line of contents.split(/\r?\n/u)) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 2) throw new Error(`invalid migration mapping: ${line}`);
    mappings.push(fields);
  }

  const bySource = new Map();
  for (const [source, target] of mappings) {
    if (!path.posix.isAbsolute(source) || !path.posix.isAbsolute(target) || source === "/" || target === "/") {
      throw new Error(`invalid absolute path mapping: ${source} -> ${target}`);
    }
    const normalizedSource = path.posix.normalize(source).replace(/\/+$/u, "");
    const normalizedTarget = path.posix.normalize(target).replace(/\/+$/u, "");
    const existing = bySource.get(normalizedSource);
    if (existing && existing !== normalizedTarget) {
      throw new Error(`conflicting migration mapping for ${normalizedSource}`);
    }
    bySource.set(normalizedSource, normalizedTarget);
  }
  return [...bySource].sort(([left], [right]) => right.length - left.length);
}

export function migrateLegacyDatabase(databasePath, mappingContents) {
  const mappings = parsePathMappings(mappingContents);
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());
  const report = { scalarValues: 0, jsonDocuments: 0, pathValues: 0 };

  const migrate = database.transaction(() => {
    for (const [table, column] of SCALAR_COLUMNS) {
      if (!tables.has(table) || !hasColumn(database, table, column)) continue;
      const rows = database.prepare(`SELECT rowid AS rowId, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all();
      const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        const migrated = remapPath(row.value, mappings);
        if (migrated === row.value) continue;
        update.run(migrated, row.rowId);
        report.scalarValues += 1;
        report.pathValues += 1;
      }
    }

    for (const [table, column] of JSON_COLUMNS) {
      if (!tables.has(table) || !hasColumn(database, table, column)) continue;
      const rows = database.prepare(`SELECT rowid AS rowId, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all();
      const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        const parsed = JSON.parse(row.value);
        const previousPathCount = report.pathValues;
        const migrated = remapJsonValue(parsed, mappings, report);
        if (report.pathValues === previousPathCount) continue;
        update.run(JSON.stringify(migrated), row.rowId);
        report.jsonDocuments += 1;
      }
    }
  });

  try {
    migrate.immediate();
    const foreignKeyViolations = database.pragma("foreign_key_check");
    if (foreignKeyViolations.length > 0) {
      throw new Error(`migrated database has ${foreignKeyViolations.length} foreign key violation(s)`);
    }
    const quickCheck = database.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") throw new Error(`migrated database quick check failed: ${String(quickCheck)}`);
    return report;
  } finally {
    database.close();
  }
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

function remapJsonValue(value, mappings, report) {
  if (typeof value === "string") {
    const migrated = remapPath(value, mappings);
    if (migrated !== value) report.pathValues += 1;
    return migrated;
  }
  if (Array.isArray(value)) return value.map((entry) => remapJsonValue(entry, mappings, report));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remapJsonValue(entry, mappings, report)]));
}

export function remapPath(value, mappings) {
  if (typeof value !== "string" || !value.startsWith("/")) return value;
  for (const [source, target] of mappings) {
    if (value === source) return target;
    if (value.startsWith(`${source}/`)) return `${target}${value.slice(source.length)}`;
  }
  return value;
}

async function main() {
  const [databasePath, mappingsPath, reportPath] = process.argv.slice(2);
  if (!databasePath || !mappingsPath || !reportPath) {
    throw new Error("usage: zos-migrate-database.mjs <database> <path-mappings> <report-json>");
  }
  const databaseStat = await lstat(databasePath);
  const mappingsStat = await lstat(mappingsPath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error("database must be a regular file");
  if (!mappingsStat.isFile() || mappingsStat.isSymbolicLink()) throw new Error("path mappings must be a regular file");
  const mappings = await readFile(mappingsPath, "utf8");
  const report = migrateLegacyDatabase(databasePath, mappings);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
