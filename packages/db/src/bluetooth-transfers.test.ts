import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countUnreadBluetoothTransfers,
  createBluetoothSendTransfers,
  defaultBluetoothSettings,
  getBluetoothSettings,
  getBluetoothTransferServiceHealth,
  listBluetoothTransfers,
  markAllBluetoothTransfersRead,
  markBluetoothTransferRead,
  openCyberOsDb,
  requestBluetoothTransferCancellation,
  saveBluetoothSettings,
  type CyberOsDatabase
} from "./index.js";

let directory: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cyberos-bluetooth-db-"));
  db = openCyberOsDb(path.join(directory, "state.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("Bluetooth persistence", () => {
  it("normalizes settings and does not enable an incomplete inbox", () => {
    expect(defaultBluetoothSettings()).toMatchObject({ receiveEnabled: false, inboxPath: null });
    const incomplete = saveBluetoothSettings(db, { receiveEnabled: true, inboxStoragePoolId: "pool" });
    expect(incomplete.receiveEnabled).toBe(false);

    const saved = saveBluetoothSettings(db, {
      defaultAdapterId: " adapter-hci0 ",
      defaultAudioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF",
      receiveEnabled: true,
      inboxStoragePoolId: "pool",
      inboxPath: "incoming"
    });
    expect(saved).toMatchObject({
      defaultAdapterId: "adapter-hci0",
      receiveEnabled: true,
      inboxPath: "incoming"
    });
    expect(getBluetoothSettings(db)).toEqual(saved);

    const { updatedAt: _updatedAt, ...incompleteRecord } = saved;
    db.prepare("UPDATE system_settings SET value_json = ? WHERE key = 'bluetooth_settings'")
      .run(JSON.stringify(incompleteRecord));
    expect(getBluetoothSettings(db)).toBeNull();
  });

  it("persists a batch, cancellation, read state, and worker health", () => {
    const transfers = createBluetoothSendTransfers(db, {
      adapterId: "adapter-hci0",
      deviceAddress: "AA:BB:CC:DD:EE:FF",
            storagePoolId: "pool",
      files: [
        { relativePath: "media/a.mp3", displayName: "a.mp3", totalBytes: 10 },
        { relativePath: "media/b.mp3", displayName: "b.mp3", totalBytes: 20 }
      ]
    });
    expect(transfers).toHaveLength(2);
    expect(listBluetoothTransfers(db).map((transfer) => transfer.displayName)).toEqual(["a.mp3", "b.mp3"]);
    expect(countUnreadBluetoothTransfers(db)).toBe(2);

    const cancelled = requestBluetoothTransferCancellation(db, transfers[0]!.id);
    expect(cancelled).toMatchObject({ status: "cancelled", controlRequested: "cancel" });
    expect(markBluetoothTransferRead(db, transfers[0]!.id)?.readAt).not.toBeNull();
    expect(markAllBluetoothTransfersRead(db)).toBe(1);
    expect(countUnreadBluetoothTransfers(db)).toBe(0);
    expect(getBluetoothTransferServiceHealth(db)).toMatchObject({
      status: "unavailable",
      activeTransfers: 0,
      queuedTransfers: 1
    });
  });
});
