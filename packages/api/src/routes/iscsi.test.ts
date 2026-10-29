import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listOperationNotifications, openCyberOsDb } from "@cyberos/db";
import { loadCyberOsRuntime, type IscsiAction, type IscsiSummary } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { HostdRequestError } from "../lib/hostd-client.js";
import { registerIscsiRoutes } from "./iscsi.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const snapshot: IscsiSummary = {
  collectedAt: "2026-10-29T02:00:00Z", revision: "a".repeat(64), available: true,
  error: null, listenAddresses: ["192.168.1.5"], pools: [], targets: [], images: []
};
const action: IscsiAction = {
  action: "create_target", confirmed: true, expectedRevision: snapshot.revision,
  name: "Disk", address: "192.168.1.5", port: 3260, initiators: ["iqn.1991-05.com.microsoft:desktop"],
  chap: { enabled: true, username: "storage", password: "123456789012" }, enabled: true
};

async function setup(mutate: (input: IscsiAction) => Promise<IscsiSummary> = async () => snapshot) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-iscsi-api-"));
  temporaryDirectories.push(root);
  const config = loadCyberOsRuntime({ CYBEROS_ROOT: root }, root);
  const db = openCyberOsDb(config.paths.databasePath);
  const server = Fastify();
  registerIscsiRoutes(server, { config, db } as ApiRouteContext, { read: async () => snapshot, mutate });
  server.addHook("onClose", async () => { db.close(); });
  return { server, db };
}

describe("iSCSI API", () => {
  it("returns a public snapshot and records successful mutations without credentials", async () => {
    const { server, db } = await setup();
    expect((await server.inject({ method: "GET", url: "/api/storage/iscsi" })).json()).toEqual({ summary: snapshot });
    const response = await server.inject({ method: "POST", url: "/api/storage/iscsi/actions", payload: action });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ summary: snapshot });
    const notifications = listOperationNotifications(db);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: "storage", status: "succeeded" });
    expect(JSON.stringify(notifications)).not.toContain("123456789012");
    await server.close();
  });

  it("rejects malformed and unconfirmed writes before invoking hostd", async () => {
    const { server, db } = await setup(async () => { throw new Error("must not run"); });
    for (const payload of [{ ...action, confirmed: false }, { ...action, expectedRevision: "old" },
      { ...action, address: "0.0.0.0" }, { ...action, address: "not an IP" }, { ...action, extra: true }]) {
      const response = await server.inject({ method: "POST", url: "/api/storage/iscsi/actions", payload });
      expect(response.statusCode).toBe(400);
    }
    expect(listOperationNotifications(db)).toHaveLength(0);
    await server.close();
  });

  it("preserves conflict codes and records safe failures even if hostd returns a secret", async () => {
    const { server, db } = await setup(async () => {
      throw new HostdRequestError("password=123456789012", 409, "conflict");
    });
    const response = await server.inject({ method: "POST", url: "/api/storage/iscsi/actions", payload: action });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("conflict");
    expect(JSON.stringify(response.json())).not.toContain("123456789012");
    const notifications = listOperationNotifications(db);
    expect(notifications[0]?.status).toBe("failed");
    expect(JSON.stringify(notifications)).not.toContain("123456789012");
    await server.close();
  });

  it("returns a controlled unavailable response for hostd transport failures", async () => {
    const { server } = await setup(async () => { throw new Error("raw internal path"); });
    const response = await server.inject({ method: "POST", url: "/api/storage/iscsi/actions", payload: action });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).not.toContain("raw internal path");
    await server.close();
  });

  it.each([
    "Storage pool has insufficient free space",
    "iSCSI requires a root-owned protected .cyberos directory",
    "iSCSI internal directory protection is unavailable",
    "Filesystem cannot protect iSCSI internal directory entries",
    "Reapply ancestor NFS exports with root squashing before using iSCSI images"
  ])("keeps the operational failure actionable: %s", async (message) => {
    const { server } = await setup(async () => {
      throw new HostdRequestError(message, 409, "conflict");
    });
    const response = await server.inject({ method: "POST", url: "/api/storage/iscsi/actions", payload: action });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe(message);
    await server.close();
  });
});
