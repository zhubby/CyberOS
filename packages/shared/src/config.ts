import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS,
  TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS
} from "./terminal-protocol.js";
import { PHOTOS_BASE_MAP_RELEASE_URL } from "./photos-config.js";
import { resolveCyberOsPaths } from "./paths.js";
import type {
  CyberOsBootstrap,
  CyberOsRuntime,
  DeploymentMode,
  MonitoringConfig
} from "./types.js";

export const DEFAULT_MONITORING_CONFIG: Readonly<MonitoringConfig> = Object.freeze({
  enabled: true,
  fastSampleIntervalMs: 10_000,
  standardSampleIntervalMs: 30_000,
  temperatureSampleIntervalMs: 5 * 60_000,
  rawRetentionMs: 48 * 60 * 60_000,
  minuteRetentionMs: 30 * 24 * 60 * 60_000,
  hourRetentionMs: 365 * 24 * 60 * 60_000,
  maxDatabaseBytes: 512 * 1024 * 1024
});

export const WORKER_POLL_MS = 750;
export const WORKER_CONCURRENCY = 2;
export const HOSTD_SOCKET_PATH = "/run/cyberos/hostd.sock";
export const TERMINAL_SOCKET_PATH = "/run/cyberos/terminald.sock";
export const VOD_PLAYER_SOCKET_PATH = "/run/cyberos/vod-player.sock";
export const DOCKER_SOCKET_PATH = "/var/run/docker.sock";

export function loadBootstrap(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): CyberOsBootstrap {
  rejectRemovedEnvironment(env);
  const environment = deploymentMode(env.CYBEROS_ENVIRONMENT);
  const workspaceRoot = findWorkspaceRoot(cwd);
  const rootDir = resolveRootDir(env.CYBEROS_ROOT, workspaceRoot, environment);
  const host = normalizedText(env.CYBEROS_API_HOST) ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("CyberOS API must bind to a loopback host");
  }
  return {
    environment,
    paths: resolveCyberOsPaths(rootDir),
    api: {
      host,
      port: positiveInteger(env.CYBEROS_API_PORT, 3010, "CYBEROS_API_PORT"),
      allowedOrigins: csv(env.CYBEROS_ALLOWED_ORIGINS)
    }
  };
}

export function createCyberOsRuntime(bootstrap: CyberOsBootstrap): CyberOsRuntime {
  const { paths, environment } = bootstrap;
  return {
    ...bootstrap,
    mcp: {
      enabled: true,
      piEnabled: false,
      piTokenFile: paths.mcpTokenPath,
      externalEnabled: false,
      shellEnabled: false,
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      allowedOrigins: ["localhost", "127.0.0.1", "[::1]"],
      maxConcurrentPerClient: 4
    },
    worker: { pollMs: WORKER_POLL_MS, concurrency: WORKER_CONCURRENCY },
    admin: { displayName: "CyberOS Admin", authMode: "local-only" },
    docker: {
      enabled: false,
      socketPath: DOCKER_SOCKET_PATH,
      composeCommand: "docker",
      operationTimeoutMs: 120_000,
      consoleShells: ["/bin/sh", "/bin/bash"]
    },
    vm: {
      enabled: false,
      libvirtUri: "qemu:///system",
      storagePath: paths.vmRoot,
      networkName: "default",
      isoRoots: [paths.isoRoot],
      operationTimeoutMs: 120_000,
      consoleMode: "serial"
    },
    hostd: { socketPath: HOSTD_SOCKET_PATH },
    shares: {
      enabled: false,
      account: { username: "cyberos-share", password: null },
      shares: []
    },
    terminal: {
      user: "cyberos",
      socketPath: TERMINAL_SOCKET_PATH,
      sessionIdleTimeoutMs: TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS,
      connectTimeoutMs: TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS,
      maxSessions: 32
    },
    vodPlayer: {
      enabled: false,
      socketPath: VOD_PLAYER_SOCKET_PATH,
      statePath: path.join(paths.vodPlayerStateDir, "session.json"),
      commandTimeoutMs: 5_000,
      startupTimeoutMs: 15_000,
      checkpointIntervalMs: 5_000,
      retryBaseDelayMs: 2_000,
      retryMaxDelayMs: 60_000,
      videoOutput: "drm",
      drmConnector: null,
      audioOutput: "alsa",
      audioDevice: null,
      hwdec: "auto-safe",
      user: "cyberos"
    },
    photos: { baseMapUrl: PHOTOS_BASE_MAP_RELEASE_URL },
    backup: {
      enabled: false,
      repositoryPath: paths.backupRoot,
      passwordFile: paths.backupPasswordPath,
      stagingPath: path.join(paths.stateDir, "backup-staging"),
      requireMount: environment === "production",
      retryCount: 2,
      timeoutMs: 300_000,
      keepDaily: 7,
      keepWeekly: 4
    },
    health: {
      staleIndexWarningMs: 2 * 60 * 60_000,
      staleIndexCriticalMs: 6 * 60 * 60_000,
      stalledRunMs: 15 * 60_000,
      consecutiveFailureThreshold: 2,
      backupStaleMs: 26 * 60 * 60_000
    },
    monitoring: { ...DEFAULT_MONITORING_CONFIG }
  };
}

