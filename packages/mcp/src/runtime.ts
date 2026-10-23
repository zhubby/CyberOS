import { randomUUID } from "node:crypto";
import {
  CapabilityError,
  CapabilityRegistry,
  capabilityResult,
  createCatalogDescriptors,
  type CapabilityContext,
  type CapabilityDescriptor,
  type CapabilityExecution,
  type CapabilityResult,
  type JsonValue
} from "@zos/capabilities";
import {
  executeFileReadCapability,
  proposeFileMutation,
  proposePiMcpFileCapability,
  type PiMcpFileCapabilityId
} from "@zos/capability-runtime";
import {
  cancelOwnedCapabilityRun,
  countUnreadOperationNotifications,
  createMcpTransferToken,
  defaultDownloadSettings,
  defaultIndexerSettings,
  defaultAgentCapabilityPolicySettings,
  getDownloadSettings,
  getDownloadWorkerHealth,
  getIndexerSettings,
  getModelProviderSettings,
  getMonitoringAlertSummary,
  getMonitoringHealthRouting,
  getNasRoot,
  getOwnedCapabilityRun,
  getPhotostaffAsset,
  getPhotostaffLibrarySettings,
  getPhotostaffLibraryStatus,
  getPhotostaffMapSettings,
  getPhotostaffProcessingSettings,
  getPhotostaffWorkerHealth,
  getAgentCapabilityPolicySettings,
  getAgentMcpSettings,
  getRootReadiness,
  getShareSettings,
  getTerminalTabState,
  getSystemOperations,
  listBackupRuns,
  listDownloadTasks,
  listHealthAlerts,
  listIndexRootStatuses,
  listMonitoringAlertContacts,
  listMonitoringAlertGroups,
  listMonitoringAlertIncidents,
  listMonitoringAlertRules,
  listMonitoringAlertSilences,
  listMonitoringEscalationPolicies,
  listMonitoringOncallSchedules,
  listNasRoots,
  listOperationNotifications,
  listOwnedCapabilityRuns,
  listPhotostaffAssets,
  listRootReadiness,
  type McpClientRecord,
  type ZosDatabase
} from "@zos/db";
import { inferMimeType, statPath } from "@zos/nas-tools";
import type { AgentCapabilityId, AgentCapabilityPolicyMode, DownloadTaskStatus, PublicBuildInfo, ZosConfig } from "@zos/shared";

export interface McpRuntimeDependencies {
  db: ZosDatabase;
  config: ZosConfig;
  buildInfo?: PublicBuildInfo;
  readAdapters?: Readonly<Record<string, (input: JsonValue) => JsonValue | Promise<JsonValue>>>;
  transferBaseUrl?: string;
}

export interface ClientRuntime {
  client: McpClientRecord;
  registry: CapabilityRegistry;
  context: CapabilityContext;
}

const FILE_MUTATION_CAPABILITY = "zos.files.mutate";
const FILE_RESOURCE_LINK_CAPABILITY = "zos.files.resource-link";
const PI_MCP_FILE_CAPABILITIES = new Set<PiMcpFileCapabilityId>([
  "zos.files.list",
  "zos.files.stat",
  "zos.files.read",
  "zos.files.search"
]);

const IMPLEMENTED = new Set([
  "zos.catalog.get",
  "zos.system.status",
  "zos.roots.list",
  "zos.files.list",
  "zos.files.stat",
  "zos.files.read",
  "zos.files.resource-link",
  "zos.files.search",
  "zos.files.mutate",
  "zos.index.status",
  "zos.photos.query",
  "zos.photos.status",
  "zos.downloads.list",
  "zos.operations.list",
  "zos.backup.status",
  "zos.alerts.read",
  "zos.notifications.list",
  "zos.settings.public",
  "zos.terminal.tabs",
  "zos.runs.get",
  "zos.runs.list",
  "zos.runs.wait",
  "zos.runs.cancel"
]);

