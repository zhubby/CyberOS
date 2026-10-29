import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getShareSettings, type CyberOsDatabase } from "@cyberos/db";
import type { CyberOsPaths } from "@cyberos/shared";

const UPGRADE = "share-secret-v1";

export function settingsSha256(db: CyberOsDatabase): string {
  // Match the installed deployment helper, including sqlite3's busy_timeout output.
  const rows = db.prepare(`
    SELECT length(key) || ':' || hex(key) || ':' || length(value_json) || ':' || hex(value_json) || ':' || length(updated_at) || ':' || hex(updated_at)
    FROM system_settings ORDER BY key
  `).pluck().all() as string[];
  return createHash("sha256").update(`5000\n${rows.map((row) => `${row}\n`).join("")}`).digest("hex");
}

/** Relocate a CyberOS 2.x credential without changing sharing configuration or revision. */
export function upgradeShareCredential(db: CyberOsDatabase, paths: CyberOsPaths): void {
  db.transaction(() => {
    const row = db.prepare("SELECT value_json FROM system_settings WHERE key = 'share_settings'")
      .get() as { value_json: string } | undefined;
    if (!row) return;
    let parsed: unknown;
    try { parsed = JSON.parse(row.value_json); } catch { return; }
    if (!isRecord(parsed) || !isRecord(parsed.account)) return;
    const settings = parsed;
    const account = parsed.account;
    const password = account.password;
    if (typeof password !== "string") return;
    if (!password || /[\r\n\0]/u.test(password)) return;

    const beforeSha256 = settingsSha256(db);
    account.password = null;
    db.prepare("UPDATE system_settings SET value_json = ? WHERE key = 'share_settings'")
      .run(JSON.stringify(settings));
    // Reject other damage rather than silently dropping definitions or fixing unrelated fields.
    try {
      getShareSettings(db);
    } catch {
      db.prepare("UPDATE system_settings SET value_json = ? WHERE key = 'share_settings'").run(row.value_json);
      return;
    }

    const existing = privateFile(paths.sharePasswordPath);
    if (existing !== null && existing !== password) {
      throw new Error("Stored share credential conflicts with the private credential file");
    }
    if (existing === null) writePrivateFile(paths.sharePasswordPath, password);
    writePrivateFile(path.join(paths.stateDir, "settings-upgrade.json"), JSON.stringify({
      upgrade: UPGRADE,
      beforeSha256,
      afterSha256: settingsSha256(db),
      credentialSha256: createHash("sha256").update(password).digest("hex")
    }));
  }).immediate();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function verifySettingsUpgrade(db: CyberOsDatabase, paths: CyberOsPaths): string {
  const receipt = JSON.parse(privateFile(path.join(paths.stateDir, "settings-upgrade.json")) ?? "null") as {
    upgrade?: unknown; beforeSha256?: unknown; afterSha256?: unknown; credentialSha256?: unknown;
  } | null;
  if (
    receipt?.upgrade !== UPGRADE
    || typeof receipt.beforeSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.beforeSha256)
    || receipt.afterSha256 !== settingsSha256(db)
    || receipt.credentialSha256 !== createHash("sha256").update(privateFile(paths.sharePasswordPath) ?? "").digest("hex")
  ) throw new Error("Settings upgrade verification failed");
  return `${receipt.beforeSha256} ${receipt.afterSha256}`;
}

function privateFile(filePath: string): string | null {
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error("Settings upgrade requires private regular files");
    }
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function writePrivateFile(filePath: string, value: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}
