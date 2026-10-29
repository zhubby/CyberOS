import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getShareSettings, openCyberOsDb, saveShareSettings, type CyberOsDatabase } from "@cyberos/db";
import { loadBootstrap, type CyberOsPaths } from "@cyberos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsSha256, upgradeShareCredential, verifySettingsUpgrade } from "./settings-upgrade.js";

let paths: CyberOsPaths;
let db: CyberOsDatabase;

beforeEach(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cyberos-settings-upgrade-"));
  paths = loadBootstrap({ CYBEROS_ENVIRONMENT: "development", CYBEROS_ROOT: root }).paths;
  db = openCyberOsDb(paths.databasePath);
  const record = saveShareSettings(db, { enabled: false, account: { username: "media", password: null }, shares: [] });
  record.account.password = "saved-secret";
  db.prepare("UPDATE system_settings SET value_json = ? WHERE key = 'share_settings'").run(JSON.stringify(record));
});

afterEach(() => {
  db.close();
  rmSync(paths.rootDir, { recursive: true, force: true });
});

describe("CyberOS 2.x share credential relocation", () => {
  it("preserves settings and revision, moves the credential privately, and verifies exact snapshots", () => {
    const before = settingsSha256(db);
    const cliOutput = execFileSync("sqlite3", [paths.databasePath,
      "PRAGMA busy_timeout=5000; SELECT length(key) || ':' || hex(key) || ':' || length(value_json) || ':' || hex(value_json) || ':' || length(updated_at) || ':' || hex(updated_at) FROM system_settings ORDER BY key;"]);
    expect(before).toBe(createHash("sha256").update(cliOutput).digest("hex"));
    const original = db.prepare("SELECT updated_at FROM system_settings WHERE key = 'share_settings'").get();
    upgradeShareCredential(db, paths);
    expect(getShareSettings(db)?.account).toEqual({ username: "media", password: null });
    expect(readFileSync(paths.sharePasswordPath, "utf8")).toBe("saved-secret");
    expect(statSync(paths.sharePasswordPath).mode & 0o777).toBe(0o600);
    expect(db.prepare("SELECT updated_at FROM system_settings WHERE key = 'share_settings'").get()).toEqual(original);
    const after = settingsSha256(db);
    expect(verifySettingsUpgrade(db, paths)).toBe(`${before} ${after}`);
    expect(readFileSync(path.join(paths.stateDir, "settings-upgrade.json"), "utf8")).not.toContain("saved-secret");
    upgradeShareCredential(db, paths);
    expect(settingsSha256(db)).toBe(after);
    expect(verifySettingsUpgrade(db, paths)).toBe(`${before} ${after}`);
    db.prepare("INSERT INTO system_settings VALUES (?, ?, ?)").run("other", "{}", "2026-01-01");
    expect(() => verifySettingsUpgrade(db, paths)).toThrow("verification failed");
  });

  it("retries safely when the credential was written before an interrupted transaction", () => {
    mkdirSync(paths.shareSecretsDir, { recursive: true });
    writeFileSync(paths.sharePasswordPath, "saved-secret", { mode: 0o600 });
    upgradeShareCredential(db, paths);
    expect(getShareSettings(db)?.account.password).toBeNull();
    writeFileSync(paths.sharePasswordPath, "changed-secret");
    expect(() => verifySettingsUpgrade(db, paths)).toThrow("verification failed");
  });

  it("refuses conflicting or unsafe secrets without changing the settings", () => {
    mkdirSync(paths.shareSecretsDir, { recursive: true });
    writeFileSync(paths.sharePasswordPath, "different-secret", { mode: 0o600 });
    const before = settingsSha256(db);
    expect(() => upgradeShareCredential(db, paths)).toThrow("conflicts");
    expect(settingsSha256(db)).toBe(before);
    chmodSync(paths.sharePasswordPath, 0o644);
    expect(() => upgradeShareCredential(db, paths)).toThrow("private regular");
    rmSync(paths.sharePasswordPath);
    symlinkSync(path.join(paths.stateDir, "outside"), paths.sharePasswordPath);
    expect(() => upgradeShareCredential(db, paths)).toThrow("private regular");
    expect(settingsSha256(db)).toBe(before);
  });

  it("leaves unrelated damage for the settings attention and repair path", () => {
    db.prepare("UPDATE system_settings SET value_json = ? WHERE key = 'share_settings'")
      .run(JSON.stringify({ enabled: "broken", account: { password: "saved-secret" } }));
    const before = settingsSha256(db);
    upgradeShareCredential(db, paths);
    expect(() => getShareSettings(db)).toThrow("2.0 format");
    expect(settingsSha256(db)).toBe(before);
    expect(() => verifySettingsUpgrade(db, paths)).toThrow("verification failed");
  });
});
