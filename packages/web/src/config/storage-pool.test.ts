import { describe, expect, it } from "vitest";
import {
  isStorageDiskSelectable,
  raidMinimum,
  storageDiskAvailability,
  validateStoragePoolForm,
  type StorageDisk,
  type StoragePoolFormState
} from "./storage-pool.js";

const baseDisk: StorageDisk = {
  id: "/dev/sda",
  name: "sda",
  path: "/dev/sda",
  model: null,
  serial: null,
  transport: "sata",
  rotational: true,
  sizeBytes: 1_000,
  mountpoints: [],
  partitions: [],
  smart: {
    health: "unknown",
    available: null,
    enabled: null,
    protocol: null,
    firmwareVersion: null,
    temperatureCelsius: null,
    temperatureMinCelsius: null,
    temperatureMaxCelsius: null,
    powerOnHours: null,
    powerCycleCount: null,
    errorCount: null,
    selfTestStatus: null,
    percentageUsed: null,
    availableSparePercent: null,
    availableSpareThresholdPercent: null,
    unsafeShutdowns: null,
    criticalWarning: null,
    dataUnitsRead: null,
    dataUnitsWritten: null,
    hostReadCommands: null,
    hostWriteCommands: null,
    controllerBusyMinutes: null,
    warningTemperatureTimeMinutes: null,
    criticalTemperatureTimeMinutes: null,
    errorLogEntries: null,
    attributes: [],
    selfTests: [],
    message: null
  }
};

const form = (overrides: Partial<StoragePoolFormState> = {}): StoragePoolFormState => ({
  name: "media",
  raidLevel: "1",
  filesystem: "ext4",
  devices: ["/dev/sda", "/dev/sdb"],
  ...overrides
});

describe("storage pool form", () => {
  it("uses mdadm minimum disk counts", () => {
    expect(raidMinimum("0")).toBe(2);
    expect(raidMinimum("5")).toBe(3);
    expect(raidMinimum("6")).toBe(4);
    expect(raidMinimum("10")).toBe(4);
  });

  it("reports invalid name and RAID disk count", () => {
    expect(validateStoragePoolForm(form({ name: "Media Pool", devices: ["/dev/sda"] }), null)).toEqual([
      { code: "invalidName" },
      { code: "tooFewDevices", minimum: 2 }
    ]);
  });

  it("requires an even number of RAID 10 devices", () => {
    expect(validateStoragePoolForm(form({ raidLevel: "10", devices: ["/dev/sda", "/dev/sdb", "/dev/sdc"] }), null)).toContainEqual({
      code: "oddRaid10"
    });
  });

  it("rejects a selected disk that becomes unavailable", () => {
    const disk = { ...baseDisk, mountpoints: ["/mnt/changed"] };
    const summary = { disks: [disk], arrays: [], issues: [] } as unknown as Parameters<typeof validateStoragePoolForm>[1];
    expect(validateStoragePoolForm(form({ devices: ["/dev/sda", "/dev/sdb"] }), summary)).toContainEqual({
      code: "unavailableDevice"
    });
  });

  it("only selects unused whole disks", () => {
    const mounted = { ...baseDisk, mountpoints: ["/"] };
    const formatted = { ...baseDisk, partitions: [{ ...baseDisk.partitions[0], id: "/dev/sda1", name: "sda1", path: "/dev/sda1", parent: "sda", filesystem: "ext4", label: null, uuid: null, sizeBytes: 900, mountpoints: [] }] };
    const array = { arrays: [{ memberDevices: ["/dev/sda"] }] } as Parameters<typeof storageDiskAvailability>[1];
    expect(storageDiskAvailability(baseDisk, { arrays: [] })).toBe("ready");
    expect(storageDiskAvailability(mounted, { arrays: [] })).toBe("mounted");
    expect(storageDiskAvailability(formatted, { arrays: [] })).toBe("formatted");
    expect(storageDiskAvailability(baseDisk, array)).toBe("array");
    expect(isStorageDiskSelectable(baseDisk, { arrays: [] })).toBe(true);
  });
});