export function createClientRuntime(dependencies: McpRuntimeDependencies, client: McpClientRecord): ClientRuntime {
  const registry = new CapabilityRegistry();
  const services: Readonly<Record<string, unknown>> = { dependencies };
  const context: CapabilityContext = {
    subject: {
      id: client.id,
      clientId: client.id,
      kind: client.kind,
      scopes: new Set(client.scopes)
    },
    traceId: randomUUID(),
    services
  };
  const policySettings = getAgentCapabilityPolicySettings(dependencies.db) ?? defaultAgentCapabilityPolicySettings();
  for (const base of createCatalogDescriptors()) {
    const agentCapabilityId = agentPolicyCapabilityId(base.id);
    if (base.id === FILE_MUTATION_CAPABILITY && client.kind !== "pi") continue;
    if (
      base.id === FILE_RESOURCE_LINK_CAPABILITY
      && client.kind === "pi"
      && policySettings.policies["zos.files.read"] !== "auto"
    ) continue;
    if (client.kind === "pi" && agentCapabilityId && policySettings.policies[agentCapabilityId] === "disabled") continue;
    const agentPolicy = client.kind === "pi" && agentCapabilityId
      ? policySettings.policies[agentCapabilityId]
      : null;
    const configured = agentPolicy && agentPolicy !== "auto"
      ? { ...base, approval: "first_party" as const }
      : base;
    const descriptor: CapabilityDescriptor = IMPLEMENTED.has(base.id) || dependencies.readAdapters?.[base.id]
      ? { ...configured, execute: (input, executionContext) => executeImplemented(base.id, input, executionContext) }
      : { ...configured, availability: () => ({ available: false, reason: "Domain adapter is not installed" }) };
    registry.register(descriptor);
  }
  return { client, registry, context };
}

export async function invokeCapability(runtime: ClientRuntime, id: string, input: JsonValue): Promise<CapabilityResult> {
  const traceId = randomUUID();
  const execution = await runtime.registry.invoke(id, input, { ...runtime.context, traceId });
  return capabilityResult(execution, traceId);
}

export async function catalogForClient(runtime: ClientRuntime): Promise<JsonValue> {
  const descriptors = runtime.registry.listForScopes(runtime.context.subject.scopes);
  return jsonValue(await Promise.all(descriptors.map(async (descriptor) => {
    const availability = await descriptor.availability?.(runtime.context) ?? { available: true };
    return {
      id: descriptor.id,
      domain: descriptor.domain,
      title: descriptor.title,
      risk: descriptor.risk,
      approval: descriptor.approval,
      requiredScopes: [...descriptor.requiredScopes],
      available: availability.available,
      reason: availability.reason ?? null,
      maxOutputBytes: descriptor.maxOutputBytes
    };
  })));
}

