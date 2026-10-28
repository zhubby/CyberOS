import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PublicSystemInfo,
  PublicSystemInfoCpu,
  PublicSystemInfoNetworkAddress,
  PublicSystemInfoStorageVolume,
  CyberOsConfig
} from "@cyberos/shared";
import {
  PHOTOS_DATA_DIRECTORY_NAME,
  PHOTOS_MAX_FILE_SIZE_BYTES,
  PHOTOS_PREVIEW_MAX_EDGE_PX,
  PHOTOS_SUPPORTED_EXTENSIONS,
  PHOTOS_THUMBNAIL_SIZE_PX
} from "@cyberos/shared";

interface StorageCandidate {
  id: string;
  label: string;
  kind: PublicSystemInfoStorageVolume["kind"];
  path: string;
  storagePoolId: string | null;
}

export async function collectSystemInfo(config: CyberOsConfig): Promise<PublicSystemInfo> {
  const cpus = os.cpus().map(toPublicCpu);
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryBytes = Math.max(totalMemoryBytes - freeMemoryBytes, 0);
  const processMemory = process.memoryUsage();
  const storageVolumes = await Promise.all(storageCandidates(config).map(collectStorageVolume));

  return {
    collectedAt: new Date().toISOString(),
    identity: {
      hostname: os.hostname(),
      adminDisplayName: config.admin.displayName,
      authMode: config.admin.authMode,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    operatingSystem: {
      type: os.type(),
      platform: os.platform(),
      release: os.release(),
      version: os.version(),
      arch: os.arch(),
      machine: os.machine(),
      endianness: os.endianness(),
      uptimeSeconds: Math.round(os.uptime()),
      loadAverage: os.loadavg(),
      availableParallelism: os.availableParallelism()
    },
    hardware: {
      cpuModel: cpus[0]?.model ?? null,
      cpuSpeedMHz: cpus[0]?.speedMHz ?? null,
      cpuThreads: cpus.length,
      cpus,
      memory: {
        totalBytes: totalMemoryBytes,
        freeBytes: freeMemoryBytes,
        usedBytes: usedMemoryBytes,
        usedPercent: ratio(usedMemoryBytes, totalMemoryBytes)
      }
    },
    storage: {
      volumes: storageVolumes
    },
    network: {
      interfaces: networkAddresses()
    },
    runtime: {
      nodeVersion: process.version,
      versions: runtimeVersions(),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      cwd: process.cwd(),
      execPath: process.execPath,
      memory: {
        rssBytes: processMemory.rss,
        heapTotalBytes: processMemory.heapTotal,
        heapUsedBytes: processMemory.heapUsed,
        externalBytes: processMemory.external,
        arrayBuffersBytes: processMemory.arrayBuffers
      }
    },
    cyberos: {
      rootDir: config.paths.rootDir,
      stateDir: config.paths.stateDir,
      dataRoot: config.paths.dataRoot,
      appsRoot: config.paths.appsRoot,
      isoRoot: config.paths.isoRoot,
      vmRoot: config.paths.vmRoot,
      backupRoot: config.paths.backupRoot,
      databasePath: config.paths.databasePath,
      apiHost: config.api.host,
      apiPort: config.api.port,
      allowedOriginCount: config.api.allowedOrigins.length,
      workerPollMs: config.worker.pollMs,
      dockerEnabled: config.docker.enabled,
      photos: {
        dataDir: path.join(config.paths.stateDir, PHOTOS_DATA_DIRECTORY_NAME),
        maxFileSizeBytes: PHOTOS_MAX_FILE_SIZE_BYTES,
        thumbnailSizePx: PHOTOS_THUMBNAIL_SIZE_PX,
        previewMaxEdgePx: PHOTOS_PREVIEW_MAX_EDGE_PX,
        supportedExtensions: [...PHOTOS_SUPPORTED_EXTENSIONS]
      }
    }
  };
}

function toPublicCpu(cpu: ReturnType<typeof os.cpus>[number]): PublicSystemInfoCpu {
  return {
    model: cpu.model,
    speedMHz: cpu.speed,
    times: {
      userMs: cpu.times.user,
      niceMs: cpu.times.nice,
      systemMs: cpu.times.sys,
      idleMs: cpu.times.idle,
      irqMs: cpu.times.irq
    }
  };
}

function storageCandidates(config: CyberOsConfig): StorageCandidate[] {
  return [
    {
      id: "data-root",
      label: "data-root",
      kind: "data",
      path: config.paths.dataRoot,
      storagePoolId: null
    },
    {
      id: "database",
      label: "database",
      kind: "database",
      path: path.dirname(config.paths.databasePath),
      storagePoolId: null
    }
  ];
}

async function collectStorageVolume(candidate: StorageCandidate): Promise<PublicSystemInfoStorageVolume> {
  const resolvedPath = path.resolve(candidate.path);

  try {
    const stats = await statfs(resolvedPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const usedBytes = Math.max(totalBytes - freeBytes, 0);

    return {
      id: candidate.id,
      label: candidate.label,
      kind: candidate.kind,
      path: resolvedPath,
      status: "ready",
      blockSizeBytes: stats.bsize,
      totalBytes,
      freeBytes,
      availableBytes,
      usedBytes,
      usedPercent: ratio(usedBytes, totalBytes),
      storagePoolId: candidate.storagePoolId,
      error: null
    };
  } catch (error) {
    return {
      id: candidate.id,
      label: candidate.label,
      kind: candidate.kind,
      path: resolvedPath,
      status: "error",
      blockSizeBytes: null,
      totalBytes: null,
      freeBytes: null,
      availableBytes: null,
      usedBytes: null,
      usedPercent: null,
      storagePoolId: candidate.storagePoolId,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function networkAddresses(): PublicSystemInfoNetworkAddress[] {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).map((address) => ({
      name,
      address: address.address,
      family: String(address.family),
      mac: address.mac,
      internal: address.internal,
      cidr: address.cidr ?? null,
      netmask: address.netmask,
      scopeId: typeof address.scopeid === "number" ? address.scopeid : null
    }))
  );
}

function runtimeVersions(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.versions).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function ratio(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}
