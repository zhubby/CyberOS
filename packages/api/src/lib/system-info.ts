import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PublicSystemInfo,
  PublicSystemInfoCpu,
  PublicSystemInfoNetworkAddress,
  PublicSystemInfoStorageVolume,
  ZosConfig
} from "@zos/shared";
import {
  PHOTOSTAFF_DATA_DIRECTORY_NAME,
  PHOTOSTAFF_MAX_FILE_SIZE_BYTES,
  PHOTOSTAFF_PREVIEW_MAX_EDGE_PX,
  PHOTOSTAFF_SUPPORTED_EXTENSIONS,
  PHOTOSTAFF_THUMBNAIL_SIZE_PX
} from "@zos/shared";

interface StorageCandidate {
  id: string;
  label: string;
  kind: PublicSystemInfoStorageVolume["kind"];
  path: string;
  rootId: string | null;
}

export async function collectSystemInfo(config: ZosConfig): Promise<PublicSystemInfo> {
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
    zos: {
      rootDir: config.paths?.rootDir ?? config.rootDir ?? path.dirname(config.dataDir),
      stateDir: config.paths?.stateDir ?? config.stateDir ?? config.dataDir,
      dataRoot: config.paths?.dataRoot ?? config.dataRoot ?? path.join(path.dirname(config.dataDir), "data"),
      appsRoot: config.paths?.appsRoot ?? config.appsRoot ?? "/zos/apps",
      isoRoot: config.paths?.isoRoot ?? config.isoRoot ?? "/zos/iso",
      vmRoot: config.paths?.vmRoot ?? config.vmRoot ?? path.join(config.dataDir, "vm"),
      backupRoot: config.paths?.backupRoot ?? config.backupRoot ?? path.join(path.dirname(config.dataDir), "data", "backup"),
      dataDir: config.dataDir,
      databasePath: config.databasePath,
      apiHost: config.api.host,
      apiPort: config.api.port,
      allowedOriginCount: config.api.allowedOrigins.length,
      workerPollMs: config.worker.pollMs,
      modelProvider: config.model.provider,
      localEndpointConfigured: Boolean(config.model.localEndpoint),
      dockerEnabled: config.docker.enabled,
      photostaff: {
        dataDir: path.join(config.dataDir, PHOTOSTAFF_DATA_DIRECTORY_NAME),
        maxFileSizeBytes: PHOTOSTAFF_MAX_FILE_SIZE_BYTES,
        thumbnailSizePx: PHOTOSTAFF_THUMBNAIL_SIZE_PX,
        previewMaxEdgePx: PHOTOSTAFF_PREVIEW_MAX_EDGE_PX,
        supportedExtensions: [...PHOTOSTAFF_SUPPORTED_EXTENSIONS]
      },
      nasRoots: config.nasRoots
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

function storageCandidates(config: ZosConfig): StorageCandidate[] {
  return [
    {
      id: "data-dir",
      label: "data-dir",
      kind: "data",
      path: config.dataDir,
      rootId: null
    },
    {
      id: "database",
      label: "database",
      kind: "database",
      path: path.dirname(config.databasePath),
      rootId: null
    },
    ...config.nasRoots.map((root) => ({
      id: `nas-root-${root.id}`,
      label: root.name,
      kind: "nas-root" as const,
      path: root.path,
      rootId: root.id
    }))
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
      rootId: candidate.rootId,
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
      rootId: candidate.rootId,
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
