import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTvSettings, openCyberOsDb, type CyberOsDatabase } from "@cyberos/db";
import { loadCyberOsRuntime } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import type { TvModeRuntime } from "../lib/tv-mode.js";
import { registerSettingsRoutes } from "./settings.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-settings-routes-"));
  await mkdir(path.join(tempDir, "data"), { recursive: true });
  await mkdir(path.join(tempDir, "state"), { recursive: true });
  db = openCyberOsDb(path.join(tempDir, "state", "cyberos.sqlite"));
});

afterEach(async () => {
  if (db.open) db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("settings routes", () => {
  it("accepts write-only audio tokens without exposing them in any settings response", async () => {
    const server = createServer(db);
    const saved = await server.inject({ method: "PATCH", url: "/api/settings/audio", payload: { cyberAudioToken: "sensitive-voice-token" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.tokenConfigured).toBe(true);
    expect(saved.body).not.toContain("sensitive-voice-token");
    const read = await server.inject({ method: "GET", url: "/api/settings/audio" });
    expect(read.body).not.toContain("cyberAudioToken");
    expect((await server.inject({ method: "PATCH", url: "/api/settings/audio", payload: { cyberAudioToken: null } })).json().settings.tokenConfigured).toBe(false);
    await server.close();
  });
  it("persists the CyberAudio address across database reopen and allows clearing it", async () => {
    let server = createServer(db);
    const initial = await server.inject({ method: "GET", url: "/api/settings/audio" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toMatchObject({
      cyberAudioBaseUrl: null,
      enabled: false,
      tokenConfigured: false,
      updatedAt: new Date(0).toISOString()
    });

    const saved = await server.inject({
      method: "PATCH", url: "/api/settings/audio",
      payload: { cyberAudioBaseUrl: "  https://audio.example.com:8443/  " }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.cyberAudioBaseUrl).toBe("https://audio.example.com:8443");
    expect(Date.parse(saved.json().settings.updatedAt)).toBeGreaterThan(0);
    await server.close();
    db.close();
    db = openCyberOsDb(path.join(tempDir, "state", "cyberos.sqlite"));
    server = createServer(db);
    expect((await server.inject({ method: "GET", url: "/api/settings/audio" })).json()).toEqual(saved.json());

    for (const cyberAudioBaseUrl of ["http://192.168.1.2:8765", "https://audio.example.com/voice", "http://[::1]:8765"]) {
      const response = await server.inject({ method: "PATCH", url: "/api/settings/audio", payload: { cyberAudioBaseUrl } });
      expect(response.statusCode).toBe(200);
      expect(response.json().settings.cyberAudioBaseUrl).toBe(cyberAudioBaseUrl);
    }
    for (const cyberAudioBaseUrl of [null, "   "]) {
      const cleared = await server.inject({ method: "PATCH", url: "/api/settings/audio", payload: { cyberAudioBaseUrl } });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().settings.cyberAudioBaseUrl).toBeNull();
    }
    await server.close();
  });

  it("rejects invalid audio edits without replacing the saved address", async () => {
    const server = createServer(db);
    const payload = { cyberAudioBaseUrl: "http://audio.local:8765" };
    const saved = await server.inject({ method: "PATCH", url: "/api/settings/audio", payload });
    expect(saved.statusCode).toBe(200);
    for (const cyberAudioBaseUrl of [
      "audio.local:8765", "ftp://audio.local", "javascript:alert(1)", "https://user:secret@audio.local",
      "https://audio.local?token=secret", "https://audio.local/#fragment", "http://audio.local:65536",
      "http://audio.local/a b", "http://audio.local/\npath", "https://audio.local/\\path",
      `https://audio.local/${"a".repeat(2048)}`, `https://audio.local/${"中".repeat(240)}`, 123, true, [], {}
    ]) {
      const invalid = await server.inject({ method: "PATCH", url: "/api/settings/audio", payload: { cyberAudioBaseUrl } });
      expect(invalid.statusCode, JSON.stringify(cyberAudioBaseUrl)).toBe(400);
      expect(invalid.body).not.toContain("secret");
    }
    for (const invalidBody of [{ extra: true }, { updatedAt: "2026-01-01" }, [], null, "invalid"]) {
      expect((await server.inject({
        method: "PATCH", url: "/api/settings/audio",
        headers: { "content-type": "application/json" }, payload: JSON.stringify(invalidBody)
      })).statusCode).toBe(400);
    }
    expect((await server.inject({ method: "GET", url: "/api/settings/audio" })).json()).toEqual(saved.json());
    await server.close();
  });

  it("reports corrupted audio settings and lets a valid edit repair them", async () => {
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("audio_settings", JSON.stringify({ cyberAudioBaseUrl: 42 }), new Date().toISOString());
    const server = createServer(db);
    const corrupted = await server.inject({ method: "GET", url: "/api/settings/audio" });
    expect(corrupted.statusCode).toBe(409);
    expect(corrupted.json()).toMatchObject({ state: "attention" });
    const repaired = await server.inject({
      method: "PATCH", url: "/api/settings/audio", payload: { cyberAudioBaseUrl: "https://audio.example.com" }
    });
    expect(repaired.statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/settings/audio" })).json()).toEqual(repaired.json());
    await server.close();
  });

  it("persists one proxy endpoint and rejects invalid edits without replacing it", async () => {
    const server = createServer(db);
    const initial = await server.inject({ method: "GET", url: "/api/settings/proxy" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toMatchObject({ protocol: "http", host: null, port: null });
    for (const host of ["proxy.example.com", "192.168.1.2", "::1"]) {
      const saved = await server.inject({ method: "PATCH", url: "/api/settings/proxy", payload: { protocol: "socks5", host, port: 1080 } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().settings).toMatchObject({ protocol: "socks5", host, port: 1080 });
    }
    for (const payload of [{ port: 0 }, { port: 65536 }, { port: "1080" }, { protocol: "ftp" }, { protocol: ["http"] }, { host: "[proxy.local" }, { host: "user:password@proxy.local" }, { host: "proxy.local/path" }, { host: Array(5).fill("中".repeat(49)).join(".") }, { extra: true }]) {
      expect((await server.inject({ method: "PATCH", url: "/api/settings/proxy", payload })).statusCode).toBe(400);
    }
    expect((await server.inject({ method: "GET", url: "/api/settings/proxy" })).json().settings)
      .toMatchObject({ protocol: "socks5", host: "::1", port: 1080 });
    await server.close();
  });

  it("offers backup directory browsing within available backup roots", async () => {
    const server = createServer(db);
    const backupRoot = testConfig().paths.backupRoot;
    await mkdir(path.join(backupRoot, "repository"), { recursive: true });
    const canonicalRoot = await realpath(backupRoot);
    const roots = await server.inject({ method: "GET", url: "/api/settings/backup/directories" });
    expect(roots.statusCode).toBe(200);
    expect(roots.json().roots).toContainEqual(expect.objectContaining({ id: canonicalRoot, path: canonicalRoot }));
    const query = new URLSearchParams({ root: canonicalRoot, path: canonicalRoot });
    const listing = await server.inject({ method: "GET", url: `/api/settings/backup/directories?${query}` });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().entries).toEqual([expect.objectContaining({ name: "repository", kind: "directory" })]);
    query.set("path", testConfig().paths.stateDir);
    const escaped = await server.inject({ method: "GET", url: `/api/settings/backup/directories?${query}` });
    expect(escaped.statusCode).toBe(403);
    await server.close();
  });

  it("uses lazy defaults and repairs corrupted monitoring settings", async () => {
    const server = createServer(db);
    const initial = await server.inject({ method: "GET", url: "/api/settings/monitoring" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toMatchObject({ enabled: true, rawRetentionDays: 2 });

    const initialTv = await server.inject({ method: "GET", url: "/api/settings/tv" });
    expect(initialTv.statusCode).toBe(200);
    expect(initialTv.json().settings).toMatchObject({ enabled: true, videoOutput: "wayland" });

    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("monitoring_settings", JSON.stringify({ enabled: "broken" }), new Date().toISOString());
    const corrupted = await server.inject({ method: "GET", url: "/api/settings/monitoring" });
    expect(corrupted.statusCode).toBe(409);
    expect(corrupted.json()).toMatchObject({ state: "attention" });

    const repaired = await server.inject({
      method: "PATCH",
      url: "/api/settings/monitoring",
      payload: { enabled: false, rawRetentionDays: 3 }
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().settings).toMatchObject({ enabled: false, rawRetentionDays: 3 });
    await server.close();
  });

  it("stores backup credentials without returning their contents", async () => {
    const server = createServer(db);
    const response = await server.inject({
      method: "PUT",
      url: "/api/settings/backup/credential",
      payload: { password: "top-secret-value" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toMatchObject({ passwordConfigured: true, enabled: false, validatedAt: null });
    expect(response.body).not.toContain("top-secret-value");
    const config = testConfig();
    expect(await readFile(config.paths.backupPasswordPath, "utf8")).toBe("top-secret-value\n");
    await server.close();
  });

  it("does not replace a backup credential when database invalidation fails", async () => {
    const config = testConfig();
    await mkdir(path.dirname(config.paths.backupPasswordPath), { recursive: true });
    await writeFile(config.paths.backupPasswordPath, "existing-secret\n", { mode: 0o600 });
    const server = createServer(db);
    db.close();

    const response = await server.inject({
      method: "PUT",
      url: "/api/settings/backup/credential",
      payload: { password: "replacement-secret" }
    });

    expect(response.statusCode).toBe(500);
    expect(await readFile(config.paths.backupPasswordPath, "utf8")).toBe("existing-secret\n");
    await server.close();
  });

  it("reports corrupted settings and allows a PATCH to repair them", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("download_settings", JSON.stringify({ concurrency: 2 }), now);
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("docker_settings", JSON.stringify({ enabled: "broken" }), now);
    const server = createServer(db);

    const downloads = await server.inject({ method: "GET", url: "/api/settings/downloads" });
    const docker = await server.inject({ method: "GET", url: "/api/settings/docker" });
    expect(downloads.statusCode).toBe(409);
    expect(downloads.json()).toMatchObject({ state: "attention" });
    expect(docker.statusCode).toBe(409);
    expect(docker.json()).toMatchObject({ state: "attention" });

    const repairedDownloads = await server.inject({
      method: "PATCH",
      url: "/api/settings/downloads",
      payload: { concurrency: 2 }
    });
    const repairedDocker = await server.inject({
      method: "PATCH",
      url: "/api/settings/docker",
      payload: { enabled: true }
    });
    expect(repairedDownloads.statusCode).toBe(200);
    expect(repairedDownloads.json().settings).toMatchObject({ concurrency: 2 });
    expect(repairedDocker.statusCode).toBe(200);
    expect(repairedDocker.json().settings).toMatchObject({ enabled: true });
    await server.close();
  });

  it("repairs a corrupted model provider record through PATCH", async () => {
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("model_provider", JSON.stringify({ providerName: 42 }), new Date().toISOString());
    const server = createServer(db);

    const corrupted = await server.inject({ method: "GET", url: "/api/settings/model-provider" });
    expect(corrupted.statusCode).toBe(409);
    expect(corrupted.json()).toMatchObject({ state: "attention" });

    const repaired = await server.inject({
      method: "PATCH",
      url: "/api/settings/model-provider",
      payload: { providerName: "openai", model: "gpt-5" }
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().settings).toMatchObject({ providerName: "openai", model: "gpt-5" });
    await server.close();
  });

  it("requires confirmation and leaves the database unchanged when host application fails", async () => {
    const tvMode: TvModeRuntime = { apply: vi.fn(async () => { throw new Error("host apply failed"); }) };
    const server = createServer(db, tvMode);
    const unconfirmed = await server.inject({
      method: "PATCH",
      url: "/api/settings/tv",
      payload: { enabled: false }
    });
    expect(unconfirmed.statusCode).toBe(400);

    const failed = await server.inject({
      method: "PATCH",
      url: "/api/settings/tv",
      payload: { enabled: false, confirmed: true }
    });
    expect(failed.statusCode).toBe(503);
    expect(getTvSettings(db)).toBeNull();
    expect(tvMode.apply).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("rolls the host state back when TV settings persistence fails", async () => {
    const localDb = openCyberOsDb(path.join(tempDir, "rollback.sqlite"));
    const apply = vi.fn(async () => undefined);
    const server = createServer(localDb, { apply });
    localDb.close();

    const response = await server.inject({
      method: "PATCH",
      url: "/api/settings/tv",
      payload: { enabled: false, confirmed: true }
    });
    expect(response.statusCode).toBe(500);
    expect(apply.mock.calls).toEqual([[false], [true]]);
    await server.close();
  });

  it("reapplies a confirmed TV mode even when it matches the saved default", async () => {
    const apply = vi.fn(async () => undefined);
    const server = createServer(db, { apply });
    const response = await server.inject({
      method: "PATCH", url: "/api/settings/tv", payload: { enabled: true, confirmed: true }
    });
    expect(response.statusCode).toBe(200);
    expect(apply.mock.calls).toEqual([[true]]);
    expect(getTvSettings(db)?.enabled).toBe(true);
    await server.close();
  });
});

function testConfig() {
  return loadCyberOsRuntime({ CYBEROS_ROOT: tempDir }, tempDir);
}

function createServer(database: CyberOsDatabase, tvMode?: TvModeRuntime) {
  const server = Fastify();
  registerSettingsRoutes(server, {
    config: testConfig(),
    db: database,
    monitoring: {} as ApiRouteContext["monitoring"],
    ...(tvMode ? { tvMode } : {})
  });
  return server;
}
