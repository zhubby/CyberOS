import type {
  AgentCapabilityPolicySettingsRecord,
  AgentMcpSettingsRecord,
  BluetoothSettingsRecord,
  DownloadSettingsRecord,
  DockerSettingsRecord,
  IndexerSettingsRecord,
  ModelProviderSettingsRecord,
  PhotostaffMapSettingsRecord,
  PhotostaffProcessingSettingsRecord,
  PiToolPolicySettingsRecord,
  ShareSettingsRecord
} from "@zos/shared";
import {
  PHOTOSTAFF_DEFAULT_COMMAND_TIMEOUT_MS,
  PHOTOSTAFF_DEFAULT_MAX_AUTO_RETRIES,
  PHOTOSTAFF_DEFAULT_MAX_DECODED_PIXELS,
  PHOTOSTAFF_DEFAULT_MAX_INTERMEDIATE_BYTES,
  PHOTOSTAFF_DEFAULT_MIN_FREE_SPACE_BYTES,
  PHOTOSTAFF_DEFAULT_PROCESSING_CONCURRENCY,
  PHOTOSTAFF_DEFAULT_RETRY_BASE_DELAY_MS,
  PHOTOSTAFF_DEFAULT_RETRY_MAX_DELAY_MS,
  PHOTOSTAFF_DEFAULT_SCAN_INTERVAL_MS,
  PHOTOSTAFF_MAX_FILE_SIZE_BYTES,
  PHOTOSTAFF_XMP_MAX_FILE_SIZE_BYTES
} from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import {
  mapDockerSettings,
  mapAgentCapabilityPolicySettings,
  mapModelProviderSettings,
  mapPiToolPolicySettings,
  normalizeModelProviderName,
  normalizeAgentCapabilityPolicySettings,
  normalizePiToolPolicySettings
} from "./settings-mappers.js";
import { mapShareSettings, normalizeShareSettings } from "./share-settings-mapper.js";
import { DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS, DEFAULT_PI_TOOL_POLICY_SETTINGS } from "./settings-constants.js";
import type { DbSystemSettingRow } from "./repository-rows.js";

const MODEL_PROVIDER_SETTING_KEY = "model_provider";
const PI_TOOL_POLICY_SETTING_KEY = "pi_tool_policy";
const AGENT_CAPABILITY_POLICY_SETTING_KEY = "agent_capability_policy";
const AGENT_MCP_SETTING_KEY = "agent_mcp";
const DOCKER_SETTING_KEY = "docker_settings";
const SHARE_SETTING_KEY = "share_settings";
const DOWNLOAD_SETTING_KEY = "download_settings";
const PHOTOSTAFF_MAP_SETTING_KEY = "photostaff_map_settings";
const PHOTOSTAFF_PROCESSING_SETTING_KEY = "photostaff_processing_settings";
const INDEXER_SETTING_KEY = "indexer_settings";
const BLUETOOTH_SETTING_KEY = "bluetooth_settings";

export const DEFAULT_BLUETOOTH_SETTINGS: Omit<BluetoothSettingsRecord, "updatedAt"> = {
  defaultAdapterId: null,
  defaultAudioDeviceId: null,
  receiveEnabled: false,
  inboxRootId: null,
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

export const DEFAULT_PHOTOSTAFF_PROCESSING_SETTINGS: Omit<PhotostaffProcessingSettingsRecord, "updatedAt"> = {
  processingConcurrency: PHOTOSTAFF_DEFAULT_PROCESSING_CONCURRENCY,
  scanIntervalMs: PHOTOSTAFF_DEFAULT_SCAN_INTERVAL_MS,
  maxAutoRetries: PHOTOSTAFF_DEFAULT_MAX_AUTO_RETRIES,
  retryBaseDelayMs: PHOTOSTAFF_DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: PHOTOSTAFF_DEFAULT_RETRY_MAX_DELAY_MS,
  commandTimeoutMs: PHOTOSTAFF_DEFAULT_COMMAND_TIMEOUT_MS,
  maxFileSizeBytes: PHOTOSTAFF_MAX_FILE_SIZE_BYTES,
  maxXmpSizeBytes: PHOTOSTAFF_XMP_MAX_FILE_SIZE_BYTES,
  maxIntermediateBytes: PHOTOSTAFF_DEFAULT_MAX_INTERMEDIATE_BYTES,
  minFreeSpaceBytes: PHOTOSTAFF_DEFAULT_MIN_FREE_SPACE_BYTES,
  maxDecodedPixels: PHOTOSTAFF_DEFAULT_MAX_DECODED_PIXELS
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
  ocrRootIds: []
};

export {
  DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS,
  DEFAULT_PI_TOOL_POLICY_SETTINGS
} from "./settings-constants.js";

export function defaultBluetoothSettings(): BluetoothSettingsRecord {
  return { ...DEFAULT_BLUETOOTH_SETTINGS, updatedAt: new Date(0).toISOString() };
}

export function getBluetoothSettings(db: ZosDatabase): BluetoothSettingsRecord | null {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(BLUETOOTH_SETTING_KEY) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<BluetoothSettingsRecord>;
    return normalizeBluetoothSettings(parsed, typeof parsed.updatedAt === "string" ? parsed.updatedAt : row.updated_at);
  } catch {
    return null;
  }
}

