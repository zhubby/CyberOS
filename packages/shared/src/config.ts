import { accessSync, existsSync, readFileSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import {
  TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS,
  TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS
} from "./terminal-protocol.js";
import { PHOTOS_BASE_MAP_RELEASE_URL } from "./photos-config.js";
import { resolveCyberOsPaths, type CyberOsPaths } from "./paths.js";
import type {
  DlnaMediaType,
  ShareConfig,
  ShareDefinitionConfig,
  ShareProtocolConfig,
  VodPlayerConfig,
  CyberOsConfig,
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
    external_enabled?: boolean;
    shell_enabled?: boolean;
    allowed_hosts?: string[];
    allowed_origins?: string[];
    max_concurrent_per_client?: number;
  };
  worker?: {
    poll_ms?: number;
    concurrency?: number;
  };
  admin?: {
    display_name?: string;
    auth_mode?: "local-only";
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
      storage_pool_id?: string;
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
    socket_path?: string;
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
    video_output?: "drm" | "wayland";
    drm_connector?: string;
    audio_output?: "alsa";
    audio_device?: string;
    hwdec?: "auto-safe" | "auto" | "no";
    user?: string;
  };
  photos?: {
    basemap_url?: string;
  };
  backup?: {
    enabled?: boolean;
    repository?: string;
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

type TomlScalarRule = "string" | "number" | "boolean" | "string[]";
type TomlRule =
  | TomlScalarRule
  | TomlSchema
  | { array: TomlSchema }
  | { enum: readonly (string | number | boolean)[] };
type TomlSchema = { readonly [key: string]: TomlRule };

const SHARE_PROTOCOL_SCHEMA = {
  enabled: "boolean",
  read_only: "boolean",
  allow_guest: "boolean"
} as const satisfies TomlSchema;

const TOML_SCHEMA = {
  environment: { enum: ["development", "production"] },
  root_dir: "string",
  api: { host: "string", port: "number", allowed_origins: "string[]" },
  mcp: {
    enabled: "boolean",
    pi_enabled: "boolean",
    pi_token_file: "string",
    external_enabled: "boolean",
    shell_enabled: "boolean",
    allowed_hosts: "string[]",
    allowed_origins: "string[]",
    max_concurrent_per_client: "number"
  },
  worker: { poll_ms: "number", concurrency: "number" },
  admin: { display_name: "string", auth_mode: { enum: ["local-only"] } },
  docker: {
    enabled: "boolean",
    socket_path: "string",
    compose_command: "string",
    operation_timeout_ms: "number",
    console_shells: "string[]"
  },
  vm: {
    enabled: "boolean",
    libvirt_uri: "string",
    storage_path: "string",
    network_name: "string",
    iso_roots: "string[]",
    operation_timeout_ms: "number",
    console_mode: { enum: ["serial"] }
  },
  hostd: { socket_path: "string" },
  shares: {
    enabled: "boolean",
    account_username: "string",
    items: {
      array: {
        id: "string",
        name: "string",
        storage_pool_id: "string",
        path: "string",
        description: "string",
        smb: { ...SHARE_PROTOCOL_SCHEMA, browseable: "boolean" },
        webdav: { ...SHARE_PROTOCOL_SCHEMA, port: "number", path_prefix: "string" },
        ftp: {
          ...SHARE_PROTOCOL_SCHEMA,
          port: "number",
          passive_port_start: "number",
          passive_port_end: "number"
        },
        nfs: {
          enabled: "boolean",
          read_only: "boolean",
          allowed_cidrs: "string[]",
          root_squash: "boolean"
        },
        dlna: {
          enabled: "boolean",
          media_types: "string[]",
          bind_interface: "string",
          bind_address: "string",
          friendly_name: "string"
        }
      }
    }
  },
  terminal: {
    user: "string",
    socket_path: "string",
    session_idle_timeout_ms: "number",
    connect_timeout_ms: "number",
    max_sessions: "number"
  },
  vod_player: {
    enabled: "boolean",
    socket_path: "string",
    state_path: "string",
    command_timeout_ms: "number",
    startup_timeout_ms: "number",
    checkpoint_interval_ms: "number",
    retry_base_delay_ms: "number",
    retry_max_delay_ms: "number",
    video_output: { enum: ["drm", "wayland"] },
    drm_connector: "string",
    audio_output: { enum: ["alsa"] },
    audio_device: "string",
    hwdec: { enum: ["auto-safe", "auto", "no"] },
    user: "string"
  },
  photos: { basemap_url: "string" },
  backup: {
    enabled: "boolean",
    repository: "string",
    password_file: "string",
    staging_path: "string",
    require_mount: "boolean",
    retry_count: "number",
    timeout_ms: "number",
    keep_daily: "number",
    keep_weekly: "number"
  },
  health: {
    stale_index_warning_ms: "number",
    stale_index_critical_ms: "number",
    stalled_run_ms: "number",
    consecutive_failure_threshold: "number",
    backup_stale_ms: "number"
  },
  monitoring: {
    enabled: "boolean",
    fast_sample_interval_ms: "number",
    standard_sample_interval_ms: "number",
    temperature_sample_interval_ms: "number",
    raw_retention_ms: "number",
    minute_retention_ms: "number",
    hour_retention_ms: "number",
    max_database_bytes: "number"
  }
} as const satisfies TomlSchema;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): CyberOsConfig {
  for (const removedName of ["CYBEROS_DATA_DIR", "CYBEROS_DATABASE_PATH"] as const) {
    if (env[removedName] !== undefined) {
      throw new Error(`${removedName} is no longer supported; configure CYBEROS_ROOT instead`);
    }
  }
  const configPath = env.CYBEROS_CONFIG ?? "/cyberos/config/config.toml";
  const fileConfig = loadTomlConfig(configPath);
  const workspaceRoot = findWorkspaceRoot(cwd);
  const environment = loadEnvironment(env, fileConfig);
  const rootDir = resolveRootDir(env, fileConfig, workspaceRoot, environment);
  const paths = resolveCyberOsPaths(rootDir);
  const backup = loadBackupConfig(env, fileConfig, workspaceRoot, paths.stateDir, environment);
  const health = loadHealthConfig(env, fileConfig);
  const monitoring = loadMonitoringConfig(env, fileConfig);
  const apiHost = env.CYBEROS_API_HOST ?? fileConfig.api?.host ?? "127.0.0.1";
  const vm = loadVmConfig(env, fileConfig, workspaceRoot, paths);
  const vodPlayer = loadVodPlayerConfig(env, fileConfig, paths);
  validateConfig({ environment, apiHost, configPath, paths, backup, vm, vodPlayer });

  return {
    environment,
    paths,
    api: {
      host: apiHost,
      port: toPort(env.CYBEROS_API_PORT, fileConfig.api?.port ?? 3010),
      allowedOrigins: loadAllowedOrigins(env, fileConfig)
    },
    mcp: {
      enabled: toBoolean(env.CYBEROS_MCP_ENABLED, fileConfig.mcp?.enabled ?? true),
      piEnabled: toBoolean(env.CYBEROS_MCP_PI_ENABLED, fileConfig.mcp?.pi_enabled ?? false),
      piTokenFile: loadMcpPiTokenFile(env, fileConfig, paths),
      externalEnabled: toBoolean(env.CYBEROS_MCP_EXTERNAL_ENABLED, fileConfig.mcp?.external_enabled ?? false),
      shellEnabled: toBoolean(env.CYBEROS_MCP_SHELL_ENABLED, fileConfig.mcp?.shell_enabled ?? false),
      allowedHosts: csvSetting(env.CYBEROS_MCP_ALLOWED_HOSTS, fileConfig.mcp?.allowed_hosts, ["localhost", "127.0.0.1", "[::1]"]),
      allowedOrigins: csvSetting(env.CYBEROS_MCP_ALLOWED_ORIGINS, fileConfig.mcp?.allowed_origins, ["localhost", "127.0.0.1", "[::1]"]),
      maxConcurrentPerClient: toPositiveInteger(
        env.CYBEROS_MCP_MAX_CONCURRENT_PER_CLIENT,
        fileConfig.mcp?.max_concurrent_per_client ?? 4
      )
    },
    worker: {
      pollMs: toPositiveInteger(env.CYBEROS_WORKER_POLL_MS, fileConfig.worker?.poll_ms ?? 750),
      concurrency: toPositiveInteger(
        env.CYBEROS_WORKER_CONCURRENCY,
        fileConfig.worker?.concurrency ?? 2
      )
    },
    admin: {
      displayName: env.CYBEROS_ADMIN_DISPLAY_NAME ?? fileConfig.admin?.display_name ?? "CyberOS Admin",
      authMode: "local-only"
    },
    docker: {
      enabled: toBoolean(env.CYBEROS_DOCKER_ENABLED, fileConfig.docker?.enabled ?? false),
      socketPath:
        env.CYBEROS_DOCKER_SOCKET_PATH ?? fileConfig.docker?.socket_path ?? "/var/run/docker.sock",
      composeCommand:
        normalizeText(env.CYBEROS_DOCKER_COMPOSE_COMMAND) ??
        normalizeText(fileConfig.docker?.compose_command) ??
        "docker",
      operationTimeoutMs: toPositiveInteger(
        env.CYBEROS_DOCKER_OPERATION_TIMEOUT_MS,
        fileConfig.docker?.operation_timeout_ms ?? 120_000
      ),
      consoleShells: loadDockerConsoleShells(env, fileConfig)
    },
    vm,
    hostd: loadHostdConfig(env, fileConfig),
    shares: loadShareConfig(env, fileConfig),
    terminal: loadTerminalConfig(env, fileConfig),
    vodPlayer,
    photos: {
      baseMapUrl: loadPhotosBaseMapUrl(env, fileConfig)
    },
    backup,
    health,
    monitoring
  };
}

function loadMcpPiTokenFile(env: NodeJS.ProcessEnv, fileConfig: TomlConfig, paths: CyberOsPaths): string {
  const configured = env.CYBEROS_MCP_PI_TOKEN_FILE ?? fileConfig.mcp?.pi_token_file;
  const tokenFile = configured
    ? (path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(paths.configDir, configured))
    : path.join(paths.configDir, "mcp", "pi.token");
  if (!tokenFile.startsWith(`${path.resolve(paths.configDir)}${path.sep}`)) {
    throw new Error("MCP Pi token file must be inside the CyberOS config directory");
  }
  return tokenFile;
}

function loadMonitoringConfig(
  env: NodeJS.ProcessEnv,
  fileConfig: TomlConfig
): MonitoringConfig {
  const source = fileConfig.monitoring;
  const config = {
    enabled: monitoringBoolean(env.CYBEROS_MONITORING_ENABLED ?? source?.enabled, true, "enabled"),
    fastSampleIntervalMs: monitoringInteger(
      env.CYBEROS_MONITORING_FAST_SAMPLE_INTERVAL_MS ?? source?.fast_sample_interval_ms,
      DEFAULT_MONITORING_CONFIG.fastSampleIntervalMs,
      "fast_sample_interval_ms"
    ),
    standardSampleIntervalMs: monitoringInteger(
      env.CYBEROS_MONITORING_STANDARD_SAMPLE_INTERVAL_MS ?? source?.standard_sample_interval_ms,
      DEFAULT_MONITORING_CONFIG.standardSampleIntervalMs,
      "standard_sample_interval_ms"
    ),
    temperatureSampleIntervalMs: monitoringInteger(
      env.CYBEROS_MONITORING_TEMPERATURE_SAMPLE_INTERVAL_MS ?? source?.temperature_sample_interval_ms,
      DEFAULT_MONITORING_CONFIG.temperatureSampleIntervalMs,
      "temperature_sample_interval_ms"
    ),
    rawRetentionMs: monitoringInteger(
      env.CYBEROS_MONITORING_RAW_RETENTION_MS ?? source?.raw_retention_ms,
      DEFAULT_MONITORING_CONFIG.rawRetentionMs,
      "raw_retention_ms"
    ),
    minuteRetentionMs: monitoringInteger(
      env.CYBEROS_MONITORING_MINUTE_RETENTION_MS ?? source?.minute_retention_ms,
      DEFAULT_MONITORING_CONFIG.minuteRetentionMs,
      "minute_retention_ms"
    ),
    hourRetentionMs: monitoringInteger(
      env.CYBEROS_MONITORING_HOUR_RETENTION_MS ?? source?.hour_retention_ms,
      DEFAULT_MONITORING_CONFIG.hourRetentionMs,
      "hour_retention_ms"
    ),
    maxDatabaseBytes: monitoringInteger(
      env.CYBEROS_MONITORING_MAX_DATABASE_BYTES ?? source?.max_database_bytes,
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

function loadPhotosBaseMapUrl(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): string {
  const value = normalizeText(env.CYBEROS_PHOTOS_BASEMAP_URL) ??
    normalizeText(fileConfig.photos?.basemap_url) ??
    PHOTOS_BASE_MAP_RELEASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Photos base map URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Photos base map URL must use HTTPS");
  }
  return url.toString();
}

function loadHostdConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): CyberOsConfig["hostd"] {
  const socketPath =
    normalizeText(env.CYBEROS_HOSTD_SOCKET_PATH) ??
    normalizeText(fileConfig.hostd?.socket_path) ??
    "/run/cyberos/hostd.sock";
  if (!path.isAbsolute(socketPath)) {
    throw new Error("Hostd socket_path must be absolute");
  }
  return {
    socketPath,
    mutationPolicy: parseHostMutationPolicy(env.CYBEROS_HOST_MUTATION_POLICY)
  };
}

function parseHostMutationPolicy(value: string | undefined): "mutable" | "declarative" {
  const normalized = normalizeText(value) ?? "mutable";
  if (normalized === "mutable" || normalized === "declarative") {
    return normalized;
  }
  throw new Error("CYBEROS_HOST_MUTATION_POLICY must be mutable or declarative");
}

function loadVmConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig, cwd: string, paths: CyberOsPaths): VmConfig {
  const vm = fileConfig.vm;
  const isoRoots = env.CYBEROS_VM_ISO_ROOTS
    ? env.CYBEROS_VM_ISO_ROOTS.split(",").map((value) => path.resolve(cwd, value.trim())).filter(Boolean)
    : (vm?.iso_roots ?? [paths.isoRoot]).map((value) => path.resolve(cwd, value));
  return {
    enabled: toBoolean(env.CYBEROS_VM_ENABLED, vm?.enabled ?? true),
    libvirtUri: env.CYBEROS_VM_LIBVIRT_URI ?? vm?.libvirt_uri ?? "qemu:///system",
    storagePath: path.resolve(cwd, env.CYBEROS_VM_STORAGE_PATH ?? vm?.storage_path ?? paths.vmRoot),
    networkName: env.CYBEROS_VM_NETWORK_NAME ?? vm?.network_name ?? "default",
    isoRoots,
    operationTimeoutMs: toPositiveInteger(
      env.CYBEROS_VM_OPERATION_TIMEOUT_MS,
      vm?.operation_timeout_ms ?? 120_000
    ),
    consoleMode: "serial"
  };
}

function loadTomlConfig(configPath: string): TomlConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const parsed = parse(readFileSync(configPath, "utf8")) as unknown;
  validateTomlConfig(parsed);
  return parsed;
}

