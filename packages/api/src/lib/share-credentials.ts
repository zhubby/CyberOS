import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CyberOsDatabase } from "@cyberos/db";
import { getShareSettings, saveShareSettings } from "@cyberos/db";
import type { CyberOsRuntime, ShareSettingsRecord } from "@cyberos/shared";
import { defaultShareSettings } from "./settings.js";

export async function loadEffectiveShareSettings(
  db: CyberOsDatabase,
  config: CyberOsRuntime
): Promise<ShareSettingsRecord> {
  const stored = getShareSettings(db) ?? defaultShareSettings(config);
  return withSharePassword(stored, await readSharePassword(config.paths.sharePasswordPath));
}

export async function loadRepairableShareSettings(
  db: CyberOsDatabase,
  config: CyberOsRuntime
): Promise<ShareSettingsRecord> {
  let stored: ShareSettingsRecord;
  try {
    stored = getShareSettings(db) ?? defaultShareSettings(config);
  } catch {
    stored = defaultShareSettings(config);
  }
  let password: string | null;
  try {
    password = await readSharePassword(config.paths.sharePasswordPath);
  } catch {
    password = null;
  }
  return withSharePassword(stored, password);
}

export async function persistShareSettings(
  db: CyberOsDatabase,
  config: CyberOsRuntime,
  settings: ShareSettingsRecord
): Promise<ShareSettingsRecord> {
  const previousPassword = await readSharePassword(config.paths.sharePasswordPath);
  const nextPassword = settings.account.password;
  await writeSharePassword(config.paths.sharePasswordPath, nextPassword);
  try {
    const { updatedAt: _updatedAt, ...record } = withoutSharePassword(settings);
    const stored = saveShareSettings(db, record);
    return withSharePassword(stored, nextPassword);
  } catch (error) {
    await writeSharePassword(config.paths.sharePasswordPath, previousPassword);
    throw error;
  }
}

export function withoutSharePassword(settings: ShareSettingsRecord): ShareSettingsRecord {
  return {
    ...settings,
    account: { ...settings.account, password: null }
  };
}

export function withSharePassword(
  settings: ShareSettingsRecord,
  password: string | null
): ShareSettingsRecord {
  return {
    ...settings,
    account: { ...settings.account, password }
  };
}

export async function readSharePassword(filePath: string): Promise<string | null> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error("Share password file must be a private regular file");
    }
    const password = await readFile(filePath, "utf8");
    if (!password || password.includes("\0")) throw new Error("Share password file is invalid");
    return password;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function writeSharePassword(filePath: string, password: string | null): Promise<void> {
  if (password === null) {
    await rm(filePath, { force: true });
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, password, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