export function saveBluetoothSettings(
  db: ZosDatabase,
  settings: Partial<Omit<BluetoothSettingsRecord, "updatedAt">>
): BluetoothSettingsRecord {
  const updatedAt = new Date().toISOString();
  const current = getBluetoothSettings(db) ?? defaultBluetoothSettings();
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
  const inboxRootId = text(input.inboxRootId, 256);
  const inboxStoragePoolId = text(input.inboxStoragePoolId, 256);
  const inboxPath = text(input.inboxPath);
  const completeInbox = Boolean(inboxRootId && inboxStoragePoolId && inboxPath);
  return {
    defaultAdapterId: text(input.defaultAdapterId, 128),
    defaultAudioDeviceId: text(input.defaultAudioDeviceId, 128),
    receiveEnabled: input.receiveEnabled === true && completeInbox,
    inboxRootId,
    inboxStoragePoolId,
    inboxPath,
    updatedAt
  };
}

export function getModelProviderSettings(db: ZosDatabase): ModelProviderSettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(MODEL_PROVIDER_SETTING_KEY) as DbSystemSettingRow | undefined;

  return row ? mapModelProviderSettings(row) : null;
}

export function saveModelProviderSettings(
  db: ZosDatabase,
  settings: Omit<ModelProviderSettingsRecord, "updatedAt">
): ModelProviderSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record: ModelProviderSettingsRecord = {
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
}

export function defaultPiToolPolicySettings(): PiToolPolicySettingsRecord {
  return {
    ...DEFAULT_PI_TOOL_POLICY_SETTINGS,
    updatedAt: new Date(0).toISOString()
  };
}

export function getPiToolPolicySettings(db: ZosDatabase): PiToolPolicySettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(PI_TOOL_POLICY_SETTING_KEY) as DbSystemSettingRow | undefined;

  return row ? mapPiToolPolicySettings(row) : null;
}

export function savePiToolPolicySettings(
  db: ZosDatabase,
  settings: Omit<PiToolPolicySettingsRecord, "updatedAt">
): PiToolPolicySettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizePiToolPolicySettings(settings, updatedAt);

  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(PI_TOOL_POLICY_SETTING_KEY, JSON.stringify(record), updatedAt);

  return record;
}

export function defaultAgentCapabilityPolicySettings(): AgentCapabilityPolicySettingsRecord {
  return {
    policies: { ...DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS.policies },
    updatedAt: new Date(0).toISOString()
  };
}

export function getAgentCapabilityPolicySettings(db: ZosDatabase): AgentCapabilityPolicySettingsRecord | null {
  const row = db.prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(AGENT_CAPABILITY_POLICY_SETTING_KEY) as DbSystemSettingRow | undefined;
  if (row) return mapAgentCapabilityPolicySettings(row);

  const legacy = getPiToolPolicySettings(db);
  if (!legacy) return null;
  return {
    policies: {
      ...DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS.policies,
      "zos.files.list": legacy.ls,
      "zos.files.read": legacy.read,
      "zos.files.grep": legacy.grep,
      "zos.files.find": legacy.find,
      "zos.files.edit": legacy.edit,
      "zos.files.write": legacy.write,
      "zos.shell.run": legacy.bash
    },
    updatedAt: legacy.updatedAt
  };
}