function validateTomlConfig(value: unknown): asserts value is TomlConfig {
  validateTomlObject(value, TOML_SCHEMA, "config");
  const config = value as TomlConfig;
  for (const [index, item] of (config.shares?.items ?? []).entries()) {
    const mediaTypes = item.dlna?.media_types ?? [];
    const invalid = mediaTypes.find((mediaType) => !isDlnaMediaType(mediaType));
    if (invalid) {
      throw new Error(`Invalid TOML value at shares.items[${index}].dlna.media_types: ${invalid}`);
    }
  }
}

function validateTomlObject(value: unknown, schema: TomlSchema, location: string): void {
  if (!isTomlRecord(value)) {
    throw new Error(`Invalid TOML type at ${location}: expected table`);
  }
  for (const [key, entry] of Object.entries(value)) {
    const rule = schema[key];
    const entryLocation = location === "config" ? key : `${location}.${key}`;
    if (!rule) {
      throw new Error(`Unknown TOML key: ${entryLocation}`);
    }
    validateTomlValue(entry, rule, entryLocation);
  }
}

function validateTomlValue(value: unknown, rule: TomlRule, location: string): void {
  if (typeof rule === "string") {
    const valid = rule === "string[]"
      ? Array.isArray(value) && value.every((entry) => typeof entry === "string")
      : typeof value === rule;
    if (!valid) {
      throw new Error(`Invalid TOML type at ${location}: expected ${rule}`);
    }
    return;
  }
  if (Object.hasOwn(rule, "enum")) {
    const values = (rule as { enum: readonly (string | number | boolean)[] }).enum;
    if (!(values as readonly unknown[]).includes(value)) {
      throw new Error(`Invalid TOML value at ${location}: expected ${values.join(", ")}`);
    }
    return;
  }
  if (Object.hasOwn(rule, "array")) {
    const itemSchema = (rule as { array: TomlSchema }).array;
    if (!Array.isArray(value)) {
      throw new Error(`Invalid TOML type at ${location}: expected array of tables`);
    }
    value.forEach((entry, index) => validateTomlObject(entry, itemSchema, `${location}[${index}]`));
    return;
  }
  validateTomlObject(value, rule as TomlSchema, location);
}

function isTomlRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadEnvironment(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): "development" | "production" {
  const value = (env.CYBEROS_ENVIRONMENT ?? fileConfig.environment ?? "development").trim().toLowerCase();
  if (value === "development" || value === "production") return value;
  throw new Error("CYBEROS_ENVIRONMENT must be development or production");
}

function loadBackupConfig(
  env: NodeJS.ProcessEnv,
  fileConfig: TomlConfig,
  cwd: string,
  dataDir: string,
  environment: "development" | "production"
): NonNullable<CyberOsConfig["backup"]> {
  const source = fileConfig.backup;
  const repositoryRaw = normalizeText(env.CYBEROS_BACKUP_REPOSITORY ?? source?.repository);
  const passwordFileRaw = normalizeText(env.CYBEROS_BACKUP_PASSWORD_FILE ?? source?.password_file);
  const stagingRaw = normalizeText(env.CYBEROS_BACKUP_STAGING_PATH ?? source?.staging_path);
  const enabled = toBoolean(env.CYBEROS_BACKUP_ENABLED, source?.enabled ?? Boolean(repositoryRaw));
  const result = {
    enabled,
    repositoryPath: repositoryRaw ? path.resolve(cwd, repositoryRaw) : null,
    passwordFile: passwordFileRaw ? path.resolve(cwd, passwordFileRaw) : null,
    stagingPath: stagingRaw ? path.resolve(cwd, stagingRaw) : path.join(dataDir, "backup-staging"),
    requireMount: environment === "production"
      || toBoolean(env.CYBEROS_BACKUP_REQUIRE_MOUNT, source?.require_mount ?? false),
    retryCount: toPositiveInteger(env.CYBEROS_BACKUP_RETRY_COUNT, source?.retry_count ?? 2),
    timeoutMs: toPositiveInteger(env.CYBEROS_BACKUP_TIMEOUT_MS, source?.timeout_ms ?? 300_000),
    keepDaily: toPositiveInteger(env.CYBEROS_BACKUP_KEEP_DAILY, source?.keep_daily ?? 7),
    keepWeekly: toPositiveInteger(env.CYBEROS_BACKUP_KEEP_WEEKLY, source?.keep_weekly ?? 4)
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

function loadHealthConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): NonNullable<CyberOsConfig["health"]> {
  const source = fileConfig.health;
  return {
    staleIndexWarningMs: toPositiveInteger(env.CYBEROS_HEALTH_STALE_INDEX_WARNING_MS, source?.stale_index_warning_ms ?? 2 * 60 * 60 * 1000),
    staleIndexCriticalMs: toPositiveInteger(env.CYBEROS_HEALTH_STALE_INDEX_CRITICAL_MS, source?.stale_index_critical_ms ?? 6 * 60 * 60 * 1000),
    stalledRunMs: toPositiveInteger(env.CYBEROS_HEALTH_STALLED_RUN_MS, source?.stalled_run_ms ?? 15 * 60 * 1000),
    consecutiveFailureThreshold: toPositiveInteger(env.CYBEROS_HEALTH_CONSECUTIVE_FAILURE_THRESHOLD, source?.consecutive_failure_threshold ?? 2),
    backupStaleMs: toPositiveInteger(env.CYBEROS_HEALTH_BACKUP_STALE_MS, source?.backup_stale_ms ?? 26 * 60 * 60 * 1000)
  };
}

function validateConfig(input: {
  environment: "development" | "production";
  apiHost: string;
  configPath: string;
  paths: CyberOsPaths;
  backup: NonNullable<CyberOsConfig["backup"]>;
  vm: VmConfig;
  vodPlayer: VodPlayerConfig;
}): void {
  if (!isLoopbackHost(input.apiHost)) {
    throw new Error("CyberOS API must bind to a loopback host");
  }
  if (input.environment === "production" && input.paths.rootDir !== "/cyberos") {
    throw new Error(`Production CyberOS root must be /cyberos: ${input.paths.rootDir}`);
  }
  if (input.environment === "production" && path.resolve(input.configPath) !== path.join(input.paths.configDir, "config.toml")) {
    throw new Error(`Production CyberOS config must be ${path.join(input.paths.configDir, "config.toml")}`);
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
  if (!backup.repositoryPath || path.resolve(backup.repositoryPath) !== input.paths.backupRoot) {
    throw new Error(`Production backup repository must be ${input.paths.backupRoot}`);
  }
  if (isUnder(backup.repositoryPath, input.paths.stateDir) || isUnder(input.paths.stateDir, backup.repositoryPath)) {
    throw new Error("Backup repository must not overlap the state directory");
  }
  if (isUnder(backup.repositoryPath, input.paths.dataRoot) || isUnder(input.paths.dataRoot, backup.repositoryPath)) {
    throw new Error("Backup repository must not overlap the storage pool namespace");
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
  const configured = normalizeText(env.CYBEROS_ROOT) ?? normalizeText(fileConfig.root_dir);
  const root = configured
    ? path.resolve(workspaceRoot, configured)
    : environment === "production"
      ? "/cyberos"
      : path.resolve(workspaceRoot, ".cyberos", "dev-root");
  if (environment === "production" && root !== "/cyberos") {
    throw new Error(`Production CyberOS root must be /cyberos: ${root}`);
  }
  if (root === path.parse(root).root) {
    throw new Error(`CyberOS root cannot be the filesystem root: ${root}`);
  }
  return root;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function loadDockerConsoleShells(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): string[] {
  const rawShells = env.CYBEROS_DOCKER_CONSOLE_SHELLS !== undefined
    ? env.CYBEROS_DOCKER_CONSOLE_SHELLS.split(",")
    : fileConfig.docker?.console_shells;
  if (rawShells === undefined) {
    return ["/bin/sh", "/bin/bash"];
  }
  const shells = rawShells.map((shell) => normalizeText(shell));
  if (shells.length === 0 || shells.some((shell) => shell === null || !path.isAbsolute(shell))) {
    throw new Error("Docker console_shells must contain absolute paths");
  }
  return shells as string[];
}

function loadShareConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): ShareConfig {
  const shares = fileConfig.shares;
  return {
    enabled: toBoolean(env.CYBEROS_SHARES_ENABLED, shares?.enabled ?? false),
    account: {
      username:
        normalizeText(env.CYBEROS_SHARE_ACCOUNT_USERNAME) ??
        normalizeText(shares?.account_username) ??
        "cyberos-share",
      password: null
    },
    shares: (shares?.items ?? []).map(normalizeShareItem)
  };
}

function loadTerminalConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): TerminalConfig {
  const socketPath =
    normalizeText(env.CYBEROS_TERMINALD_SOCKET_PATH) ??
    normalizeText(fileConfig.terminal?.socket_path) ??
    "/run/cyberos/terminald.sock";
  if (!path.isAbsolute(socketPath)) {
    throw new Error("Terminal socket_path must be absolute");
  }
  return {
    user: normalizeText(env.CYBEROS_TERMINALD_USER) ?? normalizeText(fileConfig.terminal?.user) ?? "cyberos",
    socketPath,
    sessionIdleTimeoutMs: toPositiveInteger(
      env.CYBEROS_TERMINALD_SESSION_IDLE_TIMEOUT_MS,
      fileConfig.terminal?.session_idle_timeout_ms ?? TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS
    ),
    connectTimeoutMs: toPositiveInteger(
      env.CYBEROS_TERMINALD_CONNECT_TIMEOUT_MS,
      fileConfig.terminal?.connect_timeout_ms ?? TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS
    ),
    maxSessions: toPositiveInteger(
      env.CYBEROS_TERMINALD_MAX_SESSIONS,
      fileConfig.terminal?.max_sessions ?? 32
    )
  };
}

function loadVodPlayerConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig, paths: CyberOsPaths): VodPlayerConfig {
  const player = fileConfig.vod_player;
  const videoOutput = env.CYBEROS_VOD_PLAYER_VIDEO_OUTPUT ?? player?.video_output ?? "drm";
  const audioOutput = env.CYBEROS_VOD_PLAYER_AUDIO_OUTPUT ?? player?.audio_output ?? "alsa";
  const hwdec = env.CYBEROS_VOD_PLAYER_HWDEC ?? player?.hwdec ?? "auto-safe";
  const socketPath =
    normalizeText(env.CYBEROS_VOD_PLAYER_SOCKET_PATH) ??
    normalizeText(player?.socket_path) ??
    "/run/cyberos/vod-player.sock";
  const statePath =
    normalizeText(env.CYBEROS_VOD_PLAYER_STATE_PATH) ??
    normalizeText(player?.state_path) ??
    path.join(paths.vodPlayerStateDir, "session.json");
  const playerUser = normalizeText(env.CYBEROS_VOD_PLAYER_USER) ?? normalizeText(player?.user) ?? "cyberos";
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(statePath)) {
    throw new Error("VOD Player socket_path and state_path must be absolute");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(playerUser) || playerUser === "root") {
    throw new Error("VOD Player user must name a non-root local account");
  }
  if (!(["drm", "wayland"] as const).includes(videoOutput as "drm" | "wayland") || audioOutput !== "alsa" || !["auto-safe", "auto", "no"].includes(hwdec)) {
    throw new Error("VOD Player output configuration is invalid");
  }
  const retryBaseDelayMs = strictPositiveInteger(
    env.CYBEROS_VOD_PLAYER_RETRY_BASE_DELAY_MS ?? player?.retry_base_delay_ms,
    2_000,
    "retry_base_delay_ms"
  );
  const retryMaxDelayMs = strictPositiveInteger(
    env.CYBEROS_VOD_PLAYER_RETRY_MAX_DELAY_MS ?? player?.retry_max_delay_ms,
    60_000,
    "retry_max_delay_ms"
  );
  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new Error("VOD Player retry_max_delay_ms must be at least retry_base_delay_ms");
  }
  return {
    enabled: strictBoolean(
      env.CYBEROS_VOD_PLAYER_ENABLED ?? player?.enabled,
      false,
      "enabled"
    ),
    socketPath,
    statePath,
    commandTimeoutMs: strictPositiveInteger(
      env.CYBEROS_VOD_PLAYER_COMMAND_TIMEOUT_MS ?? player?.command_timeout_ms,
      5_000,
      "command_timeout_ms"
    ),
    startupTimeoutMs: strictPositiveInteger(
      env.CYBEROS_VOD_PLAYER_STARTUP_TIMEOUT_MS ?? player?.startup_timeout_ms,
      15_000,
      "startup_timeout_ms"
    ),
    checkpointIntervalMs: strictPositiveInteger(
      env.CYBEROS_VOD_PLAYER_CHECKPOINT_INTERVAL_MS ?? player?.checkpoint_interval_ms,
      5_000,
      "checkpoint_interval_ms"
    ),
    retryBaseDelayMs,
    retryMaxDelayMs,
    videoOutput: videoOutput as VodPlayerConfig["videoOutput"],
    drmConnector:
      normalizeText(env.CYBEROS_VOD_PLAYER_DRM_CONNECTOR) ??
      normalizeText(player?.drm_connector) ??
      null,
    audioOutput: "alsa",
    audioDevice:
      normalizeText(env.CYBEROS_VOD_PLAYER_AUDIO_DEVICE) ??
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

function normalizeShareItem(item: NonNullable<NonNullable<TomlConfig["shares"]>["items"]>[number], index: number): ShareDefinitionConfig {
  const storagePoolId = normalizeText(item.storage_pool_id);
  const sharePath = normalizeText(item.path);
  if (!storagePoolId || !sharePath) {
    throw new Error(`shares.items[${index}] requires non-empty storage_pool_id and path`);
  }
  const id = normalizeText(item.id) ?? `share-${index + 1}`;
  const name = normalizeText(item.name) ?? id;
  return {
    id,
    name,
    storagePoolId,
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

function toPort(value: string | undefined, fallback: number): number {
  return toPositiveInteger(value, fallback);
}

function loadAllowedOrigins(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): string[] {
  if (env.CYBEROS_ALLOWED_ORIGINS) {
    return env.CYBEROS_ALLOWED_ORIGINS.split(",")
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
      throw new Error(`Invalid boolean value: ${value}`);
  }
}

function toPositiveInteger(value: string | number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer: ${value}`);
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
