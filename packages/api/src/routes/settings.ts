import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS,
  defaultAgentCapabilityPolicySettings,
  defaultIndexerSettings,
  defaultDownloadSettings,
  getDockerSettings,
  getDownloadSettings,
  getIndexerSettings,
  getModelProviderSettings,
  getAgentCapabilityPolicySettings,
  getShareSettings,
  saveDockerSettings,
  saveDownloadSettings,
  saveIndexerSettings,
  saveModelProviderSettings,
  saveAgentCapabilityPolicySettings
} from "@cyberos/db";
import type {
  AgentCapabilityId,
  AgentCapabilityPolicyMode,
  AgentCapabilityPolicySettingsRecord,
  DownloadSettingsRecord,
  IndexerSettingsRecord,
  ModelProviderName
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import {
  defaultDockerSettings,
  defaultShareSettings,
  defaultModelProviderSettings,
  effectiveDockerConfig,
  isModelProviderName,
  normalizeOptionalText,
  toPublicDockerSettings,
  toPublicShareSettings,
  toPublicModelProviderSettings,
  toPublicAgentCapabilityPolicySettings
} from "../lib/settings.js";
import { configureAgentMcp, publicAgentMcpSettings } from "../lib/agent-mcp-settings.js";
import { collectSystemInfo } from "../lib/system-info.js";
import { collectSystemStorage } from "../lib/system-management.js";

export function registerSettingsRoutes(server: FastifyInstance, { config, db, system }: ApiRouteContext): void {
  server.get("/api/settings/indexer", async () => ({
    settings: getIndexerSettings(db) ?? defaultIndexerSettings()
  }));

  server.patch<{
    Body: Partial<Omit<IndexerSettingsRecord, "updatedAt">>;
  }>("/api/settings/indexer", async (request, reply) => {
    try {
      const existing = getIndexerSettings(db) ?? defaultIndexerSettings();
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

  server.get("/api/settings/downloads", async () => ({
    settings: getDownloadSettings(db) ?? defaultDownloadSettings()
  }));

  server.patch<{
    Body: Partial<Record<keyof Omit<DownloadSettingsRecord, "updatedAt">, number | string | null>>;
  }>("/api/settings/downloads", async (request, reply) => {
    try {
      const existing = getDownloadSettings(db) ?? defaultDownloadSettings();
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

  server.get("/api/settings/system-info", async () => ({
    info: await collectSystemInfo(effectiveDockerConfig(config, getDockerSettings(db)))
  }));

  server.get("/api/settings/model-provider", async () => ({
    settings: toPublicModelProviderSettings(getModelProviderSettings(db) ?? defaultModelProviderSettings())
  }));

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
    const existing = getModelProviderSettings(db) ?? defaultModelProviderSettings();
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

  server.get("/api/settings/agent-capability-policy", async () => ({
    settings: toPublicAgentCapabilityPolicySettings(
      getAgentCapabilityPolicySettings(db) ?? defaultAgentCapabilityPolicySettings()
    )
  }));

  server.patch<{
    Body: { policies?: Partial<Record<AgentCapabilityId, AgentCapabilityPolicyMode>> };
  }>("/api/settings/agent-capability-policy", async (request, reply) => {
    const existing = getAgentCapabilityPolicySettings(db) ?? defaultAgentCapabilityPolicySettings();
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

  server.get("/api/settings/agent-mcp", async () => ({
    settings: publicAgentMcpSettings(db, config)
  }));

  server.patch<{
    Body: { enabled?: boolean };
  }>("/api/settings/agent-mcp", async (request, reply) => {
    if (typeof request.body?.enabled !== "boolean") {
      reply.status(400).send({ error: "Agent MCP enabled must be a boolean" });
      return;
    }
    if (request.body.enabled && !config.mcp.enabled) {
      reply.status(409).send({ error: "CyberOS MCP is disabled by host configuration" });
      return;
    }
    try {
      reply.send({ settings: configureAgentMcp(db, config, request.body.enabled) });
    } catch (error) {
      request.log.error({ err: error }, "Agent MCP configuration failed");
      reply.status(500).send({ error: "Agent MCP configuration failed" });
    }
  });

  server.get("/api/settings/docker", async () => ({
    settings: toPublicDockerSettings(getDockerSettings(db) ?? defaultDockerSettings(config))
  }));

  server.get("/api/settings/shares", async () => ({
    settings: toPublicShareSettings(getShareSettings(db) ?? defaultShareSettings(config))
  }));

  server.patch<{
    Body: {
      enabled?: boolean;
      socketPath?: string;
      composeCommand?: string;
      operationTimeoutMs?: number | string;
      consoleShells?: string[] | string;
    };
  }>("/api/settings/docker", async (request, reply) => {
    const existing = getDockerSettings(db) ?? defaultDockerSettings(config);

    try {
      const settings = saveDockerSettings(db, {
        enabled: request.body?.enabled ?? existing.enabled,
        socketPath: normalizeTextField(request.body?.socketPath, existing.socketPath, "/var/run/docker.sock"),
        composeCommand: normalizeTextField(request.body?.composeCommand, existing.composeCommand, "docker"),
        operationTimeoutMs: normalizePositiveInteger(
          request.body?.operationTimeoutMs,
          existing.operationTimeoutMs
        ),
        consoleShells: normalizeDockerShells(request.body?.consoleShells, existing.consoleShells)
      });

      reply.send({
        settings: toPublicDockerSettings(settings)
      });
    } catch (error) {
      reply.status(400).send({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

function normalizeTextField(value: string | undefined, fallback: string, defaultValue: string): string {
  const candidate = normalizeOptionalText(value) ?? fallback;
  return candidate || defaultValue;
}

function normalizePositiveInteger(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Docker operation timeout must be a positive integer");
  }
  return parsed;
}

function normalizeDockerShells(value: string[] | string | undefined, fallback: string[]): string[] {
  const rawShells = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]/gu) : fallback;
  const shells = rawShells.map((shell) => shell.trim()).filter(Boolean);
  if (!shells.length) {
    return fallback;
  }
  return shells.map((shell) => {
    if (!path.isAbsolute(shell)) {
      throw new Error(`Docker console shell must be an absolute path: ${shell}`);
    }
    return shell;
  });
}
