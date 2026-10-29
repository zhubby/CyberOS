import path from "node:path";
import type {
  AgentCapabilityPolicySettingsRecord,
  AgentMcpSettingsRecord,
  BluetoothSettingsRecord,
  BackupSettingsRecord,
  DownloadSettingsRecord,
  DockerSettingsRecord,
  IndexerSettingsRecord,
  MonitoringSettingsRecord,
  ModelProviderSettingsRecord,
  PhotosProcessingSettingsRecord,
  PiToolPolicySettingsRecord,
  ShareSettingsRecord,
  SystemProfileSettingsRecord,
  TvSettingsRecord,
  VmSettingsRecord
} from "@cyberos/shared";
import {
  PHOTOS_DEFAULT_COMMAND_TIMEOUT_MS,
  PHOTOS_DEFAULT_MAX_AUTO_RETRIES,
  PHOTOS_DEFAULT_MAX_DECODED_PIXELS,
  PHOTOS_DEFAULT_MAX_INTERMEDIATE_BYTES,
  PHOTOS_DEFAULT_MIN_FREE_SPACE_BYTES,
  PHOTOS_DEFAULT_PROCESSING_CONCURRENCY,
  PHOTOS_DEFAULT_RETRY_BASE_DELAY_MS,
  PHOTOS_DEFAULT_RETRY_MAX_DELAY_MS,
  PHOTOS_DEFAULT_SCAN_INTERVAL_MS,
  PHOTOS_MAX_FILE_SIZE_BYTES,
  PHOTOS_XMP_MAX_FILE_SIZE_BYTES
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import {
  mapDockerSettings,
  mapAgentCapabilityPolicySettings,
  mapModelProviderSettings,
  mapVmSettings,
  normalizeModelProviderName,
  normalizeAgentCapabilityPolicySettings
} from "./settings-mappers.js";
import { mapShareSettings, normalizeShareSettings } from "./share-settings-mapper.js";
import { DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS } from "./settings-constants.js";
import type { DbSystemSettingRow } from "./repository-rows.js";

const MODEL_PROVIDER_SETTING_KEY = "model_provider";
const AGENT_CAPABILITY_POLICY_SETTING_KEY = "agent_capability_policy";
const AGENT_MCP_SETTING_KEY = "agent_mcp";
const DOCKER_SETTING_KEY = "docker_settings";
const VM_SETTING_KEY = "vm_settings";
const SHARE_SETTING_KEY = "share_settings";
const DOWNLOAD_SETTING_KEY = "download_settings";
const PHOTOS_PROCESSING_SETTING_KEY = "photos_processing_settings";
const INDEXER_SETTING_KEY = "indexer_settings";
const BLUETOOTH_SETTING_KEY = "bluetooth_settings";
const SYSTEM_PROFILE_SETTING_KEY = "system_profile_settings";
const MONITORING_SETTING_KEY = "monitoring_settings";
const BACKUP_SETTING_KEY = "backup_settings";
const TV_SETTING_KEY = "tv_settings";

const EPOCH = new Date(0).toISOString();

export const DEFAULT_SYSTEM_PROFILE_SETTINGS: Omit<SystemProfileSettingsRecord, "updatedAt"> = {
  adminDisplayName: "CyberOS Admin"
};

export const DEFAULT_MONITORING_SETTINGS: Omit<MonitoringSettingsRecord, "updatedAt"> = {
  enabled: true,
  rawRetentionDays: 2,
  minuteRetentionDays: 30,
  hourRetentionDays: 365,
  maxDatabaseBytes: 512 * 1024 * 1024
};

export const DEFAULT_BACKUP_SETTINGS: Omit<BackupSettingsRecord, "updatedAt"> = {
  enabled: false,
  repositoryPath: "/cyberos/backup",
  requireMount: true,
  keepDaily: 7,
  keepWeekly: 4,
  validatedAt: null
};

export const DEFAULT_TV_SETTINGS: Omit<TvSettingsRecord, "updatedAt"> = {
  enabled: true,
  videoOutput: "wayland",
  drmConnector: null,
  audioDevice: null,
  hardwareDecoding: "auto-safe"
};

export const DEFAULT_BLUETOOTH_SETTINGS: Omit<BluetoothSettingsRecord, "updatedAt"> = {
  defaultAdapterId: null,
  defaultAudioDeviceId: null,
  receiveEnabled: false,
  inboxStoragePoolId: null,
  inboxPath: null
};

export const DEFAULT_DOWNLOAD_CONCURRENCY = 1;
export const DEFAULT_DOWNLOAD_SETTINGS: Omit<DownloadSettingsRecord, "updatedAt"> = {
  concurrency: DEFAULT_DOWNLOAD_CONCURRENCY,
  parallelRequestsPerTask: 4,
  segmentedDownloadMinBytes: 64 * 1024 * 1024,
  maxAutoRetries: 5,
  retryBaseDelayMs: 2_000,
  retryMaxDelayMs: 300_000,
  retryAfterMaxDelayMs: 900_000,
  connectTimeoutMs: 15_000,
  responseHeaderTimeoutMs: 30_000,
  readIdleTimeoutMs: 60_000,
  minFreeSpaceBytes: 0,
  maxFileSizeBytes: null
};

export const DEFAULT_PHOTOS_PROCESSING_SETTINGS: Omit<PhotosProcessingSettingsRecord, "updatedAt"> = {
  processingConcurrency: PHOTOS_DEFAULT_PROCESSING_CONCURRENCY,
  scanIntervalMs: PHOTOS_DEFAULT_SCAN_INTERVAL_MS,
  maxAutoRetries: PHOTOS_DEFAULT_MAX_AUTO_RETRIES,
  retryBaseDelayMs: PHOTOS_DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: PHOTOS_DEFAULT_RETRY_MAX_DELAY_MS,
  commandTimeoutMs: PHOTOS_DEFAULT_COMMAND_TIMEOUT_MS,
  maxFileSizeBytes: PHOTOS_MAX_FILE_SIZE_BYTES,
  maxXmpSizeBytes: PHOTOS_XMP_MAX_FILE_SIZE_BYTES,
  maxIntermediateBytes: PHOTOS_DEFAULT_MAX_INTERMEDIATE_BYTES,
  minFreeSpaceBytes: PHOTOS_DEFAULT_MIN_FREE_SPACE_BYTES,
  maxDecodedPixels: PHOTOS_DEFAULT_MAX_DECODED_PIXELS
};

export const DEFAULT_INDEXER_SETTINGS: Omit<IndexerSettingsRecord, "updatedAt"> = {
  scanConcurrency: 4,
  extractionConcurrency: 2,
  reconciliationIntervalMs: 30 * 60 * 1_000,
  maxExtractedTextBytes: 2 * 1024 * 1024,
  maxSourceDocumentBytes: 512 * 1024 * 1024,
  commandTimeoutMs: 120 * 1_000,
  maxPdfTextPages: 500,
  maxOcrPages: 20,
  ocrStoragePoolIds: []
};

export { DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS } from "./settings-constants.js";

export function defaultBluetoothSettings(): BluetoothSettingsRecord {
  return { ...DEFAULT_BLUETOOTH_SETTINGS, updatedAt: new Date(0).toISOString() };
}

export function getBluetoothSettings(db: CyberOsDatabase): BluetoothSettingsRecord | null {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(BLUETOOTH_SETTING_KEY) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
  if (!row) return null;
  const parsed = currentSettingsObject(JSON.parse(row.value_json), [
    "defaultAdapterId",
    "defaultAudioDeviceId",
    "receiveEnabled",
    "inboxStoragePoolId",
    "inboxPath",
    "updatedAt"
  ], "Bluetooth");
  if (
    !isNullableString(parsed.defaultAdapterId)
    || !isNullableString(parsed.defaultAudioDeviceId)
    || typeof parsed.receiveEnabled !== "boolean"
    || !isNullableString(parsed.inboxStoragePoolId)
    || !isNullableString(parsed.inboxPath)
  ) {
    throw new Error("Bluetooth settings contain invalid field types");
  }
  return normalizeBluetoothSettings(
    parsed as unknown as BluetoothSettingsRecord,
    currentSettingsUpdatedAt(parsed, "Bluetooth")
  );
}

export function saveBluetoothSettings(
  db: CyberOsDatabase,
  settings: Partial<Omit<BluetoothSettingsRecord, "updatedAt">>
): BluetoothSettingsRecord {
  const updatedAt = new Date().toISOString();
  let current: BluetoothSettingsRecord;
  try {
    current = getBluetoothSettings(db) ?? defaultBluetoothSettings();
  } catch {
    current = defaultBluetoothSettings();
  }
  const record = normalizeBluetoothSettings({ ...current, ...settings }, updatedAt);
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(BLUETOOTH_SETTING_KEY, JSON.stringify(record), updatedAt);
  return record;
}

function normalizeBluetoothSettings(
  input: Partial<BluetoothSettingsRecord>,
  updatedAt: string
): BluetoothSettingsRecord {
  const text = (value: unknown, maximum = 4096) => typeof value === "string" && value.trim() && value.length <= maximum
    ? value.trim()
    : null;
  const inboxStoragePoolId = text(input.inboxStoragePoolId, 256);
  const inboxPath = text(input.inboxPath);
  const completeInbox = Boolean(inboxStoragePoolId && inboxPath);
  return {
    defaultAdapterId: text(input.defaultAdapterId, 128),
    defaultAudioDeviceId: text(input.defaultAudioDeviceId, 128),
    receiveEnabled: input.receiveEnabled === true && completeInbox,
    inboxStoragePoolId,
    inboxPath,
    updatedAt
  };
}

export function getModelProviderSettings(db: CyberOsDatabase): ModelProviderSettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(MODEL_PROVIDER_SETTING_KEY) as DbSystemSettingRow | undefined;

  return row ? mapModelProviderSettings(row) : null;
}

