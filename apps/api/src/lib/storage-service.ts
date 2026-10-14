import path from "node:path";
import type {
  StorageOperationProposal,
  StorageFilesystem,
  StorageRaidLevel,
  SystemStorageSummary
} from "@zos/shared";
import { HostdClient } from "./hostd-client.js";

const HOSTD_TIMEOUT_MS = 120_000;
const STORAGE_MOUNT_ROOT = "/zos/data";
const POOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const RAID_MINIMUMS: Record<StorageRaidLevel, number> = {
  "0": 2,
  "1": 2,
  "5": 3,
  "6": 4,
  "10": 4
};

export interface StoragePoolProposalInput {
  name?: string;
  raidLevel?: string;
  devices?: string[];
  filesystem?: string;
}

export interface StoragePoolDeleteProposalInput {
  poolId?: string;
  confirmation?: string;
}

export function buildStoragePoolProposal(
  input: StoragePoolProposalInput,
  summary: SystemStorageSummary,
  mountRoot = STORAGE_MOUNT_ROOT
): StorageOperationProposal {
  const name = input.name?.trim() ?? "";
  if (!POOL_NAME_PATTERN.test(name)) {
    throw new Error("Pool name must start with a lowercase letter and contain only a-z, 0-9, _ or -");
  }
  if (name === "backup") {
    throw new Error("The backup pool name is reserved");
  }

  const raidLevel = parseRaidLevel(input.raidLevel);
  const filesystem = parseStorageFilesystem(input.filesystem);
  const devices = [...new Set(input.devices ?? [])];
  const minimum = RAID_MINIMUMS[raidLevel];
  if (devices.length < minimum) {
    throw new Error(`RAID ${raidLevel} requires at least ${minimum} disks`);
  }
  if (raidLevel === "10" && devices.length % 2 !== 0) {
    throw new Error("RAID 10 requires an even number of disks");
  }

  const normalizedMountRoot = normalizeMountRoot(mountRoot);
  const mountpoint = path.posix.join(normalizedMountRoot, name);
  const disksByPath = new Map(summary.disks.map((disk) => [disk.path, disk]));
  const arrayMembers = new Set(summary.arrays.flatMap((array) => array.memberDevices));
  for (const device of devices) {
    if (!/^\/dev\/[A-Za-z0-9._-]+$/u.test(device)) {
      throw new Error(`Invalid block device path: ${device}`);
    }
    const disk = disksByPath.get(device);
    if (!disk) {
      throw new Error(`Block device is not present in the latest inventory: ${device}`);
    }
    if (disk.mountpoints.length || disk.partitions.some((partition) => partition.mountpoints.length)) {
      throw new Error(`Block device is mounted and cannot be used: ${device}`);
    }
    if (arrayMembers.has(device) || disk.partitions.some((partition) => arrayMembers.has(partition.path))) {
      throw new Error(`Block device already belongs to an mdadm array: ${device}`);
    }
    if (disk.partitions.some((partition) => partition.filesystem !== null)) {
      throw new Error(`Block device contains formatted partitions and cannot be used: ${device}`);
    }
  }

  if (summary.issues.some((issue) => issue.source === "block devices" || issue.source === "mdadm scan")) {
    throw new Error("Storage inventory is incomplete; refresh the panel before creating a pool");
  }

  return {
    action: "create_pool",
    name,
    raidLevel,
    devices,
    filesystem,
    mountpoint,
    risk: "high",
    summary: `Create RAID ${raidLevel} pool ${name} at ${mountpoint} using ${devices.join(", ")}. All selected disks will be erased and formatted as ${filesystem}.`
  };
}

export function buildStoragePoolDeleteProposal(
  input: StoragePoolDeleteProposalInput,
  summary: SystemStorageSummary
): StorageOperationProposal {
  if (!summary.capabilities.canDeletePool) {
    throw new Error("Storage pool deletion is not supported on this host");
  }

  const poolId = input.poolId?.trim() ?? "";
  const pool = summary.pools.find((candidate) => candidate.id === poolId);
  if (!pool) {
    throw new Error("Storage pool is no longer available; refresh the inventory");
  }
  if (!pool.mountpoint || !/^\/zos\/data\/[a-z][a-z0-9_-]{0,31}$/u.test(pool.mountpoint) || pool.mountpoint === "/zos/data/backup") {
    throw new Error("Storage pool mountpoint is invalid");
  }
  if (!/^\/dev\/md(?:\/[A-Za-z0-9._-]+|\d+)$/u.test(pool.raidPath)) {
    throw new Error("Storage pool array path is invalid");
  }
  const name = path.posix.basename(pool.mountpoint);
  if (input.confirmation?.trim() !== name) {
    throw new Error(`Type ${name} to confirm storage pool deletion`);
  }
  if (!pool.memberDevices.length || pool.memberDevices.some((device) => !/^\/dev\/[A-Za-z0-9._-]+$/u.test(device))) {
    throw new Error("Storage pool member devices are unavailable");
  }

  return {
    action: "delete_pool",
    name,
    mdDevice: pool.raidPath,
    devices: [...new Set(pool.memberDevices)],
    mountpoint: pool.mountpoint,
    risk: "high",
    summary: `Delete storage pool ${name} at ${pool.mountpoint} and stop ${pool.raidPath}.`
  };
}

export async function applyStoragePoolOperation(
  hostdSocketPath: string,
  proposal: StorageOperationProposal
): Promise<Record<string, unknown>> {
  return new HostdClient(hostdSocketPath).request(
    "storage.operation",
    proposal,
    HOSTD_TIMEOUT_MS
  );
}

function parseRaidLevel(value: string | undefined): StorageRaidLevel {
  if (value === "0" || value === "1" || value === "5" || value === "6" || value === "10") {
    return value;
  }
  throw new Error("Unsupported RAID level");
}

function parseStorageFilesystem(value: string | undefined): StorageFilesystem {
  if (value === undefined || value === "ext4") {
    return "ext4";
  }
  if (value === "btrfs") {
    return "btrfs";
  }
  throw new Error("Unsupported storage filesystem");
}

function normalizeMountRoot(value: string): string {
  const normalized = path.posix.resolve(value);
  if (normalized !== STORAGE_MOUNT_ROOT) {
    throw new Error(`Storage pools must be mounted below ${STORAGE_MOUNT_ROOT}`);
  }
  return normalized;
}
