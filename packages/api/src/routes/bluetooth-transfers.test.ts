import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ensureNasRoots, openCyberOsDb, saveBluetoothSettings, type CyberOsDatabase } from "@cyberos/db";
import type { BluetoothOperationResult, BluetoothStatus } from "@cyberos/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiRouteContext } from "../context.js";
import type { BluetoothManagerRuntime } from "../lib/bluetooth-manager.js";
import { finalizeBluetoothReceives, registerBluetoothTransferRoutes, streamBluetoothTransfers } from "./bluetooth-transfers.js";

const poolId = "/dev/md/test-pool";
let temporaryDirectory: string | null = null;
let database: CyberOsDatabase | null = null;

afterEach(async () => {
  database?.close();
  database = null;
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

describe("Bluetooth transfer routes", () => {
  it("uses stable audio ids and rejects arbitrary ALSA device strings", async () => {
    const { server } = await setup();
    const response = await server.inject({ method: "GET", url: "/api/system/bluetooth/settings" });
    expect(response.statusCode).toBe(200);
    expect(response.json().audioDevices).toEqual([
      expect.objectContaining({ id: "bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF", name: "Living room" })
    ]);

    const rejected = await server.inject({
      method: "PATCH",
      url: "/api/system/bluetooth/settings",
      payload: { defaultAudioDeviceId: "alsa/hw:0" }
    });
    expect(rejected.statusCode).toBe(404);

    const accepted = await server.inject({
      method: "PATCH",
      url: "/api/system/bluetooth/settings",
      payload: { defaultAudioDeviceId: "bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF" }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().settings.defaultAudioDeviceId).toBe("bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF");

    const invalidReceiveToggle = await server.inject({
      method: "PATCH",
      url: "/api/system/bluetooth/settings",
      payload: { receiveEnabled: "yes" }
    });
    expect(invalidReceiveToggle.statusCode).toBe(400);
    await server.close();
  });

  it("keeps audio ids unique across adapters and suppresses ambiguous BlueALSA routes", async () => {
    const { server, bluetooth } = await setup();
    saveBluetoothSettings(database!, { defaultAudioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF" });

    const migrated = await server.inject({ method: "GET", url: "/api/system/bluetooth/settings" });
    expect(migrated.json().settings.defaultAudioDeviceId).toBe("bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF");

    bluetooth.status.adapters.push({
      ...bluetooth.status.adapters[0]!, id: "adapter-hci1", name: "hci1", alias: "USB adapter", defaultAdapter: false
    });
    bluetooth.status.devices.push({
      ...bluetooth.status.devices[0]!, adapterId: "adapter-hci1", address: "11:22:33:44:55:66", alias: "Second route"
    });
    const response = await server.inject({ method: "GET", url: "/api/system/bluetooth/settings" });
    expect(response.json().audioDevices.map((device: { id: string }) => device.id)).toEqual([
      "bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF",
      "bluetooth:adapter-hci1/11:22:33:44:55:66"
    ]);

    bluetooth.status.devices[1]!.address = "AA:BB:CC:DD:EE:FF";
    expect((await server.inject({ method: "GET", url: "/api/system/bluetooth/settings" })).json().audioDevices)
      .toEqual([]);
    bluetooth.status.devices[1]!.connected = false;
    expect((await server.inject({ method: "GET", url: "/api/system/bluetooth/settings" })).json().audioDevices)
      .toEqual([expect.objectContaining({ id: "bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF" })]);
    await server.close();
  });

  it("queues only scoped files for a paired device and supports cancellation", async () => {
    const { server, bluetooth } = await setup();
    const queued = await server.inject({
      method: "POST",
      url: "/api/system/bluetooth/transfers",
      payload: {
        adapterId: "adapter-hci0",
        address: "aa:bb:cc:dd:ee:ff",
        rootId: "local",
        storagePoolId: poolId,
        paths: ["clip.bin"]
      }
    });
    expect(queued.statusCode).toBe(201);
    expect(queued.json().transfers).toEqual([
      expect.objectContaining({
        deviceAddress: "AA:BB:CC:DD:EE:FF",
        relativePath: "clip.bin",
        status: "queued",
        totalBytes: 5
      })
    ]);
    const id = queued.json().transfers[0].id as string;
    const cancelled = await server.inject({
      method: "POST",
      url: `/api/system/bluetooth/transfers/${id}/cancel`
    });
    expect(cancelled.json().transfer.status).toBe("cancelled");

    const traversal = await server.inject({
      method: "POST",
      url: "/api/system/bluetooth/transfers",
      payload: {
        adapterId: "adapter-hci0",
        address: "AA:BB:CC:DD:EE:FF",
        rootId: "local",
        storagePoolId: poolId,
        paths: ["../clip.bin"]
      }
    });
    expect(traversal.statusCode).toBe(400);

    bluetooth.status.devices[0]!.paired = false;
    const unpaired = await server.inject({
      method: "POST",
      url: "/api/system/bluetooth/transfers",
      payload: {
        adapterId: "adapter-hci0",
        address: "AA:BB:CC:DD:EE:FF",
        rootId: "local",
        storagePoolId: poolId,
        paths: ["clip.bin"]
      }
    });
    expect(unpaired.statusCode).toBe(409);
    await server.close();
  });

  it("streams persistent transfer state over SSE", async () => {
    const { server } = await setup();
    const chunks: string[] = [];
    let close: () => void = () => undefined;
    await streamBluetoothTransfers(
      { once: (_event, listener) => { close = listener; } },
      {
        write: (chunk) => {
          chunks.push(chunk);
          if (chunk.startsWith("data:")) close();
        },
        end: () => undefined
      },
      { db: database! },
      { sampleMs: 1, heartbeatMs: 10 }
    );
    expect(chunks.join("")).toContain("event: system.bluetooth.transfers");
    expect(chunks.join("")).toContain('"transfers":[]');
    await server.close();
  });

  it("reports enabled receiving as paused when the inbox storage goes offline", async () => {
    const { server, storage } = await setup();
    saveBluetoothSettings(database!, {
      receiveEnabled: true,
      inboxRootId: "local",
      inboxStoragePoolId: poolId,
      inboxPath: "inbox"
    });

    storage.online = false;
    const response = await server.inject({ method: "GET", url: "/api/system/bluetooth/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json().settings.receiveEnabled).toBe(true);
    expect(response.json().inboxStatus).toEqual({
      status: "paused",
      reason: "storage_unavailable"
    });
    await server.close();
  });

  it("keeps inbox preferences available while host Bluetooth integration is offline", async () => {
    const { server, bluetooth } = await setup();
    bluetooth.getStatus = async () => { throw new Error("hostd is offline"); };

    const initial = await server.inject({ method: "GET", url: "/api/system/bluetooth/settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().audioDevices).toEqual([]);

    const saved = await server.inject({
      method: "PATCH",
      url: "/api/system/bluetooth/settings",
      payload: {
        receiveEnabled: true,
        inboxRootId: "local",
        inboxStoragePoolId: poolId,
        inboxPath: "inbox"
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      settings: { receiveEnabled: true, inboxPath: "inbox" },
      inboxStatus: { status: "ready", reason: null }
    });

    const audio = await server.inject({
      method: "PATCH",
      url: "/api/system/bluetooth/settings",
      payload: { defaultAudioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF" }
    });
    expect(audio.statusCode).toBe(503);
    await server.close();
  });

  it("finalizes staged receives into the configured inbox without overwriting", async () => {
    const { server } = await setup();
    const root = path.join(temporaryDirectory!, "root");
    const incoming = path.join(temporaryDirectory!, "bluetooth", "incoming");
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    await mkdir(incoming, { recursive: true });
    await mkdir(path.join(root, "other"));
    await writeFile(path.join(root, "inbox", "report.txt"), "existing");
    saveBluetoothSettings(database!, {
      receiveEnabled: true,
      inboxRootId: "local",
      inboxStoragePoolId: poolId,
      inboxPath: "inbox"
    });
    const insert = database!.prepare(`
      INSERT INTO bluetooth_transfers (
        id, direction, device_address, root_id, storage_pool_id, relative_path,
        display_name, status, transferred_bytes, total_bytes, created_at, updated_at, started_at
      ) VALUES (
        ?, 'receive', 'AA:BB:CC:DD:EE:FF', 'local', ?, ?,
        ?, 'finalizing', ?, ?, ?, ?, ?
      )
    `);
    const now = new Date().toISOString();
    insert.run(firstId, poolId, "inbox/report.txt", "report.txt", 8, 8, now, now, now);
    insert.run(secondId, poolId, "inbox/notes.txt", "notes.txt", 5, 5, now, now, now);
    await writeFile(path.join(incoming, `${firstId}.part`), "received");
    await writeFile(path.join(incoming, `${secondId}.part`), "notes");
    saveBluetoothSettings(database!, { inboxPath: "other" });
    let findmntCalls = 0;

    await finalizeBluetoothReceives({
      config: { databasePath: path.join(temporaryDirectory!, "cyberos.sqlite") },
      db: database,
      system: {
        commandRunner: {
          async run(command: string) {
            if (command === "findmnt") {
              findmntCalls += 1;
              return JSON.stringify({ filesystems: [{ source: poolId, target: root, fstype: "ext4", size: 1000, used: 100, avail: 900, "use%": "10%" }] });
            }
            if (command === "mdadm") return `ARRAY ${poolId} name=test UUID=test`;
            if (command === "smartctl") return JSON.stringify({ devices: [] });
            return JSON.stringify({ blockdevices: [] });
          }
        }
      }
    } as unknown as ApiRouteContext, incoming);

    const transfer = database!.prepare("SELECT status, relative_path, display_name FROM bluetooth_transfers WHERE id = ?").get(firstId) as { status: string; relative_path: string; display_name: string };
    expect(transfer.status).toBe("completed");
    expect(transfer.display_name).not.toBe("report.txt");
    await expect(readFile(path.join(root, transfer.relative_path), "utf8")).resolves.toBe("received");
    await expect(readFile(path.join(root, "inbox", "report.txt"), "utf8")).resolves.toBe("existing");
    await expect(readFile(path.join(root, "inbox", "notes.txt"), "utf8")).resolves.toBe("notes");
    expect(await readdir(path.join(root, "other"))).toEqual([]);
    expect(findmntCalls).toBe(1);
    await server.close();
  });

  it("resumes an already published receive without creating a duplicate", async () => {
    const { server } = await setup();
    const root = path.join(temporaryDirectory!, "root");
    const incoming = path.join(temporaryDirectory!, "bluetooth", "incoming");
    const id = "33333333-3333-4333-8333-333333333333";
    const finalName = "report-recovered.txt";
    const temporaryName = `.cyberos-bluetooth-${id}.part`;
    await mkdir(incoming, { recursive: true });
    const now = new Date().toISOString();
    database!.prepare(`
      INSERT INTO bluetooth_transfers (
        id, direction, device_address, root_id, storage_pool_id, relative_path,
        display_name, finalization_relative_path, status, transferred_bytes,
        total_bytes, created_at, updated_at, started_at
      ) VALUES (
        ?, 'receive', 'AA:BB:CC:DD:EE:FF', 'local', ?, 'inbox/report.txt',
        'report.txt', ?, 'finalizing', 8, 8, ?, ?, ?
      )
    `).run(id, poolId, `inbox/${finalName}`, now, now, now);
    await writeFile(path.join(incoming, `${id}.part`), "received");
    await writeFile(path.join(root, "inbox", temporaryName), "received");
    await link(
      path.join(root, "inbox", temporaryName),
      path.join(root, "inbox", finalName)
    );

    await finalizeBluetoothReceives({
      config: { databasePath: path.join(temporaryDirectory!, "cyberos.sqlite") },
      db: database,
      system: {
        commandRunner: {
          async run(command: string) {
            if (command === "findmnt") {
              return JSON.stringify({ filesystems: [{ source: poolId, target: root, fstype: "ext4", size: 1000, used: 100, avail: 900, "use%": "10%" }] });
            }
            if (command === "mdadm") return `ARRAY ${poolId} name=test UUID=test`;
            if (command === "smartctl") return JSON.stringify({ devices: [] });
            return JSON.stringify({ blockdevices: [] });
          }
        }
      }
    } as unknown as ApiRouteContext, incoming);

    const transfer = database!.prepare("SELECT status, relative_path FROM bluetooth_transfers WHERE id = ?")
      .get(id) as { status: string; relative_path: string };
    expect(transfer).toEqual({ status: "completed", relative_path: `inbox/${finalName}` });
    await expect(readFile(path.join(root, "inbox", finalName), "utf8")).resolves.toBe("received");
    expect((await readdir(path.join(root, "inbox"))).filter((name) => name.startsWith("report-recovered"))).toEqual([finalName]);
    expect(await readdir(incoming)).toEqual([]);
    expect(await readdir(path.join(root, "inbox"))).not.toContain(temporaryName);
    await server.close();
  });
});

async function setup(): Promise<{
  server: ReturnType<typeof Fastify>;
  bluetooth: FakeBluetoothManager;
  storage: { online: boolean };
}> {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cyberos-bluetooth-transfers-"));
  const root = path.join(temporaryDirectory, "root");
  await mkdir(root);
  await mkdir(path.join(root, "inbox"));
  await writeFile(path.join(root, "clip.bin"), "video");
  database = openCyberOsDb(path.join(temporaryDirectory, "cyberos.sqlite"));
  ensureNasRoots(database, [{ id: "local", name: "Local", path: root }]);
  const bluetooth = new FakeBluetoothManager();
  const storage = { online: true };
  const server = Fastify({ logger: false });
  registerBluetoothTransferRoutes(server, {
    config: { hostd: { socketPath: "/tmp/hostd.sock" } },
    db: database,
    system: {
      bluetoothManager: bluetooth,
      commandRunner: {
        async run(command: string) {
          if (command === "findmnt") {
            return JSON.stringify({
              filesystems: storage.online
                ? [{ source: poolId, target: root, fstype: "ext4", size: 1000, used: 100, avail: 900, "use%": "10%" }]
                : []
            });
          }
          if (command === "mdadm") return `ARRAY ${poolId} name=test UUID=test`;
          if (command === "smartctl") return JSON.stringify({ devices: [] });
          return JSON.stringify({ blockdevices: [] });
        }
      }
    }
  } as unknown as ApiRouteContext);
  return { server, bluetooth, storage };
}

class FakeBluetoothManager implements BluetoothManagerRuntime {
  status: BluetoothStatus = {
    collectedAt: "2026-10-20T00:00:00.000Z",
    backend: "BlueZ",
    available: true,
    adapters: [{
      id: "adapter-hci0", address: "00:11:22:33:44:55", name: "hci0", alias: "Host",
      state: "powered", powered: true, discovering: false, defaultAdapter: true
    }],
    devices: [{
      adapterId: "adapter-hci0", address: "AA:BB:CC:DD:EE:FF", name: "Speaker",
      alias: "Living room", type: "speaker", rssi: -42, paired: true, trusted: true,
      connected: true, servicesResolved: true, lastSeenAt: "2026-10-20T00:00:00.000Z"
    }],
    scan: { active: false, adapterId: null, startedAt: null, endsAt: null },
    challenge: null,
    error: null
  };

  async getStatus() { return this.status; }
  async setAdapterPower() { return this.result(); }
  async setDefaultAdapter() { return this.result(); }
  async startScan() { return this.result(); }
  async stopScan() { return this.result(); }
  async pair() { return this.result(); }
  async cancelPairing() { return this.result(); }
  async answerChallenge() { return this.result(); }
  async trust() { return this.result(); }
  async connect() { return this.result(); }
  async disconnect() { return this.result(); }
  async unpair() { return this.result(); }

  private result(): BluetoothOperationResult {
    return { status: this.status, message: null };
  }
}
