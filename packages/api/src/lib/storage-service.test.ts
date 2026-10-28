import type { SystemStorageSummary } from "@cyberos/shared";
import { describe, expect, it } from "vitest";
import { buildStoragePoolDeleteProposal, buildStoragePoolProposal } from "./storage-service.js";

describe("storage service", () => {
  it("builds a destructive proposal only from available whole disks", () => {
    const proposal = buildStoragePoolProposal(
      { name: "archive", raidLevel: "1", devices: ["/dev/sda", "/dev/sdb"] },
      summary()
    );

    expect(proposal).toMatchObject({
      action: "create_pool",
      name: "archive",
      raidLevel: "1",
      filesystem: "ext4",
      mountpoint: "/cyberos/data/archive",
      risk: "high"
    });
  });

  it("accepts btrfs while keeping ext4 as the default", () => {
    const proposal = buildStoragePoolProposal(
      { name: "archive", raidLevel: "1", filesystem: "btrfs", devices: ["/dev/sda", "/dev/sdb"] },
      summary()
    );

    expect(proposal).toMatchObject({
      filesystem: "btrfs",
      summary: expect.stringContaining("formatted as btrfs")
    });
    expect(() => buildStoragePoolProposal({ name: "archive", raidLevel: "1", filesystem: "xfs", devices: ["/dev/sda", "/dev/sdb"] }, summary())).toThrow(
      "Unsupported storage filesystem"
    );
  });

  it("requires the exact pool name when building a delete proposal", () => {
    const current = summary();
    current.capabilities.canDeletePool = true;
    current.pools = [{
      id: "/dev/md/archive",
      name: "nas:archive",
      raidPath: "/dev/md/archive",
      raidLevel: "raid1",
      status: "ready",
      mountpoint: "/cyberos/data/archive",
      filesystem: "ext4",
      totalBytes: 200,
      usedBytes: 20,
      availableBytes: 180,
      usedPercent: 0.1,
      memberDevices: ["/dev/sda", "/dev/sdb"]
    }];

    expect(() => buildStoragePoolDeleteProposal({ poolId: "/dev/md/archive", confirmation: "wrong" }, current)).toThrow(
      "Type archive to confirm storage pool deletion"
    );
    expect(buildStoragePoolDeleteProposal({ poolId: "/dev/md/archive", confirmation: "archive" }, current)).toMatchObject({
      action: "delete_pool",
      name: "archive",
      mdDevice: "/dev/md/archive",
      mountpoint: "/cyberos/data/archive"
    });
  });

  it("rejects mounted, formatted, and existing array members", () => {
    expect(() => buildStoragePoolProposal({ name: "bad", raidLevel: "1", devices: ["/dev/sda", "/dev/sdc"] }, summary())).toThrow(
      "Block device is mounted"
    );
    expect(() =>
      buildStoragePoolProposal({ name: "bad", raidLevel: "1", devices: ["/dev/sda", "/dev/sdd"] }, summary())
    ).toThrow("contains formatted partitions");
    expect(() =>
      buildStoragePoolProposal({ name: "bad", raidLevel: "1", devices: ["/dev/sda", "/dev/sde"] }, summary())
    ).toThrow("already belongs");
  });

  it("reserves the backup mount for the backup target", () => {
    expect(() => buildStoragePoolProposal(
      { name: "backup", raidLevel: "1", devices: ["/dev/sda", "/dev/sdb"] },
      summary()
    )).toThrow("backup pool name is reserved");
  });
});

function summary(): SystemStorageSummary {
  const disk = (path: string, mountpoints: string[] = [], filesystem: string | null = null) => ({
    id: path,
    name: path.slice(5),
    path,
    model: null,
    serial: null,
    transport: "sata",
    rotational: true,
    sizeBytes: 100,
    mountpoints,
    partitions: [
      {
        id: `${path}1`,
        name: `${path.slice(5)}1`,
        path: `${path}1`,
        parent: path.slice(5),
        filesystem,
        label: null,
        uuid: null,
        sizeBytes: 100,
        mountpoints: []
      }
    ],
    smart: {
      health: "unknown" as const,
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
  });
  return {
    collectedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    capabilities: {
      backend: "mdadm",
      canCreatePool: true,
      canDeletePool: false,
      canApplyConfiguration: false,
      hostMutationPolicy: "mutable"
    },
    metrics: { pools: 0, arrays: 0, disks: 5, totalBytes: 500, usedBytes: null, availableBytes: null, smartPassed: 0, smartFailed: 0, smartUnknown: 5 },
    pools: [],
    arrays: [{ id: "/dev/md0", name: "old", path: "/dev/md0", level: "raid1", state: "clean", uuid: "old", sizeBytes: 100, activeDevices: 2, totalDevices: 2, failedDevices: 0, spareDevices: 0, memberDevices: ["/dev/sde"] }],
    disks: [disk("/dev/sda"), disk("/dev/sdb"), disk("/dev/sdc", ["/cyberos/data/pool-1"]), disk("/dev/sdd", [], "ext4"), disk("/dev/sde")],
    mounts: [],
    issues: []
  };
}
