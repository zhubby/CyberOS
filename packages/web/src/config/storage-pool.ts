import type { StorageFilesystem, StorageRaidLevel, StorageSummary } from "../api.js";

export const STORAGE_RAID_LEVELS = ["1", "5", "6", "10", "0"] as const satisfies readonly StorageRaidLevel[];
export const STORAGE_FILESYSTEMS = ["ext4", "btrfs"] as const satisfies readonly StorageFilesystem[];

const RAID_MINIMUMS: Record<StorageRaidLevel, number> = {
  "0": 2,
  "1": 2,
  "5": 3,
  "6": 4,
  "10": 4
};

const POOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

export interface StoragePoolFormState {
  name: string;
  raidLevel: StorageRaidLevel;
  filesystem: StorageFilesystem;
  devices: string[];
}

export type StoragePoolValidationCode =
  | "missingName"
  | "invalidName"
  | "noDevices"
  | "tooFewDevices"
  | "oddRaid10"
  | "unavailableDevice"
  | "inventoryIncomplete";

export interface StoragePoolValidationIssue {
  code: StoragePoolValidationCode;
  minimum?: number;
}

export type StorageDiskAvailability = "ready" | "mounted" | "formatted" | "array";
export type StorageDisk = StorageSummary["disks"][number];

export function raidMinimum(level: StorageRaidLevel): number {
  return RAID_MINIMUMS[level] ?? 0;
}

export function validateStoragePoolForm(
  form: StoragePoolFormState,
  summary: StorageSummary | null
): StoragePoolValidationIssue[] {
  const issues: StoragePoolValidationIssue[] = [];
  const name = form.name.trim();
  if (!name) {
    issues.push({ code: "missingName" });
  } else if (!POOL_NAME_PATTERN.test(name)) {
    issues.push({ code: "invalidName" });
  }

  const devices = [...new Set(form.devices)];
  if (devices.length === 0) {
    issues.push({ code: "noDevices" });
  } else if (devices.length < raidMinimum(form.raidLevel)) {
    issues.push({ code: "tooFewDevices", minimum: raidMinimum(form.raidLevel) });
  }
  if (form.raidLevel === "10" && devices.length % 2 !== 0) {
    issues.push({ code: "oddRaid10" });
  }

  if (summary) {
    const disksByPath = new Map(summary.disks.map((disk) => [disk.path, disk]));
    const unavailable = devices.find((device) => {
      const disk = disksByPath.get(device);
      return !disk || !isStorageDiskSelectable(disk, summary);
    });
    if (unavailable) {
      issues.push({ code: "unavailableDevice" });
    }
  }

  if (summary?.issues.some((issue) => issue.source === "block devices" || issue.source === "mdadm scan")) {
    issues.push({ code: "inventoryIncomplete" });
  }
  return issues;
}

export function storageDiskAvailability(
  disk: StorageDisk,
  summary: Pick<StorageSummary, "arrays">
): StorageDiskAvailability {
  if (disk.mountpoints.length || disk.partitions.some((partition) => partition.mountpoints.length)) {
    return "mounted";
  }
  if (disk.partitions.some((partition) => partition.filesystem !== null)) {
    return "formatted";
  }
  const arrayMembers = new Set(summary.arrays.flatMap((array) => array.memberDevices));
  if (arrayMembers.has(disk.path) || disk.partitions.some((partition) => arrayMembers.has(partition.path))) {
    return "array";
  }
  return "ready";
}

export function isStorageDiskSelectable(disk: StorageDisk, summary: Pick<StorageSummary, "arrays">): boolean {
  return storageDiskAvailability(disk, summary) === "ready";
}
