import { accessSync, existsSync, readFileSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import {
  TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS,
  TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS
} from "./termux-protocol.js";
import { PHOTOSTAFF_BASE_MAP_RELEASE_URL } from "./photostaff-config.js";
import { resolveZosPaths, type ZosPaths } from "./paths.js";
import type {
  DlnaMediaType,
  NasRootConfig,
  ShareConfig,
  ShareDefinitionConfig,
  ShareProtocolConfig,
  VodPlayerConfig,
  ZosConfig,
  TerminalConfig,
  MonitoringConfig,
  VmConfig
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

interface TomlConfig {
  environment?: "development" | "production";
  root_dir?: string;
  api?: {
    host?: string;
    port?: number;
    allowed_origins?: string[];
  };
  mcp?: {
    enabled?: boolean;
    pi_enabled?: boolean;
    pi_token_file?: string;
    legacy_pi_tools_enabled?: boolean;
    external_enabled?: boolean;
    shell_enabled?: boolean;
    allowed_hosts?: string[];
    allowed_origins?: string[];
    max_concurrent_per_client?: number;
  };
  worker?: {
    poll_ms?: number;
  };
  admin?: {
    display_name?: string;
    auth_mode?: "local-only";
  };
  model?: {
    provider?: "pi" | "cloud" | "local";
    pi_command?: string;
    local_endpoint?: string;
  };
  docker?: {
    enabled?: boolean;
    socket_path?: string;
    compose_command?: string;
    operation_timeout_ms?: number;
    console_shells?: string[];
  };
  vm?: {
    enabled?: boolean;
    libvirt_uri?: string;
    storage_path?: string;
    network_name?: string;
    iso_roots?: string[];
    operation_timeout_ms?: number;
    console_mode?: "serial";
  };
  hostd?: {
    socket_path?: string;
  };
  shares?: {
    enabled?: boolean;
    account_username?: string;
    items?: Array<{
      id?: string;
      name?: string;
      root_id?: string;
      path?: string;
      description?: string;
      smb?: Partial<{
        enabled: boolean;
        read_only: boolean;
        browseable: boolean;
        allow_guest: boolean;
      }>;
      webdav?: Partial<{
        enabled: boolean;
        read_only: boolean;
        allow_guest: boolean;
        port: number;
        path_prefix: string;
      }>;
      ftp?: Partial<{
        enabled: boolean;
        read_only: boolean;
        allow_guest: boolean;
        port: number;
        passive_port_start: number;
        passive_port_end: number;
      }>;
      nfs?: Partial<{
        enabled: boolean;
        read_only: boolean;
        allowed_cidrs: string[];
        root_squash: boolean;
      }>;
      dlna?: Partial<{
        enabled: boolean;
        media_types: string[];
        bind_interface: string;
        bind_address: string;
        friendly_name: string;
      }>;
    }>;
  };
  terminal?: {
    user?: string;
    termux_socket_path?: string;
    session_idle_timeout_ms?: number;
    connect_timeout_ms?: number;
    max_sessions?: number;
  };
  vod_player?: {
    enabled?: boolean;
    socket_path?: string;
    state_path?: string;
    command_timeout_ms?: number;
    startup_timeout_ms?: number;
    checkpoint_interval_ms?: number;
    retry_base_delay_ms?: number;
    retry_max_delay_ms?: number;
    video_output?: "drm";
    drm_connector?: string;
    audio_output?: "alsa";
    audio_device?: string;
    hwdec?: "auto-safe" | "auto" | "no";
    user?: string;
  };
  photostaff?: {
    basemap_url?: string;
  };
  nas_roots?: Array<{
    id?: string;
    name?: string;
    path?: string;
    mount_policy?: "required" | "optional";
    expected_source?: string;
    expected_uuid?: string;
    expected_fstype?: string;
  }>;
  backup?: {
    enabled?: boolean;
    repository?: string;
    repository_path?: string;
    password_file?: string;
    staging_path?: string;
    require_mount?: boolean;
    retry_count?: number;
    timeout_ms?: number;
    keep_daily?: number;
    keep_weekly?: number;
  };
  health?: {
    stale_index_warning_ms?: number;
    stale_index_critical_ms?: number;
    stalled_run_ms?: number;
    consecutive_failure_threshold?: number;
    backup_stale_ms?: number;
  };
  monitoring?: {
    enabled?: boolean;
    fast_sample_interval_ms?: number;
    standard_sample_interval_ms?: number;
    temperature_sample_interval_ms?: number;
    raw_retention_ms?: number;
    minute_retention_ms?: number;
    hour_retention_ms?: number;
    max_database_bytes?: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ZosConfig {
  for (const removedName of ["ZOS_DATA_DIR", "ZOS_DATABASE_PATH"] as const) {
    if (env[removedName] !== undefined) {
      throw new Error(`${removedName} is no longer supported; configure ZOS_ROOT instead`);
    }
  }
  const configPath = env.ZOS_CONFIG ?? "/zos/config/config.toml";
  const fileConfig = loadTomlConfig(configPath);
  const workspaceRoot = findWorkspaceRoot(cwd);
  const environment = loadEnvironment(env, fileConfig);
  const rootDir = resolveRootDir(env, fileConfig, workspaceRoot, environment);
  const paths = resolveZosPaths(rootDir);
  const dataDir = paths.stateDir;
  const nasRoots = loadNasRoots(env, fileConfig, workspaceRoot, environment, paths);
  const backup = loadBackupConfig(env, fileConfig, workspaceRoot, dataDir, environment);
  const health = loadHealthConfig(env, fileConfig);
  const monitoring = loadMonitoringConfig(env, fileConfig);
  const apiHost = env.ZOS_API_HOST ?? fileConfig.api?.host ?? "127.0.0.1";
  const vm = loadVmConfig(env, fileConfig, workspaceRoot, paths);
  const vodPlayer = loadVodPlayerConfig(env, fileConfig, paths);
  validateConfig({ environment, apiHost, configPath, paths, dataDir, nasRoots, backup, vm, vodPlayer });

  return {
    environment,
    rootDir: paths.rootDir,
    paths,
    stateDir: paths.stateDir,
    dataRoot: paths.dataRoot,
    appsRoot: paths.appsRoot,
    isoRoot: paths.isoRoot,
    vmRoot: paths.vmRoot,
    backupRoot: paths.backupRoot,
    dataDir,
    databasePath: paths.databasePath,
    metricsDatabasePath: paths.metricsDatabasePath,
    api: {
      host: apiHost,
      port: toPort(env.ZOS_API_PORT, fileConfig.api?.port ?? 3010),
      allowedOrigins: loadAllowedOrigins(env, fileConfig)
    },
    mcp: {
      enabled: toBoolean(env.ZOS_MCP_ENABLED, fileConfig.mcp?.enabled ?? true),
      piEnabled: toBoolean(env.ZOS_MCP_PI_ENABLED, fileConfig.mcp?.pi_enabled ?? false),
      piTokenFile: loadMcpPiTokenFile(env, fileConfig, paths),
      legacyPiToolsEnabled: toBoolean(
        env.ZOS_MCP_LEGACY_PI_TOOLS_ENABLED,
        fileConfig.mcp?.legacy_pi_tools_enabled ?? false
      ),
      externalEnabled: toBoolean(env.ZOS_MCP_EXTERNAL_ENABLED, fileConfig.mcp?.external_enabled ?? false),
      shellEnabled: toBoolean(env.ZOS_MCP_SHELL_ENABLED, fileConfig.mcp?.shell_enabled ?? false),
      allowedHosts: csvSetting(env.ZOS_MCP_ALLOWED_HOSTS, fileConfig.mcp?.allowed_hosts, ["localhost", "127.0.0.1", "[::1]"]),
      allowedOrigins: csvSetting(env.ZOS_MCP_ALLOWED_ORIGINS, fileConfig.mcp?.allowed_origins, ["localhost", "127.0.0.1", "[::1]"]),
      maxConcurrentPerClient: toPositiveInteger(
        env.ZOS_MCP_MAX_CONCURRENT_PER_CLIENT,
        fileConfig.mcp?.max_concurrent_per_client ?? 4
      )
    },
    worker: {
      pollMs: toPositiveInteger(env.ZOS_WORKER_POLL_MS, fileConfig.worker?.poll_ms ?? 750)
    },
    admin: {
      displayName: env.ZOS_ADMIN_DISPLAY_NAME ?? fileConfig.admin?.display_name ?? "ZOS Admin",
      authMode: "local-only"
    },
    model: {
      provider: loadModelProvider(env.ZOS_MODEL_PROVIDER, fileConfig.model?.provider),
      piCommand: env.ZOS_PI_COMMAND ?? fileConfig.model?.pi_command ?? "pi",
      localEndpoint: env.ZOS_LOCAL_ENDPOINT ?? fileConfig.model?.local_endpoint ?? null
    },
    docker: {
      enabled: toBoolean(env.ZOS_DOCKER_ENABLED, fileConfig.docker?.enabled ?? false),
      socketPath:
        env.ZOS_DOCKER_SOCKET_PATH ?? fileConfig.docker?.socket_path ?? "/var/run/docker.sock",
      composeCommand:
        normalizeText(env.ZOS_DOCKER_COMPOSE_COMMAND) ??
        normalizeText(fileConfig.docker?.compose_command) ??
        "docker",
      operationTimeoutMs: toPositiveInteger(
        env.ZOS_DOCKER_OPERATION_TIMEOUT_MS,
        fileConfig.docker?.operation_timeout_ms ?? 120_000
      ),
      consoleShells: loadDockerConsoleShells(env, fileConfig)
    },
    vm,
    hostd: loadHostdConfig(env, fileConfig),
    shares: loadShareConfig(env, fileConfig),
    terminal: loadTerminalConfig(env, fileConfig),
    vodPlayer,
    photostaff: {
      baseMapUrl: loadPhotostaffBaseMapUrl(env, fileConfig)
    },
    nasRoots,
    backup,
    health,
    monitoring
  };
}

function loadMcpPiTokenFile(env: NodeJS.ProcessEnv, fileConfig: TomlConfig, paths: ZosPaths): string {
  const configured = env.ZOS_MCP_PI_TOKEN_FILE ?? fileConfig.mcp?.pi_token_file;
  const tokenFile = configured
    ? (path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(paths.configDir, configured))
    : path.join(paths.configDir, "mcp", "pi.token");
  if (!tokenFile.startsWith(`${path.resolve(paths.configDir)}${path.sep}`)) {
    throw new Error("MCP Pi token file must be inside the ZOS config directory");
  }
  return tokenFile;
}

function loadMonitoringConfig(
  env: NodeJS.ProcessEnv,
  fileConfig: TomlConfig
): MonitoringConfig {
  const source = fileConfig.monitoring;
  const config = {
    enabled: monitoringBoolean(env.ZOS_MONITORING_ENABLED ?? source?.enabled, true, "enabled"),
    fastSampleIntervalMs: monitoringInteger(
      env.ZOS_MONITORING_FAST_SAMPLE_INTERVAL_MS ?? source?.fast_sample_interval_ms,
      DEFAULT_MONITORING_CONFIG.fastSampleIntervalMs,
      "fast_sample_interval_ms"
    ),
    standardSampleIntervalMs: monitoringInteger(
      env.ZOS_MONITORING_STANDARD_SAMPLE_INTERVAL_MS ?? source?.standard_sample_interval_ms,
      DEFAULT_MONITORING_CONFIG.standardSampleIntervalMs,
      "standard_sample_interval_ms"
    ),
    temperatureSampleIntervalMs: monitoringInteger(
      env.ZOS_MONITORING_TEMPERATURE_SAMPLE_INTERVAL_MS ?? source?.temperature_sample_interval_ms,
      DEFAULT_MONITORING_CONFIG.temperatureSampleIntervalMs,
      "temperature_sample_interval_ms"
    ),
    rawRetentionMs: monitoringInteger(
      env.ZOS_MONITORING_RAW_RETENTION_MS ?? source?.raw_retention_ms,
      DEFAULT_MONITORING_CONFIG.rawRetentionMs,
      "raw_retention_ms"
    ),
    minuteRetentionMs: monitoringInteger(
      env.ZOS_MONITORING_MINUTE_RETENTION_MS ?? source?.minute_retention_ms,
      DEFAULT_MONITORING_CONFIG.minuteRetentionMs,
      "minute_retention_ms"
    ),
    hourRetentionMs: monitoringInteger(
      env.ZOS_MONITORING_HOUR_RETENTION_MS ?? source?.hour_retention_ms,
      DEFAULT_MONITORING_CONFIG.hourRetentionMs,
      "hour_retention_ms"
    ),
    maxDatabaseBytes: monitoringInteger(
      env.ZOS_MONITORING_MAX_DATABASE_BYTES ?? source?.max_database_bytes,
      DEFAULT_MONITORING_CONFIG.maxDatabaseBytes,
      "max_database_bytes"
    )
  };
  validateMonitoringConfig(config);
  return config;
}

function monitoringBoolean(
  value: string | boolean | undefined,
  fallback: boolean,
  name: string
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error(`Monitoring ${name} must be 0 or 1`);
}

function monitoringInteger(
  value: string | number | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Monitoring ${name} must be a positive integer`);
  }
  return parsed;
}

function validateMonitoringConfig(config: MonitoringConfig): void {
  if (config.fastSampleIntervalMs < 1_000 || config.fastSampleIntervalMs > 5 * 60_000) {
    throw new Error("Monitoring fast_sample_interval_ms must be between 1000 and 300000");
  }
  if (
    config.standardSampleIntervalMs < config.fastSampleIntervalMs
    || config.standardSampleIntervalMs > 15 * 60_000
  ) {
    throw new Error("Monitoring standard_sample_interval_ms must be at least the fast interval and at most 900000");
  }
  if (
    config.temperatureSampleIntervalMs < config.standardSampleIntervalMs
    || config.temperatureSampleIntervalMs > 60 * 60_000
  ) {
    throw new Error("Monitoring temperature_sample_interval_ms must be at least the standard interval and at most 3600000");
  }
  if (config.rawRetentionMs < 60 * 60_000) {
    throw new Error("Monitoring raw_retention_ms must be at least one hour");
  }
  if (config.minuteRetentionMs < config.rawRetentionMs) {
    throw new Error("Monitoring minute_retention_ms must be at least raw_retention_ms");
  }
  if (config.hourRetentionMs < config.minuteRetentionMs) {
    throw new Error("Monitoring hour_retention_ms must be at least minute_retention_ms");
  }
  if (config.maxDatabaseBytes < 64 * 1024 * 1024 || config.maxDatabaseBytes > 4 * 1024 * 1024 * 1024) {
    throw new Error("Monitoring max_database_bytes must be between 67108864 and 4294967296");
  }
}

function loadPhotostaffBaseMapUrl(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): string {
  const value = normalizeText(env.ZOS_PHOTOSTAFF_BASEMAP_URL) ??
    normalizeText(fileConfig.photostaff?.basemap_url) ??
    PHOTOSTAFF_BASE_MAP_RELEASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Photostaff base map URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Photostaff base map URL must use HTTPS");
  }
  return url.toString();
}

function loadHostdConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): ZosConfig["hostd"] {
  const socketPath =
    normalizeText(env.ZOS_HOSTD_SOCKET_PATH) ??
    normalizeText(fileConfig.hostd?.socket_path) ??
    "/run/zos/hostd.sock";
  return {
    socketPath: path.isAbsolute(socketPath) ? socketPath : "/run/zos/hostd.sock"
  };
}

function loadVmConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig, cwd: string, paths: ZosPaths): VmConfig {
  const vm = fileConfig.vm;
  const isoRoots = env.ZOS_VM_ISO_ROOTS
    ? env.ZOS_VM_ISO_ROOTS.split(",").map((value) => path.resolve(cwd, value.trim())).filter(Boolean)
    : (vm?.iso_roots ?? [paths.isoRoot]).map((value) => path.resolve(cwd, value));
  return {
    enabled: toBoolean(env.ZOS_VM_ENABLED, vm?.enabled ?? true),
    libvirtUri: env.ZOS_VM_LIBVIRT_URI ?? vm?.libvirt_uri ?? "qemu:///system",
    storagePath: path.resolve(cwd, env.ZOS_VM_STORAGE_PATH ?? vm?.storage_path ?? paths.vmRoot),
    networkName: env.ZOS_VM_NETWORK_NAME ?? vm?.network_name ?? "default",
    isoRoots,
    operationTimeoutMs: toPositiveInteger(
      env.ZOS_VM_OPERATION_TIMEOUT_MS,
      vm?.operation_timeout_ms ?? 120_000
    ),
    consoleMode: "serial"
  };
}

function loadTomlConfig(configPath: string): TomlConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const parsed = parse(readFileSync(configPath, "utf8")) as TomlConfig;
  return parsed;
}

function loadNasRoots(
  env: NodeJS.ProcessEnv,
  fileConfig: TomlConfig,
  cwd: string,
  environment: "development" | "production",
  paths: ZosPaths
): NasRootConfig[] {
  if (env.ZOS_NAS_ROOTS) {
    return env.ZOS_NAS_ROOTS.split(",")
      .map((entry, index) => parseNasRootEnv(entry.trim(), index, cwd))
      .filter((root): root is NasRootConfig => root !== null)
      .map((root) => ({ ...root, mountPolicy: root.mountPolicy ?? (environment === "production" ? "required" : "optional"), expectedSource: root.expectedSource ?? null, expectedUuid: root.expectedUuid ?? null, expectedFstype: root.expectedFstype ?? null }));
  }

  if (fileConfig.nas_roots?.length) {
    return fileConfig.nas_roots.map((root, index) => ({
      id: root.id ?? `root-${index + 1}`,
      name: root.name ?? root.id ?? `Root ${index + 1}`,
      path: path.resolve(cwd, root.path ?? paths.defaultDataRoot),
      mountPolicy: root.mount_policy ?? (environment === "production" ? "required" : "optional"),
      expectedSource: normalizeText(root.expected_source),
      expectedUuid: normalizeText(root.expected_uuid),
      expectedFstype: normalizeText(root.expected_fstype)
    }));
  }

  const fallback = { id: "primary", name: "Primary data", path: paths.defaultDataRoot };
  return environment === "production"
    ? [{ ...fallback, mountPolicy: "required", expectedSource: null, expectedUuid: null, expectedFstype: null }]
    : [fallback];
}

function loadEnvironment(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): "development" | "production" {
  const value = (env.ZOS_ENVIRONMENT ?? fileConfig.environment ?? "development").trim().toLowerCase();
  return value === "production" ? "production" : "development";
}

function loadBackupConfig(
  env: NodeJS.ProcessEnv,
  fileConfig: TomlConfig,
  cwd: string,
  dataDir: string,
  environment: "development" | "production"
): NonNullable<ZosConfig["backup"]> {
  const source = fileConfig.backup;
  const repositoryRaw = normalizeText(env.ZOS_BACKUP_REPOSITORY ?? env.ZOS_BACKUP_REPOSITORY_PATH ?? source?.repository_path ?? source?.repository);
  const passwordFileRaw = normalizeText(env.ZOS_BACKUP_PASSWORD_FILE ?? source?.password_file);
  const stagingRaw = normalizeText(env.ZOS_BACKUP_STAGING_PATH ?? source?.staging_path);
  const enabled = toBoolean(env.ZOS_BACKUP_ENABLED, source?.enabled ?? Boolean(repositoryRaw));
  const result = {
    enabled,
    repositoryPath: repositoryRaw ? path.resolve(cwd, repositoryRaw) : null,
    passwordFile: passwordFileRaw ? path.resolve(cwd, passwordFileRaw) : null,
    stagingPath: stagingRaw ? path.resolve(cwd, stagingRaw) : path.join(dataDir, "backup-staging"),
    requireMount: toBoolean(env.ZOS_BACKUP_REQUIRE_MOUNT, source?.require_mount ?? environment === "production"),
    retryCount: toPositiveInteger(env.ZOS_BACKUP_RETRY_COUNT, source?.retry_count ?? 2),
    timeoutMs: toPositiveInteger(env.ZOS_BACKUP_TIMEOUT_MS, source?.timeout_ms ?? 300_000),
    keepDaily: toPositiveInteger(env.ZOS_BACKUP_KEEP_DAILY, source?.keep_daily ?? 7),
    keepWeekly: toPositiveInteger(env.ZOS_BACKUP_KEEP_WEEKLY, source?.keep_weekly ?? 4)
  };
  if (result.enabled && result.passwordFile) {
    try {
      accessSync(result.passwordFile, fsConstants.R_OK);
    } catch {
      throw new Error(`Backup password file is not readable: ${result.passwordFile}`);
    }
  }
  return result;
}

function loadHealthConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): NonNullable<ZosConfig["health"]> {
  const source = fileConfig.health;
  return {
    staleIndexWarningMs: toPositiveInteger(env.ZOS_HEALTH_STALE_INDEX_WARNING_MS, source?.stale_index_warning_ms ?? 2 * 60 * 60 * 1000),
    staleIndexCriticalMs: toPositiveInteger(env.ZOS_HEALTH_STALE_INDEX_CRITICAL_MS, source?.stale_index_critical_ms ?? 6 * 60 * 60 * 1000),
    stalledRunMs: toPositiveInteger(env.ZOS_HEALTH_STALLED_RUN_MS, source?.stalled_run_ms ?? 15 * 60 * 1000),
    consecutiveFailureThreshold: toPositiveInteger(env.ZOS_HEALTH_CONSECUTIVE_FAILURE_THRESHOLD, source?.consecutive_failure_threshold ?? 2),
    backupStaleMs: toPositiveInteger(env.ZOS_HEALTH_BACKUP_STALE_MS, source?.backup_stale_ms ?? 26 * 60 * 60 * 1000)
  };
}

function validateConfig(input: {
  environment: "development" | "production";
  apiHost: string;
  configPath: string;
  paths: ZosPaths;
  dataDir: string;
  nasRoots: NasRootConfig[];
  backup: NonNullable<ZosConfig["backup"]>;
  vm: VmConfig;
  vodPlayer: VodPlayerConfig;
}): void {
  if (!isLoopbackHost(input.apiHost)) {
    throw new Error("ZOS API must bind to a loopback host");
  }
  if (input.environment === "production" && input.paths.rootDir !== "/zos") {
    throw new Error(`Production ZOS root must be /zos: ${input.paths.rootDir}`);
  }
  if (input.environment === "production" && path.resolve(input.configPath) !== path.join(input.paths.configDir, "config.toml")) {
    throw new Error(`Production ZOS config must be ${path.join(input.paths.configDir, "config.toml")}`);
  }
  for (const root of input.nasRoots) {
    if (isUnder(root.path, input.paths.appsRoot) || isUnder(input.paths.appsRoot, root.path)) {
      throw new Error(`Production NAS roots must not overlap ${input.paths.appsRoot}`);
    }
    if (path.dirname(path.resolve(root.path)) !== input.paths.dataRoot || path.resolve(root.path) === input.paths.backupRoot) {
      throw new Error(`NAS roots must be direct children of ${input.paths.dataRoot}: ${root.path}`);
    }
  }
  if (!isUnder(input.vm.storagePath, input.paths.vmRoot)) {
    throw new Error(`VM storage must be under ${input.paths.vmRoot}`);
  }
  for (const isoRoot of input.vm.isoRoots) {
    if (!isUnder(isoRoot, input.paths.isoRoot)) {
      throw new Error(`VM ISO roots must be under ${input.paths.isoRoot}`);
    }
  }
  if (!isUnder(input.vodPlayer.statePath, input.paths.vodPlayerStateDir)) {
    throw new Error(`VOD Player state must be under ${input.paths.vodPlayerStateDir}`);
  }
  if (input.environment !== "production") return;
  if (isPrivateTemporaryPath(input.vodPlayer.socketPath) || isPrivateTemporaryPath(input.vodPlayer.statePath)) {
    throw new Error("VOD Player socket_path and state_path cannot use /tmp or /var/tmp");
  }
  const backup = input.backup;
  if (!backup.enabled) return;
  if (!backup.repositoryPath || !isUnder(backup.repositoryPath, input.paths.backupRoot)) {
    throw new Error(`Production backup repository must be configured under ${input.paths.backupRoot}`);
  }
  if (isUnder(backup.repositoryPath, input.dataDir) || isUnder(input.dataDir, backup.repositoryPath)) {
    throw new Error("Backup repository must not overlap dataDir");
  }
  for (const root of input.nasRoots) {
    if (isUnder(backup.repositoryPath, root.path) || isUnder(root.path, backup.repositoryPath) || isUnder(backup.stagingPath, root.path) || isUnder(root.path, backup.stagingPath)) {
      throw new Error("Backup paths must not overlap NAS roots");
    }
  }
  if (isUnder(backup.repositoryPath, backup.stagingPath) || isUnder(backup.stagingPath, backup.repositoryPath)) {
    throw new Error("Backup repository and staging paths must not overlap");
  }
  if (!isUnder(backup.stagingPath, input.paths.stateDir)) {
    throw new Error(`Backup staging must be under ${input.paths.stateDir}`);
  }
  if (backup.passwordFile && !isUnder(backup.passwordFile, input.paths.configDir)) {
    throw new Error(`Backup password file must be under ${input.paths.configDir}`);
  }
}

function isUnder(candidate: string, parent: string): boolean {
  const child = path.resolve(candidate);
  const base = path.resolve(parent);
  return child === base || child.startsWith(`${base}${path.sep}`);
}

function resolveRootDir(
  env: NodeJS.ProcessEnv,
  fileConfig: TomlConfig,
  workspaceRoot: string,
  environment: "development" | "production"
): string {
  const configured = normalizeText(env.ZOS_ROOT) ?? normalizeText(fileConfig.root_dir);
  const root = configured
    ? path.resolve(workspaceRoot, configured)
    : environment === "production"
      ? "/zos"
      : path.resolve(workspaceRoot, ".zos", "dev-root");
  if (environment === "production" && root !== "/zos") {
    throw new Error(`Production ZOS root must be /zos: ${root}`);
  }
  if (root === path.parse(root).root) {
    throw new Error(`ZOS root cannot be the filesystem root: ${root}`);
  }
  return root;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function loadDockerConsoleShells(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): string[] {
  const rawShells = env.ZOS_DOCKER_CONSOLE_SHELLS
    ? env.ZOS_DOCKER_CONSOLE_SHELLS.split(",")
    : fileConfig.docker?.console_shells;
  const shells = (rawShells ?? [])
    .map((shell) => normalizeText(shell))
    .filter((shell): shell is string => shell !== null && path.isAbsolute(shell));
  return shells.length ? shells : ["/bin/sh", "/bin/bash"];
}

function loadShareConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): ShareConfig {
  const shares = fileConfig.shares;
  return {
    enabled: toBoolean(env.ZOS_SHARES_ENABLED, shares?.enabled ?? false),
    account: {
      username:
        normalizeText(env.ZOS_SHARE_ACCOUNT_USERNAME) ??
        normalizeText(shares?.account_username) ??
        "zos-share",
      password: null
    },
    shares: (shares?.items ?? []).map(normalizeShareItem).filter((item): item is ShareDefinitionConfig => item !== null)
  };
}

function loadTerminalConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): TerminalConfig {
  return {
    user: normalizeText(env.ZOS_TERMUX_USER) ?? normalizeText(fileConfig.terminal?.user),
    termuxSocketPath:
      normalizeText(env.ZOS_TERMUX_SOCKET_PATH) ??
      normalizeText(fileConfig.terminal?.termux_socket_path) ??
      "/run/zos/termux.sock",
    sessionIdleTimeoutMs: toPositiveInteger(
      env.ZOS_TERMUX_SESSION_IDLE_TIMEOUT_MS,
      fileConfig.terminal?.session_idle_timeout_ms ?? TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS
    ),
    connectTimeoutMs: toPositiveInteger(
      env.ZOS_TERMUX_CONNECT_TIMEOUT_MS,
      fileConfig.terminal?.connect_timeout_ms ?? TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS
    ),
    maxSessions: toPositiveInteger(
      env.ZOS_TERMUX_MAX_SESSIONS,
      fileConfig.terminal?.max_sessions ?? 32
    )
  };
}

function loadVodPlayerConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig, paths: ZosPaths): VodPlayerConfig {
  const player = fileConfig.vod_player;
  const videoOutput = env.ZOS_VOD_PLAYER_VIDEO_OUTPUT ?? player?.video_output ?? "drm";
  const audioOutput = env.ZOS_VOD_PLAYER_AUDIO_OUTPUT ?? player?.audio_output ?? "alsa";
  const hwdec = env.ZOS_VOD_PLAYER_HWDEC ?? player?.hwdec ?? "auto-safe";
  const socketPath =
    normalizeText(env.ZOS_VOD_PLAYER_SOCKET_PATH) ??
    normalizeText(player?.socket_path) ??
    "/run/zos/vod-player.sock";
  const statePath =
    normalizeText(env.ZOS_VOD_PLAYER_STATE_PATH) ??
    normalizeText(player?.state_path) ??
    path.join(paths.vodPlayerStateDir, "session.json");
  const playerUser = normalizeText(env.ZOS_VOD_PLAYER_USER) ?? normalizeText(player?.user) ?? "zos";
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(statePath)) {
    throw new Error("VOD Player socket_path and state_path must be absolute");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(playerUser) || playerUser === "root") {
    throw new Error("VOD Player user must name a non-root local account");
  }
  if (videoOutput !== "drm" || audioOutput !== "alsa" || !["auto-safe", "auto", "no"].includes(hwdec)) {
    throw new Error("VOD Player output configuration is invalid");
  }
  const retryBaseDelayMs = strictPositiveInteger(
    env.ZOS_VOD_PLAYER_RETRY_BASE_DELAY_MS ?? player?.retry_base_delay_ms,
    2_000,
    "retry_base_delay_ms"
  );
  const retryMaxDelayMs = strictPositiveInteger(
    env.ZOS_VOD_PLAYER_RETRY_MAX_DELAY_MS ?? player?.retry_max_delay_ms,
    60_000,
    "retry_max_delay_ms"
  );
  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new Error("VOD Player retry_max_delay_ms must be at least retry_base_delay_ms");
  }
  return {
    enabled: strictBoolean(
      env.ZOS_VOD_PLAYER_ENABLED ?? player?.enabled,
      false,
      "enabled"
    ),
    socketPath,
    statePath,
    commandTimeoutMs: strictPositiveInteger(
      env.ZOS_VOD_PLAYER_COMMAND_TIMEOUT_MS ?? player?.command_timeout_ms,
      5_000,
      "command_timeout_ms"
    ),
    startupTimeoutMs: strictPositiveInteger(
      env.ZOS_VOD_PLAYER_STARTUP_TIMEOUT_MS ?? player?.startup_timeout_ms,
      15_000,
      "startup_timeout_ms"
    ),
    checkpointIntervalMs: strictPositiveInteger(
      env.ZOS_VOD_PLAYER_CHECKPOINT_INTERVAL_MS ?? player?.checkpoint_interval_ms,
      5_000,
      "checkpoint_interval_ms"
    ),
    retryBaseDelayMs,
    retryMaxDelayMs,
    videoOutput: "drm",
    drmConnector:
      normalizeText(env.ZOS_VOD_PLAYER_DRM_CONNECTOR) ??
      normalizeText(player?.drm_connector) ??
      null,
    audioOutput: "alsa",
    audioDevice:
      normalizeText(env.ZOS_VOD_PLAYER_AUDIO_DEVICE) ??
      normalizeText(player?.audio_device) ??
      null,
    hwdec: hwdec as VodPlayerConfig["hwdec"],
    user: playerUser
  };
}

function isPrivateTemporaryPath(value: string): boolean {
  return value === "/tmp" || value.startsWith("/tmp/") || value === "/var/tmp" || value.startsWith("/var/tmp/");
}

function strictBoolean(value: string | boolean | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`VOD Player ${name} must be 0 or 1`);
}

function strictPositiveInteger(value: string | number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`VOD Player ${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeShareItem(item: NonNullable<NonNullable<TomlConfig["shares"]>["items"]>[number], index: number): ShareDefinitionConfig | null {
  const rootId = normalizeText(item.root_id);
  const sharePath = normalizeText(item.path);
  if (!rootId || !sharePath) {
    return null;
  }
  const id = normalizeText(item.id) ?? `share-${index + 1}`;
  const name = normalizeText(item.name) ?? id;
  return {
    id,
    name,
    rootId,
    path: sharePath,
    description: normalizeText(item.description) ?? "",
    protocols: normalizeShareProtocols(item, name)
  };
}

function normalizeShareProtocols(
  item: NonNullable<NonNullable<TomlConfig["shares"]>["items"]>[number],
  name: string
): ShareProtocolConfig {
  return {
    smb: {
      enabled: Boolean(item.smb?.enabled),
      readOnly: item.smb?.read_only ?? true,
      browseable: item.smb?.browseable ?? true,
      allowGuest: item.smb?.allow_guest ?? false
    },
    webdav: {
      enabled: Boolean(item.webdav?.enabled),
      readOnly: item.webdav?.read_only ?? true,
      allowGuest: item.webdav?.allow_guest ?? false,
      port: toPositiveInteger(item.webdav?.port, 8088),
      pathPrefix: normalizeText(item.webdav?.path_prefix) ?? `/shares/${idPath(name)}`
    },
    ftp: {
      enabled: Boolean(item.ftp?.enabled),
      readOnly: item.ftp?.read_only ?? true,
      allowGuest: item.ftp?.allow_guest ?? false,
      port: toPositiveInteger(item.ftp?.port, 2121),
      passivePortStart: toPositiveInteger(item.ftp?.passive_port_start, 50000),
      passivePortEnd: toPositiveInteger(item.ftp?.passive_port_end, 50100)
    },
    nfs: {
      enabled: Boolean(item.nfs?.enabled),
      readOnly: item.nfs?.read_only ?? true,
      allowedCidrs: (item.nfs?.allowed_cidrs ?? []).map((cidr) => cidr.trim()).filter(Boolean),
      rootSquash: item.nfs?.root_squash ?? true
    },
    dlna: {
      enabled: Boolean(item.dlna?.enabled),
      mediaTypes: normalizeDlnaMediaTypes(item.dlna?.media_types),
      bindInterface: normalizeText(item.dlna?.bind_interface) ?? null,
      bindAddress: normalizeText(item.dlna?.bind_address) ?? null,
      friendlyName: normalizeText(item.dlna?.friendly_name) ?? name
    }
  };
}

function normalizeDlnaMediaTypes(values: string[] | undefined): DlnaMediaType[] {
  const mediaTypes = (values ?? ["audio", "video", "pictures"]).filter(isDlnaMediaType);
  return mediaTypes.length ? mediaTypes : ["audio", "video", "pictures"];
}

function isDlnaMediaType(value: string): value is DlnaMediaType {
  return value === "audio" || value === "video" || value === "pictures";
}

function idPath(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "") || "share";
}

function parseNasRootEnv(entry: string, index: number, cwd: string): NasRootConfig | null {
  return parseNamedPathEnv(entry, index, cwd, "root");
}

function parseNamedPathEnv(
  entry: string,
  index: number,
  cwd: string,
  fallbackPrefix: string
): NasRootConfig | null {
  if (!entry) {
    return null;
  }

  const parts = entry.split(":");
  if (parts.length >= 3) {
    const [id, name, ...pathParts] = parts;
    const fallbackId = `${fallbackPrefix}-${index + 1}`;
    return {
      id: id || fallbackId,
      name: name || id || fallbackId,
      path: path.resolve(cwd, pathParts.join(":"))
    };
  }

  const rootPath = path.resolve(cwd, entry);
  const id = `${fallbackPrefix}-${index + 1}`;
  return {
    id,
    name: path.basename(rootPath) || id,
    path: rootPath
  };
}

function toPort(value: string | undefined, fallback: number): number {
  return toPositiveInteger(value, fallback);
}

function loadModelProvider(
  envValue: string | undefined,
  fileValue: "pi" | "cloud" | "local" | undefined
): "pi" | "cloud" | "local" {
  const raw = envValue ?? fileValue ?? "pi";
  return raw === "cloud" || raw === "local" || raw === "pi" ? raw : "pi";
}

function loadAllowedOrigins(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): string[] {
  if (env.ZOS_ALLOWED_ORIGINS) {
    return env.ZOS_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  return fileConfig.api?.allowed_origins ?? [];
}

function csvSetting(envValue: string | undefined, fileValue: string[] | undefined, fallback: string[]): string[] {
  const values = envValue === undefined ? (fileValue ?? fallback) : envValue.split(",");
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function toBoolean(value: string | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function toPositiveInteger(value: string | number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function findWorkspaceRoot(startPath: string): string {
  let current = path.resolve(startPath);

  while (true) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { workspaces?: unknown };
        if (pkg.workspaces) {
          return current;
        }
      } catch {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startPath);
    }
    current = parent;
  }
}
