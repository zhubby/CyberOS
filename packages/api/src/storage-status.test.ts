import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCyberOsDb, type CyberOsDatabase } from "@cyberos/db";
import { loadCyberOsRuntime } from "@cyberos/shared";
import { buildServer } from "./server.js";
import { collectSystemStorage, type SystemCommandRunner } from "./lib/system-management.js";
import { resolveStoragePoolScope } from "./lib/storage-scope.js";

let tempDir: string;
let dataRoot: string;
let poolPath: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cy-st-"));
  dataRoot = path.join(tempDir, "data");
  poolPath = path.join(dataRoot, "pool-1");
  await mkdir(poolPath, { recursive: true });
  db = openCyberOsDb(path.join(tempDir, "state.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("storage status readiness", () => {
  it("resolves a storage scope while an unrelated SMART inventory is pending", async () => {
    const fixture = storageFixture();
    const system = { commandRunner: fixture.runner };
    const inventory = collectSystemStorage(system);
    await fixture.smartStarted;
    const scope = resolveStoragePoolScope(dataRoot, system, "pool-1");
    try {
      const result = await beforeDeadline(scope);
      expect(result?.pool).toMatchObject({
        id: "pool-1",
        name: "nas:pool-1",
        status: "ready",
        mountpoint: poolPath,
        filesystem: "ext4",
        availableBytes: 896
      });
    } finally {
      fixture.releaseSmart();
      await Promise.all([inventory, scope]);
    }
  });

  it("serves indexer status while an unrelated SMART inventory is pending", async () => {
    const fixture = storageFixture();
    const system = { commandRunner: fixture.runner };
    const server = await buildServer({
      config: loadCyberOsRuntime({ CYBEROS_ROOT: tempDir }, tempDir),
      db,
      system
    });
    const inventory = collectSystemStorage(system);
    await fixture.smartStarted;
    const request = server.inject({ method: "GET", url: "/api/indexer/status?storagePoolId=pool-1" });
    try {
      const response = await beforeDeadline(request);
      expect(response?.statusCode).toBe(200);
      expect(response?.json()).toMatchObject({
        storagePools: [{
          storagePoolId: "pool-1",
          readiness: {
            status: "ready",
            source: "/dev/md/pool-1",
            fstype: "ext4"
          }
        }]
      });
    } finally {
      fixture.releaseSmart();
      await Promise.all([inventory, request]);
      await server.close();
    }
  });

  it("rechecks the mount after a completed scope lookup", async () => {
    const fixture = storageFixture();
    fixture.releaseSmart();
    const system = { commandRunner: fixture.runner };
    const initial = await resolveStoragePoolScope(dataRoot, system, "pool-1");
    expect(initial.pool.status).toBe("ready");
    fixture.mounted = false;
    await expect(resolveStoragePoolScope(dataRoot, system, "pool-1"))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("preserves RAID warning status in scope metadata", async () => {
    const fixture = storageFixture();
    fixture.releaseSmart();
    fixture.failedDevices = 1;
    const system = { commandRunner: fixture.runner };
    const scope = await resolveStoragePoolScope(dataRoot, system, "pool-1");
    expect(scope.pool.status).toBe("warning");
  });

  it("rejects a symlink mountpoint", async () => {
    const fixture = storageFixture();
    fixture.releaseSmart();
    const system = { commandRunner: fixture.runner };
    await rm(poolPath, { recursive: true });
    const other = path.join(tempDir, "other");
    await mkdir(other);
    await symlink(other, poolPath);
    await expect(resolveStoragePoolScope(dataRoot, system, "pool-1"))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

function storageFixture() {
  let announceSmart = () => {};
  let releaseSmart = () => {};
  const smartStarted = new Promise<void>((resolve) => { announceSmart = resolve; });
  const smartResult = new Promise<string>((resolve) => {
    releaseSmart = () => resolve(JSON.stringify({ devices: [] }));
  });
  const fixture = {
    mounted: true,
    raidState: "clean",
    failedDevices: 0,
    smartStarted,
    releaseSmart,
    runner: {
      async run(command: string, args: string[]): Promise<string> {
        if (command === "smartctl") {
          announceSmart();
          return smartResult;
        }
        if (command === "lsblk") return JSON.stringify({ blockdevices: [] });
        if (command === "findmnt") {
          return JSON.stringify({ filesystems: fixture.mounted ? [{
            source: "/dev/md/pool-1", target: poolPath, fstype: "ext4",
            size: 1024, used: 128, avail: 896, "use%": "12.5%"
          }] : [] });
        }
        if (command === "mdadm" && args[1] === "--scan") {
          return "ARRAY /dev/md/pool-1 name=nas:pool-1 UUID=test-pool";
        }
        if (command === "mdadm" && args[1] === "/dev/md/pool-1") {
          return ["Name : nas:pool-1", "Raid Level : raid1", `State : ${fixture.raidState}`,
            `Failed Devices : ${fixture.failedDevices}`,
            "UUID : test-pool", "Array Size : 1024 KiB"].join("\n");
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      }
    } satisfies SystemCommandRunner
  };
  return fixture;
}

async function beforeDeadline<T>(promise: PromiseLike<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1_000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