export function loadCyberOsRuntime(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): CyberOsRuntime {
  return createCyberOsRuntime(loadBootstrap(env, cwd));
}

function rejectRemovedEnvironment(env: NodeJS.ProcessEnv): void {
  const retained = new Set([
    "CYBEROS_ENVIRONMENT",
    "CYBEROS_ROOT",
    "CYBEROS_API_HOST",
    "CYBEROS_API_PORT",
    "CYBEROS_ALLOWED_ORIGINS"
  ]);
  const removed = Object.keys(env)
    .filter((name) => name.startsWith("CYBEROS_") && isApplicationSetting(name) && !retained.has(name))
    .sort();
  if (removed.length > 0) {
    throw new Error(`${removed.join(", ")} is no longer supported; configure this feature in CyberOS settings`);
  }
}

function isApplicationSetting(name: string): boolean {
  return /^CYBEROS_(?:ADMIN|BACKUP|DATA_DIR|DATABASE_PATH|DOCKER|HEALTH|HOSTD|HOST_MUTATION|MCP_(?:ENABLED|PI_|EXTERNAL|SHELL|ALLOWED|MAX_)|MONITORING_(?:ENABLED|FAST|STANDARD|TEMPERATURE|RAW|MINUTE|HOUR|MAX_)|PHOTOS_BASEMAP|SHARES|SHARE_ACCOUNT|TERMINALD_(?:USER|SOCKET|SESSION|CONNECT|MAX_)|VM_|VOD_PLAYER_|WORKER_)/u.test(name);
}

function deploymentMode(value: string | undefined): DeploymentMode {
  const normalized = value?.trim().toLowerCase() ?? "development";
  if (normalized === "development" || normalized === "production") return normalized;
  throw new Error("CYBEROS_ENVIRONMENT must be development or production");
}

function resolveRootDir(value: string | undefined, workspaceRoot: string, mode: DeploymentMode): string {
  const configured = normalizedText(value);
  const root = configured
    ? path.resolve(workspaceRoot, configured)
    : mode === "production"
      ? "/cyberos"
      : path.join(workspaceRoot, ".cyberos", "dev-root");
  if (mode === "production" && root !== "/cyberos") {
    throw new Error(`Production CyberOS root must be /cyberos: ${root}`);
  }
  if (root === path.parse(root).root) throw new Error(`CyberOS root cannot be the filesystem root: ${root}`);
  return root;
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${label} must be a positive integer between 1 and 65535`);
  }
  return parsed;
}

function csv(value: string | undefined): string[] {
  return value ? [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))] : [];
}

function normalizedText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function findWorkspaceRoot(startPath: string): string {
  let current = path.resolve(startPath);
  while (true) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { workspaces?: unknown };
        if (pkg.workspaces) return current;
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startPath);
    current = parent;
  }
}