export function saveModelProviderSettings(
  db: CyberOsDatabase,
  settings: Omit<ModelProviderSettingsRecord, "generation" | "updatedAt">
): ModelProviderSettingsRecord {
  return db.transaction(() => {
    const updatedAt = new Date().toISOString();
    let previousGeneration = 0;
    try {
      previousGeneration = getModelProviderSettings(db)?.generation ?? 0;
    } catch {
      // A valid PATCH is the repair path for a damaged settings record.
    }
    const generation = previousGeneration + 1;
    const record: ModelProviderSettingsRecord = {
      generation,
      providerName: normalizeModelProviderName(settings.providerName),
      baseUrl: settings.baseUrl?.trim() || null,
      model: settings.model.trim(),
      apiKey: settings.apiKey?.trim() || null,
      updatedAt
    };

    db.prepare(`
      INSERT INTO system_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(MODEL_PROVIDER_SETTING_KEY, JSON.stringify(record), updatedAt);

    return record;
  }).immediate();
}

export function defaultAgentCapabilityPolicySettings(): AgentCapabilityPolicySettingsRecord {
  return {
    policies: { ...DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS.policies },
    updatedAt: new Date(0).toISOString()
  };
}

export function getAgentCapabilityPolicySettings(db: CyberOsDatabase): AgentCapabilityPolicySettingsRecord | null {
  const row = db.prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(AGENT_CAPABILITY_POLICY_SETTING_KEY) as DbSystemSettingRow | undefined;
  return row ? mapAgentCapabilityPolicySettings(row) : null;
}

export function saveAgentCapabilityPolicySettings(
  db: CyberOsDatabase,
  settings: Omit<AgentCapabilityPolicySettingsRecord, "updatedAt">
): AgentCapabilityPolicySettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizeAgentCapabilityPolicySettings(settings, updatedAt);
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(AGENT_CAPABILITY_POLICY_SETTING_KEY, JSON.stringify(record), updatedAt);
  return record;
}

export function getAgentMcpSettings(db: CyberOsDatabase): AgentMcpSettingsRecord | null {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(AGENT_MCP_SETTING_KEY) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
  if (!row) return null;
  const value = JSON.parse(row.value_json) as { enabled?: unknown };
  if (typeof value.enabled !== "boolean") {
    throw new Error("Invalid Agent MCP enabled setting");
  }
  return { enabled: value.enabled, updatedAt: row.updated_at };
}

export function saveAgentMcpSettings(db: CyberOsDatabase, enabled: boolean): AgentMcpSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = { enabled, updatedAt };
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(AGENT_MCP_SETTING_KEY, JSON.stringify(record), updatedAt);
  return record;
}

export function agentCapabilityPolicyToPiToolPolicy(
  settings: AgentCapabilityPolicySettingsRecord
): PiToolPolicySettingsRecord {
  return {
    read: settings.policies["cyberos.files.read"],
    grep: settings.policies["cyberos.files.grep"],
    find: settings.policies["cyberos.files.find"],
    ls: settings.policies["cyberos.files.list"],
    bash: settings.policies["cyberos.shell.run"],
    edit: settings.policies["cyberos.files.edit"],
    write: settings.policies["cyberos.files.write"],
    updatedAt: settings.updatedAt
  };
}

export function getDockerSettings(db: CyberOsDatabase): DockerSettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(DOCKER_SETTING_KEY) as DbSystemSettingRow | undefined;

  return row ? mapDockerSettings(row) : null;
}

export function saveDockerSettings(
  db: CyberOsDatabase,
  settings: Omit<DockerSettingsRecord, "updatedAt">
): DockerSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record: DockerSettingsRecord = {
    enabled: settings.enabled,
    updatedAt
  };

  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(DOCKER_SETTING_KEY, JSON.stringify(record), updatedAt);

  return record;
}

export function getVmSettings(db: CyberOsDatabase): VmSettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(VM_SETTING_KEY) as DbSystemSettingRow | undefined;

  return row ? mapVmSettings(row) : null;
}

export function saveVmSettings(
  db: CyberOsDatabase,
  settings: Omit<VmSettingsRecord, "updatedAt">
): VmSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record: VmSettingsRecord = { enabled: settings.enabled, updatedAt };

  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(VM_SETTING_KEY, JSON.stringify(record), updatedAt);

  return record;
}

export function defaultSystemProfileSettings(): SystemProfileSettingsRecord {
  return { ...DEFAULT_SYSTEM_PROFILE_SETTINGS, updatedAt: EPOCH };
}

export function getSystemProfileSettings(db: CyberOsDatabase): SystemProfileSettingsRecord | null {
  const row = settingRow(db, SYSTEM_PROFILE_SETTING_KEY);
  if (!row) return null;
  const parsed = currentSettingsObject(JSON.parse(row.value_json), ["adminDisplayName", "updatedAt"], "System profile");
  return normalizeSystemProfileSettings(parsed, currentSettingsUpdatedAt(parsed, "System profile"));
}

export function saveSystemProfileSettings(
  db: CyberOsDatabase,
  settings: Omit<SystemProfileSettingsRecord, "updatedAt">
): SystemProfileSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizeSystemProfileSettings(settings, updatedAt);
  saveSetting(db, SYSTEM_PROFILE_SETTING_KEY, record, updatedAt);
  return record;
}

export function defaultMonitoringSettings(): MonitoringSettingsRecord {
  return { ...DEFAULT_MONITORING_SETTINGS, updatedAt: EPOCH };
}

export function getMonitoringSettings(db: CyberOsDatabase): MonitoringSettingsRecord | null {
  const row = settingRow(db, MONITORING_SETTING_KEY);
  if (!row) return null;
  const parsed = currentSettingsObject(JSON.parse(row.value_json), [
    "enabled",
    "rawRetentionDays",
    "minuteRetentionDays",
    "hourRetentionDays",
    "maxDatabaseBytes",
    "updatedAt"
  ], "Monitoring");
  return normalizeMonitoringSettings(parsed, currentSettingsUpdatedAt(parsed, "Monitoring"));
}

export function saveMonitoringSettings(
  db: CyberOsDatabase,
  settings: Omit<MonitoringSettingsRecord, "updatedAt">
): MonitoringSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizeMonitoringSettings(settings, updatedAt);
  saveSetting(db, MONITORING_SETTING_KEY, record, updatedAt);
  return record;
}

export function defaultBackupSettings(
  repositoryPath = DEFAULT_BACKUP_SETTINGS.repositoryPath,
  requireMount = DEFAULT_BACKUP_SETTINGS.requireMount
): BackupSettingsRecord {
  return { ...DEFAULT_BACKUP_SETTINGS, repositoryPath, requireMount, updatedAt: EPOCH };
}

export function getBackupSettings(db: CyberOsDatabase): BackupSettingsRecord | null {
  const row = settingRow(db, BACKUP_SETTING_KEY);
  if (!row) return null;
  const parsed = currentSettingsObject(JSON.parse(row.value_json), [
    "enabled",
    "repositoryPath",
    "requireMount",
    "keepDaily",
    "keepWeekly",
    "validatedAt",
    "updatedAt"
  ], "Backup");
  return normalizeBackupSettings(parsed, currentSettingsUpdatedAt(parsed, "Backup"));
}

export function saveBackupSettings(
  db: CyberOsDatabase,
  settings: Omit<BackupSettingsRecord, "updatedAt">
): BackupSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizeBackupSettings(settings, updatedAt);
  saveSetting(db, BACKUP_SETTING_KEY, record, updatedAt);
  return record;
}

export function defaultTvSettings(): TvSettingsRecord {
  return { ...DEFAULT_TV_SETTINGS, updatedAt: EPOCH };
}

export function getTvSettings(db: CyberOsDatabase): TvSettingsRecord | null {
  const row = settingRow(db, TV_SETTING_KEY);
  if (!row) return null;
  const parsed = currentSettingsObject(JSON.parse(row.value_json), [
    "enabled",
    "videoOutput",
    "drmConnector",
    "audioDevice",
    "hardwareDecoding",
    "updatedAt"
  ], "TV");
  return normalizeTvSettings(parsed, currentSettingsUpdatedAt(parsed, "TV"));
}

export function saveTvSettings(
  db: CyberOsDatabase,
  settings: Omit<TvSettingsRecord, "updatedAt">
): TvSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizeTvSettings(settings, updatedAt);
  saveSetting(db, TV_SETTING_KEY, record, updatedAt);
  return record;
}

export function validateTvSettings(
  settings: Omit<TvSettingsRecord, "updatedAt">
): Omit<TvSettingsRecord, "updatedAt"> {
  const validated = normalizeTvSettings(settings, EPOCH);
  return {
    enabled: validated.enabled,
    videoOutput: validated.videoOutput,
    drmConnector: validated.drmConnector,
    audioDevice: validated.audioDevice,
    hardwareDecoding: validated.hardwareDecoding
  };
}

export function getShareSettings(db: CyberOsDatabase): ShareSettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(SHARE_SETTING_KEY) as DbSystemSettingRow | undefined;

  return row ? mapShareSettings(row) : null;
}

export function saveShareSettings(
  db: CyberOsDatabase,
  settings: Omit<ShareSettingsRecord, "updatedAt">
): ShareSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizeShareSettings(settings, updatedAt);

  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(SHARE_SETTING_KEY, JSON.stringify(record), updatedAt);

  return record;
}

export function getDownloadSettings(db: CyberOsDatabase): DownloadSettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(DOWNLOAD_SETTING_KEY) as DbSystemSettingRow | undefined;
  if (!row) {
    return null;
  }
  const parsed = currentSettingsObject(JSON.parse(row.value_json), [
    "concurrency",
    "parallelRequestsPerTask",
    "segmentedDownloadMinBytes",
    "maxAutoRetries",
    "retryBaseDelayMs",
    "retryMaxDelayMs",
    "retryAfterMaxDelayMs",
    "connectTimeoutMs",
    "responseHeaderTimeoutMs",
    "readIdleTimeoutMs",
    "minFreeSpaceBytes",
    "maxFileSizeBytes",
    "updatedAt"
  ], "Download");
  return normalizeDownloadSettings(
    parsed as unknown as Omit<DownloadSettingsRecord, "updatedAt">,
    currentSettingsUpdatedAt(parsed, "Download")
  );
}

export function defaultDownloadSettings(): DownloadSettingsRecord {
  return { ...DEFAULT_DOWNLOAD_SETTINGS, updatedAt: new Date(0).toISOString() };
}

export function saveDownloadSettings(
  db: CyberOsDatabase,
  settings: Omit<DownloadSettingsRecord, "updatedAt">
): DownloadSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizeDownloadSettings(settings, updatedAt);
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(DOWNLOAD_SETTING_KEY, JSON.stringify(record), updatedAt);
  return record;
}

export function getIndexerSettings(db: CyberOsDatabase): IndexerSettingsRecord | null {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(INDEXER_SETTING_KEY) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
  if (!row) return null;
  const parsed = currentSettingsObject(JSON.parse(row.value_json), [
    "scanConcurrency",
    "extractionConcurrency",
    "reconciliationIntervalMs",
    "maxExtractedTextBytes",
    "maxSourceDocumentBytes",
    "commandTimeoutMs",
    "maxPdfTextPages",
    "maxOcrPages",
    "ocrStoragePoolIds",
    "updatedAt"
  ], "Indexer");
  return normalizeIndexerSettings(
    parsed as Partial<IndexerSettingsRecord>,
    currentSettingsUpdatedAt(parsed, "Indexer")
  );
}

export function defaultIndexerSettings(): IndexerSettingsRecord {
  return { ...DEFAULT_INDEXER_SETTINGS, ocrStoragePoolIds: [], updatedAt: new Date(0).toISOString() };
}

export function saveIndexerSettings(
  db: CyberOsDatabase,
  settings: Partial<Omit<IndexerSettingsRecord, "updatedAt">>
): IndexerSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizeIndexerSettings(settings, updatedAt);
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(INDEXER_SETTING_KEY, JSON.stringify(record), updatedAt);
  return record;
}

export function getPhotosProcessingSettings(db: CyberOsDatabase): PhotosProcessingSettingsRecord | null {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(PHOTOS_PROCESSING_SETTING_KEY) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
  if (!row) return null;
  const parsed = currentSettingsObject(JSON.parse(row.value_json), [
    "processingConcurrency",
    "scanIntervalMs",
    "maxAutoRetries",
    "retryBaseDelayMs",
    "retryMaxDelayMs",
    "commandTimeoutMs",
    "maxFileSizeBytes",
    "maxXmpSizeBytes",
    "maxIntermediateBytes",
    "minFreeSpaceBytes",
    "maxDecodedPixels",
    "updatedAt"
  ], "Photos processing");
  return normalizePhotosProcessingSettings(
    parsed as Partial<PhotosProcessingSettingsRecord>,
    currentSettingsUpdatedAt(parsed, "Photos processing")
  );
}

export function defaultPhotosProcessingSettings(): PhotosProcessingSettingsRecord {
  return { ...DEFAULT_PHOTOS_PROCESSING_SETTINGS, updatedAt: new Date(0).toISOString() };
}

export function savePhotosProcessingSettings(
  db: CyberOsDatabase,
  settings: Partial<Omit<PhotosProcessingSettingsRecord, "updatedAt">>
): PhotosProcessingSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizePhotosProcessingSettings(settings, updatedAt);
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(PHOTOS_PROCESSING_SETTING_KEY, JSON.stringify(record), updatedAt);
  return record;
}

function normalizeDownloadConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error("Download concurrency must be an integer between 1 and 3");
  }
  return value;
}

function normalizeSystemProfileSettings(value: Record<string, unknown>, updatedAt: string): SystemProfileSettingsRecord {
  if (typeof value.adminDisplayName !== "string") throw new Error("Administrator display name must be text");
  const adminDisplayName = value.adminDisplayName.trim();
  if (!adminDisplayName || adminDisplayName.length > 80) {
    throw new Error("Administrator display name must contain between 1 and 80 characters");
  }
  return { adminDisplayName, updatedAt };
}

function normalizeMonitoringSettings(value: Record<string, unknown>, updatedAt: string): MonitoringSettingsRecord {
  if (typeof value.enabled !== "boolean") throw new Error("Monitoring enabled must be a boolean");
  return {
    enabled: value.enabled,
    rawRetentionDays: settingInteger("Monitoring raw retention", value.rawRetentionDays, 1, 14),
    minuteRetentionDays: settingInteger("Monitoring minute retention", value.minuteRetentionDays, 7, 180),
    hourRetentionDays: settingInteger("Monitoring hour retention", value.hourRetentionDays, 30, 1_825),
    maxDatabaseBytes: settingInteger(
      "Monitoring database space limit",
      value.maxDatabaseBytes,
      16 * 1024 * 1024,
      16 * 1024 * 1024 * 1024
    ),
    updatedAt
  };
}

function normalizeBackupSettings(value: Record<string, unknown>, updatedAt: string): BackupSettingsRecord {
  if (typeof value.enabled !== "boolean" || typeof value.requireMount !== "boolean") {
    throw new Error("Backup enabled and mount requirement must be booleans");
  }
  if (typeof value.repositoryPath !== "string" || !value.repositoryPath.trim()) {
    throw new Error("Backup repository path is required");
  }
  const repositoryPath = path.resolve(value.repositoryPath.trim());
  if (!path.isAbsolute(value.repositoryPath.trim()) || repositoryPath === path.parse(repositoryPath).root) {
    throw new Error("Backup repository must be an absolute non-root path");
  }
  if (value.validatedAt !== null && (typeof value.validatedAt !== "string" || !Number.isFinite(Date.parse(value.validatedAt)))) {
    throw new Error("Backup validation timestamp is invalid");
  }
  if (value.enabled && value.validatedAt === null) {
    throw new Error("Backup must be validated before it can be enabled");
  }
  return {
    enabled: value.enabled,
    repositoryPath,
    requireMount: value.requireMount,
    keepDaily: settingInteger("Backup daily retention", value.keepDaily, 1, 365),
    keepWeekly: settingInteger("Backup weekly retention", value.keepWeekly, 1, 104),
    validatedAt: value.validatedAt,
    updatedAt
  };
}

function normalizeTvSettings(value: Record<string, unknown>, updatedAt: string): TvSettingsRecord {
  if (typeof value.enabled !== "boolean") throw new Error("TV enabled must be a boolean");
  if (value.videoOutput !== "drm" && value.videoOutput !== "wayland") {
    throw new Error("TV video output must be drm or wayland");
  }
  if (value.hardwareDecoding !== "auto-safe" && value.hardwareDecoding !== "auto" && value.hardwareDecoding !== "no") {
    throw new Error("TV hardware decoding mode is invalid");
  }
  if (!isNullableString(value.drmConnector) || !isNullableString(value.audioDevice)) {
    throw new Error("TV output device settings must be text or null");
  }
  if (value.enabled && value.videoOutput !== "wayland") {
    throw new Error("TV mode requires Wayland video output");
  }
  return {
    enabled: value.enabled,
    videoOutput: value.videoOutput,
    drmConnector: normalizeNullableText(value.drmConnector, 128),
    audioDevice: normalizeNullableText(value.audioDevice, 256),
    hardwareDecoding: value.hardwareDecoding,
    updatedAt
  };
}

function settingInteger(label: string, value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeNullableText(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`Setting text cannot exceed ${maximum} characters`);
  return normalized || null;
}

function settingRow(
  db: CyberOsDatabase,
  key: string
): Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined {
  return db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(key) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
}

function saveSetting(db: CyberOsDatabase, key: string, record: object, updatedAt: string): void {
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(record), updatedAt);
}

function normalizeDownloadSettings(
  value: Omit<DownloadSettingsRecord, "updatedAt">,
  updatedAt: string
): DownloadSettingsRecord {
  const integer = (name: string, candidate: unknown, minimum: number, maximum: number): number => {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return candidate;
  };
  const concurrency = normalizeDownloadConcurrency(value.concurrency);
  const retryBaseDelayMs = integer("Download retry base delay", value.retryBaseDelayMs, 500, 60_000);
  const retryMaxDelayMs = integer("Download retry maximum delay", value.retryMaxDelayMs, retryBaseDelayMs, 1_800_000);
  const maxFileSizeBytes = value.maxFileSizeBytes === null
    ? null
    : integer("Download maximum file size", value.maxFileSizeBytes, 1, Number.MAX_SAFE_INTEGER);
  return {
    concurrency,
    parallelRequestsPerTask: integer("Download parallel requests", value.parallelRequestsPerTask, 1, 8),
    segmentedDownloadMinBytes: integer("Download segmentation threshold", value.segmentedDownloadMinBytes, 1024 * 1024, 1024 ** 4),
    maxAutoRetries: integer("Download automatic retries", value.maxAutoRetries, 0, 20),
    retryBaseDelayMs,
    retryMaxDelayMs,
    retryAfterMaxDelayMs: integer("Download Retry-After maximum delay", value.retryAfterMaxDelayMs, 1_000, 3_600_000),
    connectTimeoutMs: integer("Download connection timeout", value.connectTimeoutMs, 1_000, 120_000),
    responseHeaderTimeoutMs: integer("Download response header timeout", value.responseHeaderTimeoutMs, 5_000, 300_000),
    readIdleTimeoutMs: integer("Download read idle timeout", value.readIdleTimeoutMs, 5_000, 900_000),
    minFreeSpaceBytes: integer("Download minimum free space", value.minFreeSpaceBytes, 0, Number.MAX_SAFE_INTEGER),
    maxFileSizeBytes,
    updatedAt
  };
}

function normalizePhotosProcessingSettings(
  settings: Partial<Omit<PhotosProcessingSettingsRecord, "updatedAt">>,
  updatedAt: string
): PhotosProcessingSettingsRecord {
  const value = { ...DEFAULT_PHOTOS_PROCESSING_SETTINGS, ...settings };
  const integer = (name: string, candidate: unknown, minimum: number, maximum: number): number => {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return candidate;
  };
  const retryBaseDelayMs = integer("Photos retry base delay", value.retryBaseDelayMs, 500, 1_800_000);
  const retryMaxDelayMs = integer("Photos retry maximum delay", value.retryMaxDelayMs, retryBaseDelayMs, 1_800_000);
  return {
    processingConcurrency: integer("Photos processing concurrency", value.processingConcurrency, 1, 4),
    scanIntervalMs: integer("Photos scan interval", value.scanIntervalMs, 60_000, 86_400_000),
    maxAutoRetries: integer("Photos automatic retries", value.maxAutoRetries, 0, 20),
    retryBaseDelayMs,
    retryMaxDelayMs,
    commandTimeoutMs: integer("Photos command timeout", value.commandTimeoutMs, 5_000, 900_000),
    maxFileSizeBytes: integer("Photos maximum file size", value.maxFileSizeBytes, 1024 ** 2, 1024 ** 4),
    maxXmpSizeBytes: integer("Photos maximum XMP size", value.maxXmpSizeBytes, 1024, 64 * 1024 ** 2),
    maxIntermediateBytes: integer("Photos maximum intermediate size", value.maxIntermediateBytes, 64 * 1024 ** 2, 8 * 1024 ** 3),
    minFreeSpaceBytes: integer("Photos minimum free space", value.minFreeSpaceBytes, 0, 1024 ** 4),
    maxDecodedPixels: integer("Photos maximum decoded pixels", value.maxDecodedPixels, 1_000_000, 268_402_689),
    updatedAt
  };
}

function normalizeIndexerSettings(
  settings: Partial<Omit<IndexerSettingsRecord, "updatedAt">>,
  updatedAt: string
): IndexerSettingsRecord {
  const value = { ...DEFAULT_INDEXER_SETTINGS, ...settings };
  const integer = (name: string, candidate: unknown, minimum: number, maximum: number): number => {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return candidate;
  };
  if (!Array.isArray(value.ocrStoragePoolIds) || value.ocrStoragePoolIds.some((storagePoolId) => typeof storagePoolId !== "string" || !storagePoolId.trim())) {
    throw new Error("Indexer OCR storage pools must be an array of storage pool IDs");
  }
  return {
    scanConcurrency: integer("Indexer scan concurrency", value.scanConcurrency, 1, 16),
    extractionConcurrency: integer("Indexer extraction concurrency", value.extractionConcurrency, 1, 8),
    reconciliationIntervalMs: integer("Indexer reconciliation interval", value.reconciliationIntervalMs, 60_000, 86_400_000),
    maxExtractedTextBytes: integer("Indexer extracted text limit", value.maxExtractedTextBytes, 64 * 1024, 16 * 1024 * 1024),
    maxSourceDocumentBytes: integer("Indexer source document limit", value.maxSourceDocumentBytes, 1024 * 1024, 2 * 1024 ** 4),
    commandTimeoutMs: integer("Indexer command timeout", value.commandTimeoutMs, 5_000, 900_000),
    maxPdfTextPages: integer("Indexer PDF text page limit", value.maxPdfTextPages, 1, 5_000),
    maxOcrPages: integer("Indexer OCR page limit", value.maxOcrPages, 1, 100),
    ocrStoragePoolIds: [...new Set(value.ocrStoragePoolIds.map((storagePoolId) => storagePoolId.trim()))].sort(),
    updatedAt
  };
}

function currentSettingsObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} settings do not match the CyberOS 2.0 format`);
  }
  return value as Record<string, unknown>;
}

function currentSettingsUpdatedAt(value: Record<string, unknown>, label: string): string {
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error(`${label} settings require a valid updatedAt timestamp`);
  }
  return value.updatedAt;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