export function saveAgentCapabilityPolicySettings(
  db: ZosDatabase,
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

export function getAgentMcpSettings(db: ZosDatabase): AgentMcpSettingsRecord | null {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(AGENT_MCP_SETTING_KEY) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
  if (!row) return null;
  const value = JSON.parse(row.value_json) as { enabled?: unknown };
  if (typeof value.enabled !== "boolean") {
    throw new Error("Invalid Agent MCP enabled setting");
  }
  return { enabled: value.enabled, updatedAt: row.updated_at };
}

export function saveAgentMcpSettings(db: ZosDatabase, enabled: boolean): AgentMcpSettingsRecord {
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
    read: settings.policies["zos.files.read"],
    grep: settings.policies["zos.files.grep"],
    find: settings.policies["zos.files.find"],
    ls: settings.policies["zos.files.list"],
    bash: settings.policies["zos.shell.run"],
    edit: settings.policies["zos.files.edit"],
    write: settings.policies["zos.files.write"],
    updatedAt: settings.updatedAt
  };
}

export function getDockerSettings(db: ZosDatabase): DockerSettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(DOCKER_SETTING_KEY) as DbSystemSettingRow | undefined;

  return row ? mapDockerSettings(row) : null;
}

export function saveDockerSettings(
  db: ZosDatabase,
  settings: Omit<DockerSettingsRecord, "updatedAt">
): DockerSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record: DockerSettingsRecord = {
    enabled: settings.enabled,
    socketPath: settings.socketPath,
    composeCommand: settings.composeCommand,
    operationTimeoutMs: settings.operationTimeoutMs,
    consoleShells: settings.consoleShells,
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

export function getShareSettings(db: ZosDatabase): ShareSettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(SHARE_SETTING_KEY) as DbSystemSettingRow | undefined;

  return row ? mapShareSettings(row) : null;
}

export function saveShareSettings(
  db: ZosDatabase,
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

export function getDownloadSettings(db: ZosDatabase): DownloadSettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(DOWNLOAD_SETTING_KEY) as DbSystemSettingRow | undefined;
  if (!row) {
    return null;
  }
  const parsed = JSON.parse(row.value_json) as Partial<DownloadSettingsRecord>;
  return normalizeDownloadSettings(parsed, typeof parsed.updatedAt === "string" ? parsed.updatedAt : row.updated_at);
}

export function defaultDownloadSettings(): DownloadSettingsRecord {
  return { ...DEFAULT_DOWNLOAD_SETTINGS, updatedAt: new Date(0).toISOString() };
}

export function saveDownloadSettings(
  db: ZosDatabase,
  settings: Partial<Omit<DownloadSettingsRecord, "updatedAt">>
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

export function getIndexerSettings(db: ZosDatabase): IndexerSettingsRecord | null {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(INDEXER_SETTING_KEY) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<IndexerSettingsRecord>;
    return normalizeIndexerSettings(
      parsed,
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : row.updated_at
    );
  } catch {
    return null;
  }
}

export function defaultIndexerSettings(): IndexerSettingsRecord {
  return { ...DEFAULT_INDEXER_SETTINGS, ocrRootIds: [], updatedAt: new Date(0).toISOString() };
}

export function saveIndexerSettings(
  db: ZosDatabase,
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

export function getPhotostaffMapSettings(db: ZosDatabase): PhotostaffMapSettingsRecord | null {
  const row = db
    .prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(PHOTOSTAFF_MAP_SETTING_KEY) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.value_json) as Partial<PhotostaffMapSettingsRecord>;
  if (
    typeof parsed.rootId !== "string" ||
    typeof parsed.storagePoolId !== "string" ||
    typeof parsed.path !== "string" ||
    (parsed.tileType !== "png" && parsed.tileType !== "jpeg" && parsed.tileType !== "webp") ||
    typeof parsed.minZoom !== "number" ||
    typeof parsed.maxZoom !== "number"
  ) return null;
  return {
    rootId: parsed.rootId,
    storagePoolId: parsed.storagePoolId,
    path: parsed.path,
    tileType: parsed.tileType,
    minZoom: parsed.minZoom,
    maxZoom: parsed.maxZoom,
    bounds: Array.isArray(parsed.bounds) && parsed.bounds.length === 4
      ? parsed.bounds as [number, number, number, number]
      : null,
    attribution: typeof parsed.attribution === "string" ? parsed.attribution : null,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : row.updated_at
  };
}

