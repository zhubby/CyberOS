import { accessSync, existsSync, readFileSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import {
  TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS,
  TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS
} from "./termux-protocol.js";
import { PHOTOSTAFF_BASE_MAP_RELEASE_URL } from "./photostaff-config.js";
import type {
  DlnaMediaType,
  NasRootConfig,
  ShareConfig,
  ShareDefinitionConfig,
  ShareProtocolConfig,
  VodPlayerConfig,
  SigmaConfig,
  TerminalConfig,
  VmConfig
} from "./types.js";

const MANAGED_DOCKER_APPS_PATH = "/srv/apps";

interface TomlConfig {
  environment?: "development" | "production";
  data_dir?: string;
  api?: {
    host?: string;
    port?: number;
    allowed_origins?: string[];
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): SigmaConfig {
  const configPath = env.SIGMAOS_CONFIG ?? "/etc/sigmaos/config.toml";
  const fileConfig = loadTomlConfig(configPath);
  const workspaceRoot = findWorkspaceRoot(cwd);
  const dataDir = path.resolve(
    workspaceRoot,
    env.SIGMAOS_DATA_DIR ?? fileConfig.data_dir ?? ".sigmaos"
  );
  const environment = loadEnvironment(env, fileConfig);
  const nasRoots = loadNasRoots(env, fileConfig, workspaceRoot, environment);
  const backup = loadBackupConfig(env, fileConfig, workspaceRoot, dataDir, environment);
  const health = loadHealthConfig(env, fileConfig);
  const apiHost = env.SIGMAOS_API_HOST ?? fileConfig.api?.host ?? "127.0.0.1";
  validateConfig({ environment, apiHost, dataDir, nasRoots, backup });

  return {
    environment,
    dataDir,
    databasePath: env.SIGMAOS_DATABASE_PATH ?? path.join(dataDir, "sigmaos.sqlite"),
    api: {
      host: apiHost,
      port: toPort(env.SIGMAOS_API_PORT, fileConfig.api?.port ?? 3010),
      allowedOrigins: loadAllowedOrigins(env, fileConfig)
    },
    worker: {
      pollMs: toPositiveInteger(env.SIGMAOS_WORKER_POLL_MS, fileConfig.worker?.poll_ms ?? 750)
    },
    admin: {
      displayName: env.SIGMAOS_ADMIN_DISPLAY_NAME ?? fileConfig.admin?.display_name ?? "SigmaOS Admin",
      authMode: "local-only"
    },
    model: {
      provider: loadModelProvider(env.SIGMAOS_MODEL_PROVIDER, fileConfig.model?.provider),
      piCommand: env.SIGMAOS_PI_COMMAND ?? fileConfig.model?.pi_command ?? "pi",
      localEndpoint: env.SIGMAOS_LOCAL_ENDPOINT ?? fileConfig.model?.local_endpoint ?? null
    },
    docker: {
      enabled: toBoolean(env.SIGMAOS_DOCKER_ENABLED, fileConfig.docker?.enabled ?? false),
      socketPath:
        env.SIGMAOS_DOCKER_SOCKET_PATH ?? fileConfig.docker?.socket_path ?? "/var/run/docker.sock",
      composeCommand:
        normalizeText(env.SIGMAOS_DOCKER_COMPOSE_COMMAND) ??
        normalizeText(fileConfig.docker?.compose_command) ??
        "docker",
      operationTimeoutMs: toPositiveInteger(
        env.SIGMAOS_DOCKER_OPERATION_TIMEOUT_MS,
        fileConfig.docker?.operation_timeout_ms ?? 120_000
      ),
      consoleShells: loadDockerConsoleShells(env, fileConfig)
    },
    vm: loadVmConfig(env, fileConfig, workspaceRoot),
    hostd: loadHostdConfig(env, fileConfig),
    shares: loadShareConfig(env, fileConfig),
    terminal: loadTerminalConfig(env, fileConfig),
    vodPlayer: loadVodPlayerConfig(env, fileConfig),
    photostaff: {
      baseMapUrl: loadPhotostaffBaseMapUrl(env, fileConfig)
    },
    nasRoots,
    backup,
    health
  };
}

function loadPhotostaffBaseMapUrl(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): string {
  const value = normalizeText(env.SIGMAOS_PHOTOSTAFF_BASEMAP_URL) ??
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

function loadHostdConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): SigmaConfig["hostd"] {
  const socketPath =
    normalizeText(env.SIGMAOS_HOSTD_SOCKET_PATH) ??
    normalizeText(fileConfig.hostd?.socket_path) ??
    "/run/sigmaos/hostd.sock";
  return {
    socketPath: path.isAbsolute(socketPath) ? socketPath : "/run/sigmaos/hostd.sock"
  };
}

function loadVmConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig, cwd: string): VmConfig {
  const vm = fileConfig.vm;
  const isoRoots = env.SIGMAOS_VM_ISO_ROOTS
    ? env.SIGMAOS_VM_ISO_ROOTS.split(",").map((value) => path.resolve(cwd, value.trim())).filter(Boolean)
    : (vm?.iso_roots ?? []).map((value) => path.resolve(cwd, value));
  return {
    enabled: toBoolean(env.SIGMAOS_VM_ENABLED, vm?.enabled ?? true),
    libvirtUri: env.SIGMAOS_VM_LIBVIRT_URI ?? vm?.libvirt_uri ?? "qemu:///system",
    storagePath: path.resolve(cwd, env.SIGMAOS_VM_STORAGE_PATH ?? vm?.storage_path ?? ".sigmaos/vmstore"),
    networkName: env.SIGMAOS_VM_NETWORK_NAME ?? vm?.network_name ?? "default",
    isoRoots,
    operationTimeoutMs: toPositiveInteger(
      env.SIGMAOS_VM_OPERATION_TIMEOUT_MS,
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
  environment: "development" | "production"
): NasRootConfig[] {
  if (env.SIGMAOS_NAS_ROOTS) {
    return env.SIGMAOS_NAS_ROOTS.split(",")
      .map((entry, index) => parseNasRootEnv(entry.trim(), index, cwd))
      .filter((root): root is NasRootConfig => root !== null)
      .map((root) => ({ ...root, mountPolicy: root.mountPolicy ?? (environment === "production" ? "required" : "optional"), expectedSource: root.expectedSource ?? null, expectedUuid: root.expectedUuid ?? null, expectedFstype: root.expectedFstype ?? null }));
  }

  if (fileConfig.nas_roots?.length) {
    return fileConfig.nas_roots.map((root, index) => ({
      id: root.id ?? `root-${index + 1}`,
      name: root.name ?? root.id ?? `Root ${index + 1}`,
      path: path.resolve(cwd, root.path ?? cwd),
      mountPolicy: root.mount_policy ?? (environment === "production" ? "required" : "optional"),
      expectedSource: normalizeText(root.expected_source),
      expectedUuid: normalizeText(root.expected_uuid),
      expectedFstype: normalizeText(root.expected_fstype)
    }));
  }

  const fallback = { id: "local", name: "System root", path: systemRootPath(cwd) };
  return environment === "production"
    ? [{ ...fallback, mountPolicy: "required", expectedSource: null, expectedUuid: null, expectedFstype: null }]
    : [fallback];
}

function loadEnvironment(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): "development" | "production" {
  const value = (env.SIGMAOS_ENVIRONMENT ?? fileConfig.environment ?? "development").trim().toLowerCase();
  return value === "production" ? "production" : "development";
}

function loadBackupConfig(
  env: NodeJS.ProcessEnv,
  fileConfig: TomlConfig,
  cwd: string,
  dataDir: string,
  environment: "development" | "production"
): NonNullable<SigmaConfig["backup"]> {
  const source = fileConfig.backup;
  const repositoryRaw = normalizeText(env.SIGMAOS_BACKUP_REPOSITORY ?? env.SIGMAOS_BACKUP_REPOSITORY_PATH ?? source?.repository_path ?? source?.repository);
  const passwordFileRaw = normalizeText(env.SIGMAOS_BACKUP_PASSWORD_FILE ?? source?.password_file);
  const stagingRaw = normalizeText(env.SIGMAOS_BACKUP_STAGING_PATH ?? source?.staging_path);
  const enabled = toBoolean(env.SIGMAOS_BACKUP_ENABLED, source?.enabled ?? Boolean(repositoryRaw));
  const result = {
    enabled,
    repositoryPath: repositoryRaw ? path.resolve(cwd, repositoryRaw) : null,
    passwordFile: passwordFileRaw ? path.resolve(cwd, passwordFileRaw) : null,
    stagingPath: stagingRaw ? path.resolve(cwd, stagingRaw) : path.join(dataDir, "backup-staging"),
    requireMount: toBoolean(env.SIGMAOS_BACKUP_REQUIRE_MOUNT, source?.require_mount ?? environment === "production"),
    retryCount: toPositiveInteger(env.SIGMAOS_BACKUP_RETRY_COUNT, source?.retry_count ?? 2),
    timeoutMs: toPositiveInteger(env.SIGMAOS_BACKUP_TIMEOUT_MS, source?.timeout_ms ?? 300_000),
    keepDaily: toPositiveInteger(env.SIGMAOS_BACKUP_KEEP_DAILY, source?.keep_daily ?? 7),
    keepWeekly: toPositiveInteger(env.SIGMAOS_BACKUP_KEEP_WEEKLY, source?.keep_weekly ?? 4)
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

function loadHealthConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): NonNullable<SigmaConfig["health"]> {
  const source = fileConfig.health;
  return {
    staleIndexWarningMs: toPositiveInteger(env.SIGMAOS_HEALTH_STALE_INDEX_WARNING_MS, source?.stale_index_warning_ms ?? 2 * 60 * 60 * 1000),
    staleIndexCriticalMs: toPositiveInteger(env.SIGMAOS_HEALTH_STALE_INDEX_CRITICAL_MS, source?.stale_index_critical_ms ?? 6 * 60 * 60 * 1000),
    stalledRunMs: toPositiveInteger(env.SIGMAOS_HEALTH_STALLED_RUN_MS, source?.stalled_run_ms ?? 15 * 60 * 1000),
    consecutiveFailureThreshold: toPositiveInteger(env.SIGMAOS_HEALTH_CONSECUTIVE_FAILURE_THRESHOLD, source?.consecutive_failure_threshold ?? 2),
    backupStaleMs: toPositiveInteger(env.SIGMAOS_HEALTH_BACKUP_STALE_MS, source?.backup_stale_ms ?? 26 * 60 * 60 * 1000)
  };
}

function validateConfig(input: {
  environment: "development" | "production";
  apiHost: string;
  dataDir: string;
  nasRoots: NasRootConfig[];
  backup: NonNullable<SigmaConfig["backup"]>;
}): void {
  if (!isLoopbackHost(input.apiHost)) {
    throw new Error("SigmaOS API must bind to a loopback host");
  }
  if (input.environment !== "production") return;
  for (const root of input.nasRoots) {
    if (isUnder(root.path, MANAGED_DOCKER_APPS_PATH) || isUnder(MANAGED_DOCKER_APPS_PATH, root.path)) {
      throw new Error(`Production NAS roots must not overlap ${MANAGED_DOCKER_APPS_PATH}`);
    }
    if (root.mountPolicy === "required" && !isUnder(root.path, "/srv")) {
      throw new Error(`Production NAS root must be under /srv: ${root.path}`);
    }
  }
  const backup = input.backup;
  if (!backup.enabled) return;
  if (!backup.repositoryPath || !isUnder(path.resolve("/srv"), backup.repositoryPath)) {
    throw new Error("Production backup repository must be configured under /srv");
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
}

function isUnder(candidate: string, parent: string): boolean {
  const child = path.resolve(candidate);
  const base = path.resolve(parent);
  return child === base || child.startsWith(`${base}${path.sep}`);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function loadDockerConsoleShells(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): string[] {
  const rawShells = env.SIGMAOS_DOCKER_CONSOLE_SHELLS
    ? env.SIGMAOS_DOCKER_CONSOLE_SHELLS.split(",")
    : fileConfig.docker?.console_shells;
  const shells = (rawShells ?? [])
    .map((shell) => normalizeText(shell))
    .filter((shell): shell is string => shell !== null && path.isAbsolute(shell));
  return shells.length ? shells : ["/bin/sh", "/bin/bash"];
}

function loadShareConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): ShareConfig {
  const shares = fileConfig.shares;
  return {
    enabled: toBoolean(env.SIGMAOS_SHARES_ENABLED, shares?.enabled ?? false),
    account: {
      username:
        normalizeText(env.SIGMAOS_SHARE_ACCOUNT_USERNAME) ??
        normalizeText(shares?.account_username) ??
        "sigma-share",
      password: null
    },
    shares: (shares?.items ?? []).map(normalizeShareItem).filter((item): item is ShareDefinitionConfig => item !== null)
  };
}

function loadTerminalConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): TerminalConfig {
  return {
    user: normalizeText(env.SIGMAOS_TERMUX_USER) ?? normalizeText(fileConfig.terminal?.user),
    termuxSocketPath:
      normalizeText(env.SIGMAOS_TERMUX_SOCKET_PATH) ??
      normalizeText(fileConfig.terminal?.termux_socket_path) ??
      "/run/sigmaos/termux.sock",
    sessionIdleTimeoutMs: toPositiveInteger(
      env.SIGMAOS_TERMUX_SESSION_IDLE_TIMEOUT_MS,
      fileConfig.terminal?.session_idle_timeout_ms ?? TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS
    ),
    connectTimeoutMs: toPositiveInteger(
      env.SIGMAOS_TERMUX_CONNECT_TIMEOUT_MS,
      fileConfig.terminal?.connect_timeout_ms ?? TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS
    ),
    maxSessions: toPositiveInteger(
      env.SIGMAOS_TERMUX_MAX_SESSIONS,
      fileConfig.terminal?.max_sessions ?? 32
    )
  };
}

function loadVodPlayerConfig(env: NodeJS.ProcessEnv, fileConfig: TomlConfig): VodPlayerConfig {
  const legacyEnvironment = Object.keys(env).find((name) => name.startsWith("SIGMAOS_PLAYER_") || name === "SIGMAOS_ENABLE_PLAYER");
  if (legacyEnvironment) {
    throw new Error(`${legacyEnvironment} is no longer supported; use SIGMAOS_VOD_PLAYER_*`);
  }
  const player = fileConfig.vod_player;
  const videoOutput = env.SIGMAOS_VOD_PLAYER_VIDEO_OUTPUT ?? player?.video_output ?? "drm";
  const audioOutput = env.SIGMAOS_VOD_PLAYER_AUDIO_OUTPUT ?? player?.audio_output ?? "alsa";
  const hwdec = env.SIGMAOS_VOD_PLAYER_HWDEC ?? player?.hwdec ?? "auto-safe";
  const socketPath =
    normalizeText(env.SIGMAOS_VOD_PLAYER_SOCKET_PATH) ??
    normalizeText(player?.socket_path) ??
    "/run/sigmaos/vod-player.sock";
  const statePath =
    normalizeText(env.SIGMAOS_VOD_PLAYER_STATE_PATH) ??
    normalizeText(player?.state_path) ??
    "/var/lib/sigmaos-vod-player/session.json";
  const playerUser = normalizeText(env.SIGMAOS_VOD_PLAYER_USER) ?? normalizeText(player?.user) ?? "sigmaos";
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(statePath)) {
    throw new Error("VOD Player socket_path and state_path must be absolute");
  }
  if (isPrivateTemporaryPath(socketPath) || isPrivateTemporaryPath(statePath)) {
    throw new Error("VOD Player socket_path and state_path cannot use /tmp or /var/tmp");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(playerUser) || playerUser === "root") {
    throw new Error("VOD Player user must name a non-root local account");
  }
  if (videoOutput !== "drm" || audioOutput !== "alsa" || !["auto-safe", "auto", "no"].includes(hwdec)) {
    throw new Error("VOD Player output configuration is invalid");
  }
  const retryBaseDelayMs = strictPositiveInteger(
    env.SIGMAOS_VOD_PLAYER_RETRY_BASE_DELAY_MS ?? player?.retry_base_delay_ms,
    2_000,
    "retry_base_delay_ms"
  );
  const retryMaxDelayMs = strictPositiveInteger(
    env.SIGMAOS_VOD_PLAYER_RETRY_MAX_DELAY_MS ?? player?.retry_max_delay_ms,
    60_000,
    "retry_max_delay_ms"
  );
  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new Error("VOD Player retry_max_delay_ms must be at least retry_base_delay_ms");
  }
  return {
    enabled: strictBoolean(
      env.SIGMAOS_VOD_PLAYER_ENABLED ?? player?.enabled,
      false,
      "enabled"
    ),
    socketPath,
    statePath,
    commandTimeoutMs: strictPositiveInteger(
      env.SIGMAOS_VOD_PLAYER_COMMAND_TIMEOUT_MS ?? player?.command_timeout_ms,
      5_000,
      "command_timeout_ms"
    ),
    startupTimeoutMs: strictPositiveInteger(
      env.SIGMAOS_VOD_PLAYER_STARTUP_TIMEOUT_MS ?? player?.startup_timeout_ms,
      15_000,
      "startup_timeout_ms"
    ),
    checkpointIntervalMs: strictPositiveInteger(
      env.SIGMAOS_VOD_PLAYER_CHECKPOINT_INTERVAL_MS ?? player?.checkpoint_interval_ms,
      5_000,
      "checkpoint_interval_ms"
    ),
    retryBaseDelayMs,
    retryMaxDelayMs,
    videoOutput: "drm",
    drmConnector:
      normalizeText(env.SIGMAOS_VOD_PLAYER_DRM_CONNECTOR) ??
      normalizeText(player?.drm_connector) ??
      null,
    audioOutput: "alsa",
    audioDevice:
      normalizeText(env.SIGMAOS_VOD_PLAYER_AUDIO_DEVICE) ??
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

function systemRootPath(cwd: string): string {
  return path.parse(path.resolve(cwd)).root || path.sep;
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
  if (env.SIGMAOS_ALLOWED_ORIGINS) {
    return env.SIGMAOS_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  return fileConfig.api?.allowed_origins ?? [];
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
