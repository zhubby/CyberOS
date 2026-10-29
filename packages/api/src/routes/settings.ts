import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { initBackup, validateBackup } from "@cyberos/backup";
import {
  DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS,
  defaultAgentCapabilityPolicySettings,
  defaultIndexerSettings,
  defaultDownloadSettings,
  getDockerSettings,
  getDownloadSettings,
  getIndexerSettings,
  getModelProviderSettings,
  getBackupSettings,
  getMonitoringSettings,
  getSystemProfileSettings,
  getTvSettings,
  getAgentCapabilityPolicySettings,
  getVmSettings,
  saveDockerSettings,
  saveDownloadSettings,
  saveIndexerSettings,
  saveVmSettings,
  saveModelProviderSettings,
  saveAgentCapabilityPolicySettings,
  saveBackupSettings,
  saveMonitoringSettings,
  saveSystemProfileSettings,
  saveTvSettings,
  defaultBackupSettings,
  defaultMonitoringSettings,
  defaultSystemProfileSettings,
  defaultTvSettings,
  validateTvSettings
} from "@cyberos/db";
import type {
  AgentCapabilityId,
  AgentCapabilityPolicyMode,
  AgentCapabilityPolicySettingsRecord,
  DownloadSettingsRecord,
  IndexerSettingsRecord,
  BackupSettingsRecord,
  MonitoringSettingsRecord,
  ModelProviderName,
  SystemProfileSettingsRecord,
  TvSettingsRecord
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import {
  defaultDockerSettings,
  defaultVmSettings,
  defaultModelProviderSettings,
  effectiveBackupConfig,
  effectiveDockerConfig,
  isModelProviderName,
  normalizeOptionalText,
  toPublicDockerSettings,
  toPublicShareSettings,
  toPublicModelProviderSettings,
  toPublicAgentCapabilityPolicySettings
} from "../lib/settings.js";
import { collectSystemInfo } from "../lib/system-info.js";
import { collectSystemStorage } from "../lib/system-management.js";
import { loadEffectiveShareSettings } from "../lib/share-credentials.js";

export function registerSettingsRoutes(server: FastifyInstance, { config, db, system, tvMode }: ApiRouteContext): void {
  server.get("/api/settings/system-profile", async (_request, reply) => {
    try {
      reply.send({ settings: getSystemProfileSettings(db) ?? defaultSystemProfileSettings() });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.patch<{ Body: Partial<Omit<SystemProfileSettingsRecord, "updatedAt">> }>(
    "/api/settings/system-profile",
    async (request, reply) => {
      if (hasUnknownFields(request.body, ["adminDisplayName"])) {
        reply.status(400).send({ error: "System profile settings contain unknown fields" });
        return;
      }
      const existing = readForRepair(() => getSystemProfileSettings(db), defaultSystemProfileSettings);
      try {
        reply.send({ settings: saveSystemProfileSettings(db, { ...existing, ...request.body }) });
      } catch (error) {
        reply.status(400).send({ error: settingError(error) });
      }
    }
  );

  server.get("/api/settings/monitoring", async (_request, reply) => {
    try {
      reply.send({ settings: getMonitoringSettings(db) ?? defaultMonitoringSettings() });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.patch<{ Body: Partial<Omit<MonitoringSettingsRecord, "updatedAt">> }>(
    "/api/settings/monitoring",
    async (request, reply) => {
      if (hasUnknownFields(request.body, [
        "enabled", "rawRetentionDays", "minuteRetentionDays", "hourRetentionDays", "maxDatabaseBytes"
      ])) {
        reply.status(400).send({ error: "Monitoring settings contain unknown fields" });
        return;
      }
      const existing = readForRepair(() => getMonitoringSettings(db), defaultMonitoringSettings);
      try {
        reply.send({ settings: saveMonitoringSettings(db, { ...existing, ...request.body }) });
      } catch (error) {
        reply.status(400).send({ error: settingError(error) });
      }
    }
  );

  server.get("/api/settings/backup", async (_request, reply) => {
    try {
      const settings = getBackupSettings(db) ?? defaultBackupSettings(
        config.paths.backupRoot,
        config.environment === "production"
      );
      reply.send({ settings: await publicBackupSettings(settings, config.paths.backupPasswordPath) });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.patch<{ Body: Partial<Omit<BackupSettingsRecord, "updatedAt" | "validatedAt">> }>(
    "/api/settings/backup",
    async (request, reply) => {
      if (hasUnknownFields(request.body, ["enabled", "repositoryPath", "requireMount", "keepDaily", "keepWeekly"])) {
        reply.status(400).send({ error: "Backup settings contain unknown fields" });
        return;
      }
      const fallback = () => defaultBackupSettings(config.paths.backupRoot, config.environment === "production");
      const existing = readForRepair(() => getBackupSettings(db), fallback);
      const repositoryChanged = request.body.repositoryPath !== undefined
        && request.body.repositoryPath.trim() !== existing.repositoryPath;
      const mountPolicyChanged = request.body.requireMount !== undefined
        && request.body.requireMount !== existing.requireMount;
      const next = {
        ...existing,
        ...request.body,
        validatedAt: repositoryChanged || mountPolicyChanged ? null : existing.validatedAt
      };
      try {
        const saved = saveBackupSettings(db, next);
        reply.send({ settings: await publicBackupSettings(saved, config.paths.backupPasswordPath) });
      } catch (error) {
        reply.status(400).send({ error: settingError(error) });
      }
    }
  );

  server.put<{ Body: { password?: string } }>("/api/settings/backup/credential", async (request, reply) => {
    const password = request.body?.password;
    if (typeof password !== "string" || !password || password.length > 4_096 || password.includes("\0")) {
      reply.status(400).send({ error: "Backup password must contain between 1 and 4096 characters" });
      return;
    }
    const fallback = () => defaultBackupSettings(config.paths.backupRoot, config.environment === "production");
    const current = readForRepair(() => getBackupSettings(db), fallback);
    const saved = saveBackupSettings(db, { ...current, enabled: false, validatedAt: null });
    await writeSecretAtomically(config.paths.backupPasswordPath, `${password}\n`);
    reply.send({ settings: await publicBackupSettings(saved, config.paths.backupPasswordPath) });
  });

  server.delete("/api/settings/backup/credential", async (_request, reply) => {
    const fallback = () => defaultBackupSettings(config.paths.backupRoot, config.environment === "production");
    const current = readForRepair(() => getBackupSettings(db), fallback);
    const saved = saveBackupSettings(db, { ...current, enabled: false, validatedAt: null });
    await rm(config.paths.backupPasswordPath, { force: true });
    reply.send({ settings: await publicBackupSettings(saved, config.paths.backupPasswordPath) });
  });

  server.post<{ Body: { confirmed?: boolean } }>("/api/settings/backup/initialize", async (request, reply) => {
    if (request.body?.confirmed !== true) {
      reply.status(400).send({ error: "Backup repository initialization requires confirmation" });
      return;
    }
    const settings = getBackupSettings(db) ?? defaultBackupSettings(config.paths.backupRoot, config.environment === "production");
    const runtime = effectiveBackupConfig(config, { ...settings, enabled: true });
    try {
      await initBackup({ db, config: runtime });
      const validation = await validateBackup({ db, config: runtime });
      if (!validation.ok) throw new Error(validation.issues.join("; "));
      const saved = saveBackupSettings(db, { ...settings, validatedAt: new Date().toISOString() });
      reply.send({ settings: await publicBackupSettings(saved, config.paths.backupPasswordPath) });
    } catch (error) {
      reply.status(409).send({ error: settingError(error) });
    }
  });

  server.post("/api/settings/backup/validate", async (_request, reply) => {
    const settings = getBackupSettings(db) ?? defaultBackupSettings(config.paths.backupRoot, config.environment === "production");
    const validation = await validateBackup({
      db,
      config: effectiveBackupConfig(config, { ...settings, enabled: true })
    });
    if (!validation.ok) {
      reply.status(409).send({ error: validation.issues.join("; "), issues: validation.issues });
      return;
    }
    const saved = saveBackupSettings(db, { ...settings, validatedAt: new Date().toISOString() });
    reply.send({ settings: await publicBackupSettings(saved, config.paths.backupPasswordPath) });
  });

  server.get("/api/settings/tv", async (_request, reply) => {
    try {
      reply.send({ settings: getTvSettings(db) ?? defaultTvSettings() });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.patch<{ Body: Partial<Omit<TvSettingsRecord, "updatedAt">> & { confirmed?: boolean } }>("/api/settings/tv", async (request, reply) => {
    if (hasUnknownFields(request.body, ["enabled", "videoOutput", "drmConnector", "audioDevice", "hardwareDecoding", "confirmed"])) {
      reply.status(400).send({ error: "TV settings contain unknown fields" });
      return;
    }
    const existing = readForRepair(() => getTvSettings(db), defaultTvSettings);
    const { confirmed, ...updates } = request.body;
    let next: Omit<TvSettingsRecord, "updatedAt">;
    try {
      next = validateTvSettings({ ...existing, ...updates });
    } catch (error) {
      reply.status(400).send({ error: settingError(error) });
      return;
    }
    const changingMode = next.enabled !== existing.enabled || (updates.enabled !== undefined && confirmed === true);
    if (changingMode && confirmed !== true) {
      reply.status(400).send({ error: "TV mode changes require confirmation" });
      return;
    }
    if (changingMode && !tvMode) {
      reply.status(503).send({ error: "TV mode control is unavailable" });
      return;
    }
    try {
      if (changingMode) await tvMode!.apply(next.enabled);
    } catch (error) {
      reply.status(hostdSettingStatus(error)).send({ error: settingError(error) });
      return;
    }
    try {
      reply.send({ settings: saveTvSettings(db, next) });
    } catch (error) {
      if (changingMode) {
        try {
          await tvMode!.apply(existing.enabled);
        } catch (rollbackError) {
          reply.status(500).send({
            error: `${settingError(error)}; TV mode rollback failed: ${settingError(rollbackError)}`
          });
          return;
        }
      }
      reply.status(500).send({ error: settingError(error) });
    }
  });

  server.get("/api/settings/indexer", async (_request, reply) => {
    try {
      reply.send({ settings: getIndexerSettings(db) ?? defaultIndexerSettings() });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.patch<{
    Body: Partial<Omit<IndexerSettingsRecord, "updatedAt">>;
  }>("/api/settings/indexer", async (request, reply) => {
    try {
      const existing = readForRepair(() => getIndexerSettings(db), defaultIndexerSettings);
      const next = { ...existing, ...request.body };
      const storagePoolIds = new Set(
        system ? (await collectSystemStorage(system)).pools.map((pool) => pool.id) : []
      );
      if (next.ocrStoragePoolIds.some((storagePoolId) => !storagePoolIds.has(storagePoolId))) {
        throw new Error("Indexer OCR pools must reference mounted storage pools");
      }
      reply.send({ settings: saveIndexerSettings(db, next) });
    } catch (error) {
      reply.status(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.get("/api/settings/downloads", async (_request, reply) => {
    try {
      reply.send({ settings: getDownloadSettings(db) ?? defaultDownloadSettings() });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.patch<{
    Body: Partial<Record<keyof Omit<DownloadSettingsRecord, "updatedAt">, number | string | null>>;
  }>("/api/settings/downloads", async (request, reply) => {
    try {
      const existing = readForRepair(() => getDownloadSettings(db), defaultDownloadSettings);
      const numericKeys = [
        "concurrency", "parallelRequestsPerTask", "segmentedDownloadMinBytes", "maxAutoRetries",
        "retryBaseDelayMs", "retryMaxDelayMs", "retryAfterMaxDelayMs", "connectTimeoutMs",
        "responseHeaderTimeoutMs", "readIdleTimeoutMs", "minFreeSpaceBytes"
      ] as const;
      const next: Omit<DownloadSettingsRecord, "updatedAt"> = { ...existing };
      for (const key of numericKeys) {
        if (request.body?.[key] !== undefined && request.body[key] !== null) {
          next[key] = Number(request.body[key]);
        }
      }
      if (request.body?.maxFileSizeBytes !== undefined) {
        next.maxFileSizeBytes = request.body.maxFileSizeBytes === null
          ? null
          : Number(request.body.maxFileSizeBytes);
      }
      reply.send({
        settings: saveDownloadSettings(db, next)
      });
    } catch (error) {
      reply.status(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.get("/api/settings/system-info", async (_request, reply) => {
    try {
      reply.send({
        info: await collectSystemInfo(
          effectiveDockerConfig(config, getDockerSettings(db)),
          (getSystemProfileSettings(db) ?? defaultSystemProfileSettings()).adminDisplayName
        )
      });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.get("/api/settings/model-provider", async (_request, reply) => {
    try {
      reply.send({
        settings: toPublicModelProviderSettings(getModelProviderSettings(db) ?? defaultModelProviderSettings())
      });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.patch<{
    Body: {
      providerName?: string;
      baseUrl?: string | null;
      model?: string;
      apiKey?: string;
      clearApiKey?: boolean;
    };
  }>("/api/settings/model-provider", async (request, reply) => {
    const allowedFields = new Set(["providerName", "baseUrl", "model", "apiKey", "clearApiKey"]);
    if (Object.keys(request.body ?? {}).some((key) => !allowedFields.has(key))) {
      reply.status(400).send({ error: "Model provider settings contain unknown fields" });
      return;
    }
    const existing = readForRepair(() => getModelProviderSettings(db), defaultModelProviderSettings);
    const providerName = request.body?.providerName ?? existing.providerName;
    if (!isModelProviderName(providerName)) {
      reply.status(400).send({ error: "Unsupported model provider" });
      return;
    }

    const normalizedProviderName = providerName.trim() as ModelProviderName;
    const baseUrl =
      request.body?.baseUrl === undefined ? existing.baseUrl : normalizeOptionalText(request.body.baseUrl);
    const model =
      request.body?.model === undefined ? existing.model : normalizeOptionalText(request.body.model) ?? "";
    const apiKey = request.body?.clearApiKey
      ? null
      : normalizeOptionalText(request.body?.apiKey) ?? existing.apiKey;

    const settings = saveModelProviderSettings(db, {
      providerName: normalizedProviderName,
      baseUrl,
      model,
      apiKey
    });

    reply.send({
      settings: toPublicModelProviderSettings(settings)
    });
  });

  server.get("/api/settings/agent-capability-policy", async (_request, reply) => {
    try {
      reply.send({
        settings: toPublicAgentCapabilityPolicySettings(
          getAgentCapabilityPolicySettings(db) ?? defaultAgentCapabilityPolicySettings()
        )
      });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.patch<{
    Body: { policies?: Partial<Record<AgentCapabilityId, AgentCapabilityPolicyMode>> };
  }>("/api/settings/agent-capability-policy", async (request, reply) => {
    const existing = readForRepair(
      () => getAgentCapabilityPolicySettings(db),
      defaultAgentCapabilityPolicySettings
    );
    const next: Omit<AgentCapabilityPolicySettingsRecord, "updatedAt"> = {
      policies: {
        ...DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS.policies,
        ...existing.policies,
        ...request.body?.policies
      }
    };

    try {
      const settings = saveAgentCapabilityPolicySettings(db, next);
      reply.send({
        settings: toPublicAgentCapabilityPolicySettings(settings)
      });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.get("/api/settings/docker", async (_request, reply) => {
    try {
      reply.send({ settings: toPublicDockerSettings(getDockerSettings(db) ?? defaultDockerSettings(config)) });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.get("/api/settings/vm", async (_request, reply) => {
    try {
      reply.send({ settings: getVmSettings(db) ?? defaultVmSettings(config) });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.get("/api/settings/shares", async (_request, reply) => {
    try {
      reply.send({ settings: toPublicShareSettings(await loadEffectiveShareSettings(db, config)) });
    } catch (error) {
      reply.status(409).send({ error: settingError(error), state: "attention" });
    }
  });

  server.patch<{
    Body: { enabled?: boolean };
  }>("/api/settings/docker", async (request, reply) => {
    if (Object.keys(request.body ?? {}).some((key) => key !== "enabled")) {
      reply.status(400).send({ error: "Docker settings contain unknown fields" });
      return;
    }
    if (typeof request.body?.enabled !== "boolean") {
      reply.status(400).send({ error: "Docker enabled must be a boolean" });
      return;
    }
    reply.send({ settings: toPublicDockerSettings(saveDockerSettings(db, { enabled: request.body.enabled })) });
  });

  server.patch<{
    Body: { enabled?: boolean };
  }>("/api/settings/vm", async (request, reply) => {
    if (Object.keys(request.body ?? {}).some((key) => key !== "enabled")) {
      reply.status(400).send({ error: "Virtual machine settings contain unknown fields" });
      return;
    }
    if (typeof request.body?.enabled !== "boolean") {
      reply.status(400).send({ error: "Virtual machine enabled must be a boolean" });
      return;
    }
    reply.send({ settings: saveVmSettings(db, { enabled: request.body.enabled }) });
  });
}

function hasUnknownFields(body: object | null | undefined, fields: readonly string[]): boolean {
  const allowed = new Set(fields);
  return Object.keys(body ?? {}).some((key) => !allowed.has(key));
}

function readForRepair<T>(read: () => T | null, fallback: () => T): T {
  try {
    return read() ?? fallback();
  } catch {
    return fallback();
  }
}

function settingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostdSettingStatus(error: unknown): number {
  if (
    typeof error === "object"
    && error !== null
    && "statusCode" in error
    && typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return 503;
}

async function publicBackupSettings(settings: BackupSettingsRecord, passwordPath: string) {
  return {
    ...settings,
    passwordConfigured: await access(passwordPath).then(() => true).catch(() => false)
  };
}

async function writeSecretAtomically(targetPath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