export function savePhotostaffMapSettings(
  db: ZosDatabase,
  settings: Omit<PhotostaffMapSettingsRecord, "updatedAt">
): PhotostaffMapSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record: PhotostaffMapSettingsRecord = { ...settings, updatedAt };
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(PHOTOSTAFF_MAP_SETTING_KEY, JSON.stringify(record), updatedAt);
  return record;
}

export function getPhotostaffProcessingSettings(db: ZosDatabase): PhotostaffProcessingSettingsRecord | null {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(PHOTOSTAFF_PROCESSING_SETTING_KEY) as Pick<DbSystemSettingRow, "value_json" | "updated_at"> | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<PhotostaffProcessingSettingsRecord>;
    return normalizePhotostaffProcessingSettings(parsed, typeof parsed.updatedAt === "string" ? parsed.updatedAt : row.updated_at);
  } catch {
    return null;
  }
}

export function defaultPhotostaffProcessingSettings(): PhotostaffProcessingSettingsRecord {
  return { ...DEFAULT_PHOTOSTAFF_PROCESSING_SETTINGS, updatedAt: new Date(0).toISOString() };
}

export function savePhotostaffProcessingSettings(
  db: ZosDatabase,
  settings: Partial<Omit<PhotostaffProcessingSettingsRecord, "updatedAt">>
): PhotostaffProcessingSettingsRecord {
  const updatedAt = new Date().toISOString();
  const record = normalizePhotostaffProcessingSettings(settings, updatedAt);
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(PHOTOSTAFF_PROCESSING_SETTING_KEY, JSON.stringify(record), updatedAt);
  return record;
}

function normalizeDownloadConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error("Download concurrency must be an integer between 1 and 3");
  }
  return value;
}

function normalizeDownloadSettings(
  settings: Partial<Omit<DownloadSettingsRecord, "updatedAt">>,
  updatedAt: string
): DownloadSettingsRecord {
  const value = { ...DEFAULT_DOWNLOAD_SETTINGS, ...settings };
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

function normalizePhotostaffProcessingSettings(
  settings: Partial<Omit<PhotostaffProcessingSettingsRecord, "updatedAt">>,
  updatedAt: string
): PhotostaffProcessingSettingsRecord {
  const value = { ...DEFAULT_PHOTOSTAFF_PROCESSING_SETTINGS, ...settings };
  const integer = (name: string, candidate: unknown, minimum: number, maximum: number): number => {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return candidate;
  };
  const retryBaseDelayMs = integer("Photostaff retry base delay", value.retryBaseDelayMs, 500, 1_800_000);
  const retryMaxDelayMs = integer("Photostaff retry maximum delay", value.retryMaxDelayMs, retryBaseDelayMs, 1_800_000);
  return {
    processingConcurrency: integer("Photostaff processing concurrency", value.processingConcurrency, 1, 4),
    scanIntervalMs: integer("Photostaff scan interval", value.scanIntervalMs, 60_000, 86_400_000),
    maxAutoRetries: integer("Photostaff automatic retries", value.maxAutoRetries, 0, 20),
    retryBaseDelayMs,
    retryMaxDelayMs,
    commandTimeoutMs: integer("Photostaff command timeout", value.commandTimeoutMs, 5_000, 900_000),
    maxFileSizeBytes: integer("Photostaff maximum file size", value.maxFileSizeBytes, 1024 ** 2, 1024 ** 4),
    maxXmpSizeBytes: integer("Photostaff maximum XMP size", value.maxXmpSizeBytes, 1024, 64 * 1024 ** 2),
    maxIntermediateBytes: integer("Photostaff maximum intermediate size", value.maxIntermediateBytes, 64 * 1024 ** 2, 8 * 1024 ** 3),
    minFreeSpaceBytes: integer("Photostaff minimum free space", value.minFreeSpaceBytes, 0, 1024 ** 4),
    maxDecodedPixels: integer("Photostaff maximum decoded pixels", value.maxDecodedPixels, 1_000_000, 268_402_689),
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
  if (!Array.isArray(value.ocrRootIds) || value.ocrRootIds.some((rootId) => typeof rootId !== "string" || !rootId.trim())) {
    throw new Error("Indexer OCR roots must be an array of root IDs");
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
    ocrRootIds: [...new Set(value.ocrRootIds.map((rootId) => rootId.trim()))].sort(),
    updatedAt
  };
}