async function executeImplemented(
  id: string,
  input: JsonValue,
  context: CapabilityContext
): Promise<CapabilityExecution> {
  const dependencies = runtimeDependencies(context);
  const object = inputObject(input);
  const policy = piAgentPolicy(dependencies, context, id);
  if (policy === "disabled") {
    throw new CapabilityError("FORBIDDEN", "Capability is disabled by the Agent policy");
  }
  if (context.subject.kind === "pi" && id === FILE_RESOURCE_LINK_CAPABILITY && policy !== "auto") {
    throw new CapabilityError("FORBIDDEN", "File resource links require automatic Agent read access");
  }
  if (context.subject.kind === "pi" && id === FILE_MUTATION_CAPABILITY) {
    const idempotencyKey = optionalString(object.idempotencyKey);
    return proposeFileMutation({
      dependencies,
      subject: context.subject,
      request: object.request ?? null,
      requiresConfirmation: policy === "confirm",
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
  }
  if (context.subject.kind === "pi" && isPiMcpFileCapability(id) && policy && policy !== "auto") {
    return proposePiMcpFileCapability({
      dependencies,
      subject: context.subject,
      capabilityId: id,
      request: input,
      requiresConfirmation: policy === "confirm"
    });
  }
  const adapter = dependencies.readAdapters?.[id];
  if (adapter) {
    try {
      return { data: await adapter(input) };
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      const validation = error instanceof Error && error.name === "MonitoringValidationError";
      throw new CapabilityError(validation ? "INVALID_ARGUMENT" : "NOT_READY", safeErrorMessage(error), {
        retryable: !validation,
        cause: error
      });
    }
  }
  switch (id) {
    case "zos.system.status":
      return { data: systemStatus(dependencies) };
    case "zos.roots.list":
      return { data: rootsStatus(dependencies, optionalString(object.rootId)) };
    case "zos.operations.list":
      return { data: jsonValue(getSystemOperations(dependencies.db, { limit: boundedInteger(object.limit, 20, 1, 100) })) };
    case "zos.backup.status":
      return { data: { enabled: dependencies.config.backup?.enabled ?? false, runs: jsonValue(listBackupRuns(dependencies.db, boundedInteger(object.limit, 20, 1, 100))) } };
    case "zos.index.status":
      return indexStatus(dependencies, object);
    case "zos.photos.status":
      return photosStatus(dependencies);
    case "zos.photos.query":
      return queryPhotos(dependencies, object);
    case "zos.downloads.list":
      return downloadsStatus(dependencies, object);
    case "zos.alerts.read":
      return alertsStatus(dependencies, object);
    case "zos.notifications.list":
      return notificationsStatus(dependencies, object);
    case "zos.settings.public":
      return publicSettings(dependencies);
    case "zos.terminal.tabs":
      return terminalTabs(dependencies, object);
    case "zos.files.list":
    case "zos.files.stat":
    case "zos.files.read":
    case "zos.files.search":
      return executeFileReadCapability(dependencies, id, object);
    case "zos.files.resource-link":
      return createFileResourceLink(dependencies, context.subject.clientId, object);
    case "zos.runs.get":
      return getRun(dependencies, context.subject.clientId, object);
    case "zos.runs.list":
      return listRuns(dependencies, context.subject.clientId, object);
    case "zos.runs.wait":
      return waitForRun(dependencies, context.subject.clientId, object, context.signal);
    case "zos.runs.cancel":
      return cancelRun(dependencies, context.subject.clientId, object);
    default:
      throw new CapabilityError("NOT_READY", "Domain adapter is not installed", { retryable: true });
  }
}

function indexStatus(dependencies: McpRuntimeDependencies, input: Record<string, JsonValue>): CapabilityExecution {
  const rootId = optionalString(input.rootId);
  const roots = listNasRoots(dependencies.db).filter((root) => !rootId || root.id === rootId);
  if (rootId && roots.length === 0) throw new CapabilityError("INVALID_ARGUMENT", "NAS root not found");
  return {
    data: {
      roots: jsonValue(listIndexRootStatuses(dependencies.db, roots.map((root) => root.id))),
      settings: jsonValue(getIndexerSettings(dependencies.db) ?? defaultIndexerSettings())
    }
  };
}

function photosStatus(dependencies: McpRuntimeDependencies): CapabilityExecution {
  const settings = getPhotostaffLibrarySettings(dependencies.db);
  return {
    data: {
      configured: settings !== null,
      library: jsonValue(settings),
      status: jsonValue(getPhotostaffLibraryStatus(dependencies.db, settings)),
      worker: jsonValue(getPhotostaffWorkerHealth(dependencies.db)),
      processing: jsonValue(getPhotostaffProcessingSettings(dependencies.db)),
      map: jsonValue(getPhotostaffMapSettings(dependencies.db))
    }
  };
}

function queryPhotos(dependencies: McpRuntimeDependencies, input: Record<string, JsonValue>): CapabilityExecution {
  const settings = getPhotostaffLibrarySettings(dependencies.db);
  if (!settings) throw new CapabilityError("NOT_READY", "Photo library is not configured", { retryable: true });
  const assetId = optionalString(input.assetId);
  if (assetId) {
    const asset = getPhotostaffAsset(dependencies.db, assetId, settings.updatedAt);
    if (!asset) throw new CapabilityError("INVALID_ARGUMENT", "Photo asset not found");
    return { data: { asset: jsonValue(asset) } };
  }
  const limit = boundedInteger(input.limit, 50, 1, 100);
  const cursor = decodePhotoCursor(optionalString(input.cursor));
  const page = listPhotostaffAssets(dependencies.db, {
    libraryUpdatedAt: settings.updatedAt,
    limit,
    ...(cursor ? { cursor } : {})
  });
  const last = page.photostaff.at(-1);
  return {
    data: { photostaff: jsonValue(page.photostaff) },
    page: {
      limit,
      nextCursor: page.hasMore && last ? encodePhotoCursor(last.takenAt, last.id) : null
    }
  };
}

function downloadsStatus(dependencies: McpRuntimeDependencies, input: Record<string, JsonValue>): CapabilityExecution {
  const limit = boundedInteger(input.limit, 100, 1, 200);
  const statuses = Array.isArray(input.statuses)
    ? input.statuses.filter((status): status is string => typeof status === "string")
    : undefined;
  const tasks = listDownloadTasks(dependencies.db, {
    limit,
    ...(statuses?.length ? { statuses: statuses as DownloadTaskStatus[] } : {})
  }).map((task) => ({
    ...task,
    url: redactUrl(task.url),
    partialPath: null,
    error: task.error ? safeErrorMessage(new Error(task.error)) : null
  }));
  return {
    data: {
      tasks: jsonValue(tasks),
      health: jsonValue(getDownloadWorkerHealth(dependencies.db)),
      settings: jsonValue(getDownloadSettings(dependencies.db) ?? defaultDownloadSettings())
    },
    page: { limit, nextCursor: null }
  };
}

function alertsStatus(dependencies: McpRuntimeDependencies, input: Record<string, JsonValue>): CapabilityExecution {
  const limit = boundedInteger(input.limit, 100, 1, 200);
  const status = optionalString(input.status);
  if (status && status !== "firing" && status !== "resolved") {
    throw new CapabilityError("INVALID_ARGUMENT", "Alert status must be firing or resolved");
  }
  const incidentStatus = status === "firing" || status === "resolved" ? status : undefined;
  return {
    data: {
      summary: jsonValue(getMonitoringAlertSummary(dependencies.db)),
      rules: jsonValue(listMonitoringAlertRules(dependencies.db)),
      incidents: jsonValue(listMonitoringAlertIncidents(dependencies.db, {
        ...(incidentStatus ? { status: incidentStatus } : {}),
        limit
      })),
      silences: jsonValue(listMonitoringAlertSilences(dependencies.db)),
      contacts: jsonValue(listMonitoringAlertContacts(dependencies.db)),
      groups: jsonValue(listMonitoringAlertGroups(dependencies.db)),
      schedules: jsonValue(listMonitoringOncallSchedules(dependencies.db)),
      policies: jsonValue(listMonitoringEscalationPolicies(dependencies.db)),
      healthRouting: jsonValue(getMonitoringHealthRouting(dependencies.db))
    },
    page: { limit, nextCursor: null }
  };
}

function notificationsStatus(dependencies: McpRuntimeDependencies, input: Record<string, JsonValue>): CapabilityExecution {
  const limit = boundedInteger(input.limit, 100, 1, 100);
  return {
    data: {
      notifications: jsonValue(listOperationNotifications(dependencies.db, { limit })),
      unreadCount: countUnreadOperationNotifications(dependencies.db)
    },
    page: { limit, nextCursor: null }
  };
}

function publicSettings(dependencies: McpRuntimeDependencies): CapabilityExecution {
  const model = getModelProviderSettings(dependencies.db);
  const shares = getShareSettings(dependencies.db) ?? {
    ...dependencies.config.shares,
    updatedAt: new Date(0).toISOString()
  };
  return {
    data: jsonValue({
      environment: dependencies.config.environment ?? "production",
      flags: {
        mcpEnabled: dependencies.config.mcp?.enabled ?? false,
        mcpPiEnabled: getAgentMcpSettings(dependencies.db)?.enabled ?? dependencies.config.mcp?.piEnabled ?? false,
        mcpExternalEnabled: dependencies.config.mcp?.externalEnabled ?? false,
        mcpShellEnabled: dependencies.config.mcp?.shellEnabled ?? false,
        dockerEnabled: dependencies.config.docker.enabled,
        vmEnabled: dependencies.config.vm?.enabled ?? false,
        backupEnabled: dependencies.config.backup?.enabled ?? false,
        monitoringEnabled: dependencies.config.monitoring?.enabled ?? false
      },
      model: model ? {
        providerName: model.providerName,
        baseUrl: model.baseUrl ? redactUrl(model.baseUrl) : null,
        model: model.model,
        apiKeyConfigured: Boolean(model.apiKey),
        updatedAt: model.updatedAt
      } : null,
      agentCapabilityPolicy: jsonValue(
        getAgentCapabilityPolicySettings(dependencies.db) ?? defaultAgentCapabilityPolicySettings()
      ),
      indexer: jsonValue(getIndexerSettings(dependencies.db) ?? defaultIndexerSettings()),
      downloads: jsonValue(getDownloadSettings(dependencies.db) ?? defaultDownloadSettings()),
      shares: {
        enabled: shares.enabled,
        account: { username: shares.account.username, passwordConfigured: Boolean(shares.account.password) },
        shares: shares.shares.map((share) => ({ ...share }))
      }
    })
  };
}

function terminalTabs(dependencies: McpRuntimeDependencies, input: Record<string, JsonValue>): CapabilityExecution {
  const rootId = requiredString(input.rootId, "rootId");
  requiredRoot(dependencies.db, rootId);
  return {
    data: jsonValue(getTerminalTabState(dependencies.db, rootId, dependencies.config.terminal.maxSessions ?? 8))
  };
}

function systemStatus(dependencies: McpRuntimeDependencies): JsonValue {
  return {
    build: dependencies.buildInfo ? jsonValue(dependencies.buildInfo) : null,
    environment: dependencies.config.environment ?? "production",
    services: {
      dockerConfigured: dependencies.config.docker.enabled,
      vmConfigured: dependencies.config.vm?.enabled ?? false,
      backupConfigured: dependencies.config.backup?.enabled ?? false,
      monitoringConfigured: dependencies.config.monitoring?.enabled ?? false,
      vodConfigured: dependencies.config.vodPlayer.enabled
    },
    activeHealthAlerts: jsonValue(listHealthAlerts(dependencies.db, { status: "active", limit: 100 })),
    operations: jsonValue(getSystemOperations(dependencies.db, { limit: 10 }))
  };
}

function rootsStatus(dependencies: McpRuntimeDependencies, requestedRootId?: string): JsonValue {
  const roots = listNasRoots(dependencies.db).filter((root) => !requestedRootId || root.id === requestedRootId);
  if (requestedRootId && roots.length === 0) throw new CapabilityError("INVALID_ARGUMENT", "NAS root not found");
  const readiness = new Map(listRootReadiness(dependencies.db, roots.map((root) => root.id)).map((item) => [item.rootId, item]));
  return {
    roots: roots.map((root) => ({
      id: root.id,
      name: root.name,
      mountPolicy: root.mountPolicy ?? "optional",
      readiness: jsonValue(readiness.get(root.id) ?? {
        rootId: root.id,
        status: "unknown",
        checkedAt: null,
        reason: "never checked",
        source: null,
        uuid: null,
        fstype: null
      })
    }))
  };
}

async function createFileResourceLink(
  dependencies: McpRuntimeDependencies,
  clientId: string,
  input: Record<string, JsonValue>
): Promise<CapabilityExecution> {
  const rootId = requiredString(input.rootId, "rootId");
  const requestedPath = requiredString(input.path, "path");
  const root = requiredRoot(dependencies.db, rootId);
  const metadata = await mapFsError(() => statPath(root, requestedPath));
  if (metadata.kind !== "file") throw new CapabilityError("INVALID_ARGUMENT", "Resource links require a regular file");
  if (!dependencies.transferBaseUrl) throw new CapabilityError("NOT_READY", "Transfer URL is unavailable", { retryable: true });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const created = createMcpTransferToken(dependencies.db, {
    clientId,
    rootId,
    relativePath: metadata.path,
    mimeType: inferMimeType(metadata.path),
    sizeBytes: metadata.sizeBytes,
    modifiedAt: metadata.modifiedAt,
    expiresAt
  });
  return {
    data: {
      url: `${dependencies.transferBaseUrl}/mcp-transfer/${created.token}`,
      mimeType: created.transfer.mimeType,
      sizeBytes: created.transfer.sizeBytes,
      expiresAt,
      oneTime: true
    }
  };
}

function getRun(dependencies: McpRuntimeDependencies, clientId: string, input: Record<string, JsonValue>): CapabilityExecution {
  const run = getOwnedCapabilityRun(dependencies.db, clientId, requiredString(input.runId, "runId"));
  if (!run) throw new CapabilityError("INVALID_ARGUMENT", "Capability run not found");
  return { data: publicRun(run) };
}

function listRuns(dependencies: McpRuntimeDependencies, clientId: string, input: Record<string, JsonValue>): CapabilityExecution {
  const limit = boundedInteger(input.limit, 50, 1, 200);
  const before = decodeRunCursor(optionalString(input.cursor));
  const runs = listOwnedCapabilityRuns(dependencies.db, { clientId, limit: limit + 1, ...(before ? { before } : {}) });
  const pageRuns = runs.slice(0, limit);
  const last = pageRuns.at(-1);
  return {
    data: { runs: pageRuns.map(publicRun) },
    page: { limit, nextCursor: runs.length > limit && last ? encodeRunCursor(last.createdAt, last.id) : null }
  };
}

async function waitForRun(
  dependencies: McpRuntimeDependencies,
  clientId: string,
  input: Record<string, JsonValue>,
  signal?: AbortSignal
): Promise<CapabilityExecution> {
  const runId = requiredString(input.runId, "runId");
  const timeoutMs = boundedInteger(input.timeoutMs, 5_000, 0, 20_000);
  const deadline = Date.now() + timeoutMs;
  let run = getOwnedCapabilityRun(dependencies.db, clientId, runId);
  if (!run) throw new CapabilityError("INVALID_ARGUMENT", "Capability run not found");
  while (!isTerminal(run.state) && Date.now() < deadline && !signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    run = getOwnedCapabilityRun(dependencies.db, clientId, runId);
    if (!run) throw new CapabilityError("INVALID_ARGUMENT", "Capability run not found");
  }
  return { data: publicRun(run) };
}

function cancelRun(dependencies: McpRuntimeDependencies, clientId: string, input: Record<string, JsonValue>): CapabilityExecution {
  const runId = requiredString(input.runId, "runId");
  const run = cancelOwnedCapabilityRun(dependencies.db, clientId, runId);
  if (!run) throw new CapabilityError("CONFLICT", "Run is not cancellable or does not exist");
  return { data: publicRun(run), runId: run.id };
}

function publicRun(run: ReturnType<typeof getOwnedCapabilityRun> extends infer T ? Exclude<T, null> : never): JsonValue {
  return {
    id: run.id,
    capabilityId: run.capabilityId,
    state: run.state,
    risk: run.risk,
    progress: run.progress,
    result: run.result,
    error: run.errorCode ? { code: run.errorCode, message: run.errorMessage } : null,
    revision: run.revision,
    cancellable: run.cancellable,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    updatedAt: run.updatedAt
  };
}

function runtimeDependencies(context: CapabilityContext): McpRuntimeDependencies {
  const dependencies = context.services.dependencies;
  if (!dependencies || typeof dependencies !== "object") throw new CapabilityError("INTERNAL", "MCP runtime dependencies are unavailable");
  return dependencies as McpRuntimeDependencies;
}

function piAgentPolicy(
  dependencies: McpRuntimeDependencies,
  context: CapabilityContext,
  capabilityId: string
): AgentCapabilityPolicyMode | null {
  if (context.subject.kind !== "pi") return null;
  const policyCapabilityId = agentPolicyCapabilityId(capabilityId);
  if (!policyCapabilityId) return null;
  const settings = getAgentCapabilityPolicySettings(dependencies.db) ?? defaultAgentCapabilityPolicySettings();
  return settings.policies[policyCapabilityId];
}

function agentPolicyCapabilityId(capabilityId: string): AgentCapabilityId | null {
  switch (capabilityId) {
    case "zos.files.list": return "zos.files.list";
    case "zos.files.stat":
    case "zos.files.read":
    case FILE_RESOURCE_LINK_CAPABILITY: return "zos.files.read";
    case "zos.files.search": return "zos.files.search";
    case FILE_MUTATION_CAPABILITY: return FILE_MUTATION_CAPABILITY;
    default: return null;
  }
}

function isPiMcpFileCapability(capabilityId: string): capabilityId is PiMcpFileCapabilityId {
  return PI_MCP_FILE_CAPABILITIES.has(capabilityId as PiMcpFileCapabilityId);
}

function inputObject(input: JsonValue): Record<string, JsonValue> {
  if (!input || Array.isArray(input) || typeof input !== "object") throw new CapabilityError("INVALID_ARGUMENT", "Tool input must be an object");
  return input;
}

function requiredRoot(db: ZosDatabase, rootId: string) {
  const root = getNasRoot(db, rootId);
  if (!root) throw new CapabilityError("INVALID_ARGUMENT", "NAS root not found");
  if (root.mountPolicy === "required" && getRootReadiness(db, root.id)?.status !== "ready") {
    throw new CapabilityError("NOT_READY", "NAS root is not ready", { retryable: true });
  }
  return root;
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new CapabilityError("INVALID_ARGUMENT", `${field} is required`);
  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedInteger(value: JsonValue | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CapabilityError("INVALID_ARGUMENT", `Integer must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function mapFsError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    const message = safeErrorMessage(error);
    const code = message.toLowerCase().includes("mount") ? "NOT_READY" : "INVALID_ARGUMENT";
    throw new CapabilityError(code, message, { retryable: code === "NOT_READY", cause: error });
  }
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Request failed";
  return error.message.replaceAll(/\/[^\s]+/gu, "[path]").slice(0, 500);
}

function encodeRunCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt, id }), "utf8").toString("base64url");
}

function decodeRunCursor(cursor: string | undefined): { createdAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      parsed.v !== 1
      || typeof parsed.createdAt !== "string"
      || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.id !== "string"
      || !parsed.id
    ) {
      throw new Error();
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new CapabilityError("INVALID_ARGUMENT", "Invalid cursor");
  }
}

function encodePhotoCursor(takenAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, takenAt, id }), "utf8").toString("base64url");
}

function decodePhotoCursor(cursor: string | undefined): { takenAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      takenAt?: unknown;
      id?: unknown;
    };
    if (
      parsed.v !== 1
      || typeof parsed.takenAt !== "string"
      || !Number.isFinite(Date.parse(parsed.takenAt))
      || typeof parsed.id !== "string"
      || !parsed.id
    ) {
      throw new Error();
    }
    return { takenAt: parsed.takenAt, id: parsed.id };
  } catch {
    throw new CapabilityError("INVALID_ARGUMENT", "Invalid photo cursor");
  }
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[configured]";
  }
}

function isTerminal(state: string): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "expired";
}
