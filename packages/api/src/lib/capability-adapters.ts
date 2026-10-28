import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, lstat, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { parseDocument } from "yaml";
import { checkBackup, initBackup, restoreBackup, runBackup, validateBackup } from "@cyberos/backup";
import { CapabilityError, type JsonValue } from "@cyberos/capabilities";
import {
  createRestrictedShellAdapter,
  type CapabilityDomainAdapter,
  type CapabilitySecretRequirement,
  type PreparedCapabilityAction
} from "@cyberos/capability-runtime";
import {
  enqueuePhotostaffJob,
  getNasRoot,
  getPhotostaffLibrarySettings,
  getRootReadiness,
  recordAppliedOperation,
  type CyberOsDatabase
} from "@cyberos/db";
import { isPathInside, resolveSafeExistingPath, resolveSafeTargetPath } from "@cyberos/nas-tools";
import { photostaffMediaKind, type CyberOsConfig } from "@cyberos/shared";
import {
  createFileExportMcpResource,
  createPhotoExportMcpResource,
  fileExportResourceRevision,
  McpResourceError,
  photoExportResourceRevision
} from "./mcp-resources.js";

interface InternalRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: unknown;
}

const MUTATION_CAPABILITIES = [
  "cyberos.system.power-propose",
  "cyberos.operations.run-propose",
  "cyberos.files.export-propose",
  "cyberos.files.edit",
  "cyberos.files.write",
  "cyberos.files.rollback-propose",
  "cyberos.index.reindex-propose",
  "cyberos.photos.manage-propose",
  "cyberos.downloads.manage-propose",
  "cyberos.backup.run-propose",
  "cyberos.alerts.manage-propose",
  "cyberos.notifications.read-state-propose",
  "cyberos.docker.manage-propose",
  "cyberos.docker.console-propose",
  "cyberos.vm.manage-propose",
  "cyberos.vm.console-propose",
  "cyberos.network.manage-propose",
  "cyberos.storage.manage-propose",
  "cyberos.settings.update-propose",
  "cyberos.terminal.manage-propose",
  "cyberos.vod.control-propose"
] as const;

export function createCapabilityAdapters(
  server: FastifyInstance,
  options: { resourceBaseUrl: string }
): Readonly<Record<string, CapabilityDomainAdapter>> {
  const adapters: Record<string, CapabilityDomainAdapter> = {
    "cyberos.shell.run": createRestrictedShellAdapter()
  };
  for (const capabilityId of MUTATION_CAPABILITIES) {
    adapters[capabilityId] = httpDomainAdapter(server, capabilityId, options.resourceBaseUrl);
  }
  return adapters;
}

function httpDomainAdapter(server: FastifyInstance, capabilityId: string, resourceBaseUrl: string): CapabilityDomainAdapter {
  return {
    availability: ({ config }) => capabilityAvailability(capabilityId, config),
    prepare: async (request, context) => {
      const parsed = requestObject(request);
      validateMcpRequest(parsed);
      await validateHostPolicy(capabilityId, parsed, context.config);
      await validateRootReferences(parsed, context.db);
      const revision = await capabilityRevision(context.db, context.config, capabilityId, parsed);
      return {
        summary: capabilitySummary(capabilityId, parsed),
        target: capabilityTarget(parsed),
        changes: parsed,
        revision,
        privatePayload: { request: parsed },
        requiredSecrets: secretRequirements(capabilityId, parsed)
      };
    },
    revalidate: async (prepared, context) => {
      const request = adapterRequest(prepared);
      await validateHostPolicy(capabilityId, request, context.config);
      await validateRootReferences(request, context.db);
      const current = await capabilityRevision(context.db, context.config, capabilityId, request);
      if (prepared.revision && prepared.revision !== current) {
        throw new CapabilityError("CONFLICT", "Domain state changed after approval was requested");
      }
    },
    execute: async (prepared, context, secrets) => {
      const request = adapterRequest(prepared);
      const direct = await executeDirectCapability(
        server,
        capabilityId,
        request,
        secrets,
        context.db,
        context.config,
        context.subject.clientId,
        resourceBaseUrl
      );
      const link = domainLink(direct);
      return { data: direct, ...link };
    }
  };
}

async function executeDirectCapability(
  server: FastifyInstance,
  capabilityId: string,
  request: Record<string, JsonValue>,
  secrets: Readonly<Record<string, string>>,
  db: CyberOsDatabase,
  config: CyberOsConfig,
  clientId: string,
  resourceBaseUrl: string
): Promise<JsonValue> {
  if (capabilityId === "cyberos.files.export-propose") {
    try {
      return await createFileExportMcpResource({
        db,
        clientId,
        baseUrl: resourceBaseUrl,
        rootId: requiredString(request.rootId, "rootId"),
        paths: stringArray(request.paths, "paths"),
        ...(typeof request.archiveName === "string" ? { archiveName: request.archiveName } : {})
      });
    } catch (error) {
      throw resourceCapabilityError(error);
    }
  }
  if (capabilityId === "cyberos.files.edit") return executeFileEdit(server, request);
  if (capabilityId === "cyberos.files.write") return executeFileWrite(db, request);
  if (capabilityId === "cyberos.photos.manage-propose" && request.operation === "export") {
    try {
      return await createPhotoExportMcpResource({
        db,
        clientId,
        baseUrl: resourceBaseUrl,
        assetIds: stringArray(request.assetIds, "assetIds"),
        ...(typeof request.archiveName === "string" ? { archiveName: request.archiveName } : {})
      });
    } catch (error) {
      throw resourceCapabilityError(error);
    }
  }
  if (capabilityId === "cyberos.photos.manage-propose" && request.operation === "import") {
    return importPhotosFromNas(db, request);
  }
  if (capabilityId === "cyberos.backup.run-propose") return executeBackup(db, config, request);
  if (capabilityId === "cyberos.docker.console-propose") {
    const operationResult = await injectJson(server, internalRequest(capabilityId, request, secrets));
    if (!isRecord(operationResult) || !isRecord(operationResult.operation) || typeof operationResult.operation.id !== "string") {
      throw new CapabilityError("INTERNAL", "Docker console operation did not return an operation ID");
    }
    const sessionResult = await injectJson(server, {
      method: "POST",
      url: "/api/docker/console-sessions",
      payload: { operationId: operationResult.operation.id }
    });
    return toJson({ ...operationResult, ...(isRecord(sessionResult) ? sessionResult : { session: sessionResult }) });
  }
  const internal = internalRequest(capabilityId, request, secrets);
  return injectJson(server, internal);
}

function internalRequest(
  capabilityId: string,
  request: Record<string, JsonValue>,
  secrets: Readonly<Record<string, string>>
): InternalRequest {
  const operation = requiredString(request.operation, "operation");
  const body = without(request, "operation");
  switch (capabilityId) {
    case "cyberos.system.power-propose":
      return { method: "POST", url: "/api/system/power", payload: { action: operation, confirmed: true } };
    case "cyberos.operations.run-propose":
      return { method: "POST", url: `/api/system/operations/${encodeURIComponent(operation)}/run`, payload: { confirmed: true } };
    case "cyberos.files.rollback-propose":
      return { method: "POST", url: `/api/operations/${encoded(request.operationId)}/rollback` };
    case "cyberos.index.reindex-propose":
      return { method: "POST", url: "/api/indexer/reindex", payload: body };
    case "cyberos.photos.manage-propose":
      return photoRequest(operation, body);
    case "cyberos.downloads.manage-propose":
      return downloadRequest(operation, request);
    case "cyberos.alerts.manage-propose":
      return alertRequest(operation, request, secrets);
    case "cyberos.notifications.read-state-propose":
      return operation === "read_all"
        ? { method: "POST", url: "/api/notifications/read-all" }
        : { method: "PATCH", url: `/api/notifications/${encoded(request.notificationId)}/read` };
    case "cyberos.docker.manage-propose":
      return dockerRequest(operation, request, secrets);
    case "cyberos.docker.console-propose":
      return { method: "POST", url: "/api/docker/actions", payload: { action: "console", targetType: "console", containerId: request.containerId, shell: request.shell } };
    case "cyberos.vm.manage-propose":
      return vmRequest(operation, request);
    case "cyberos.vm.console-propose":
      return { method: "POST", url: "/api/vms/actions", payload: { action: "console", domainName: request.domainName } };
    case "cyberos.network.manage-propose":
      return networkRequest(operation, request, secrets);
    case "cyberos.storage.manage-propose":
      return storageRequest(operation, request, secrets);
    case "cyberos.settings.update-propose":
      return settingsRequest(operation, request, secrets);
    case "cyberos.terminal.manage-propose":
      return terminalRequest(operation, request);
    case "cyberos.vod.control-propose":
      return { method: "POST", url: "/api/vod-player/command", payload: { type: operation, ...body } };
    default:
      throw new CapabilityError("NOT_READY", "Capability execution adapter is not installed", { retryable: true });
  }
}

function photoRequest(operation: string, body: Record<string, JsonValue>): InternalRequest {
  switch (operation) {
    case "configure": return { method: "PUT", url: "/api/photos/settings", payload: body };
    case "processing": return { method: "PATCH", url: "/api/settings/photos", payload: body };
    case "scan": return { method: "POST", url: "/api/photos/scans" };
    case "move": return { method: "POST", url: "/api/photos/actions", payload: { operation: "move", assetIds: body.assetIds, targetDirectory: body.targetDirectory } };
    case "trash": return { method: "POST", url: "/api/photos/actions", payload: { operation: "trash", assetIds: body.assetIds } };
    default: throw invalidOperation("photo", operation);
  }
}

function downloadRequest(operation: string, request: Record<string, JsonValue>): InternalRequest {
  if (operation === "create") {
    return { method: "POST", url: "/api/downloads", payload: {
      url: request.url,
      rootId: request.rootId,
      storagePoolId: request.storagePoolId,
      targetDirectory: request.targetDirectory,
      fileName: request.fileName,
      sha256: request.sha256
    } };
  }
  if (operation === "settings") return { method: "PATCH", url: "/api/settings/downloads", payload: without(request, "operation") };
  if (!["pause", "resume", "cancel", "retry", "delete"].includes(operation)) throw invalidOperation("download", operation);
  return {
    method: operation === "delete" ? "DELETE" : "POST",
    url: `/api/downloads/${encoded(request.taskId)}${operation === "delete" ? "" : `/${operation}`}`
  };
}

function dockerRequest(
  operation: string,
  request: Record<string, JsonValue>,
  secrets: Readonly<Record<string, string>>
): InternalRequest {
  switch (operation) {
    case "create_container": return { method: "POST", url: "/api/docker/actions", payload: {
      action: "create",
      targetType: "container",
      ...without(request, "operation")
    } };
    case "create_volume": return { method: "POST", url: "/api/docker/actions", payload: { action: "create", targetType: "volume", ...without(request, "operation") } };
    case "create_network": return { method: "POST", url: "/api/docker/actions", payload: { action: "create", targetType: "network", ...without(request, "operation") } };
    case "container_action": return { method: "POST", url: "/api/docker/actions", payload: { action: request.action, targetType: "container", containerId: request.containerId } };
    case "compose_create": return { method: "POST", url: "/api/docker/apps", payload: { name: request.name, projectKey: request.projectKey, composeContent: request.composeContent, environment: [] } };
    case "compose_update": return { method: "PUT", url: `/api/docker/apps/${encoded(request.appId)}`, payload: { name: request.name, composeContent: request.composeContent, environment: [], expectedRevision: request.expectedRevision } };
    case "compose_delete": return { method: "DELETE", url: `/api/docker/apps/${encoded(request.appId)}`, payload: { expectedRevision: request.expectedRevision, confirmed: true } };
    case "compose_action": return { method: "POST", url: "/api/docker/actions", payload: { action: composeAction(request.action), targetType: "compose_project", composeProjectId: request.appId, service: request.service } };
    case "image_pull": return { method: "POST", url: "/api/docker/images/pull", payload: { reference: request.image } };
    case "image_remove": return { method: "POST", url: "/api/docker/images/remove", payload: { reference: request.image, confirmed: true } };
    case "registry_create": return { method: "POST", url: "/api/docker/registries", payload: { name: request.name, serverAddress: request.serverAddress, username: request.username ?? "", password: secrets.registryPassword } };
    case "registry_update": return { method: "PATCH", url: `/api/docker/registries/${encoded(request.registryId)}`, payload: { name: request.name, serverAddress: request.serverAddress, username: request.username, ...(secrets.registryPassword ? { password: secrets.registryPassword } : {}) } };
    case "registry_delete": return { method: "DELETE", url: `/api/docker/registries/${encoded(request.registryId)}` };
    case "daemon_update": return { method: "PUT", url: "/api/docker/daemon/config", payload: { content: request.content, expectedRevision: request.expectedRevision, restart: request.restart === true, confirmed: true } };
    default: throw invalidOperation("Docker", operation);
  }
}

function vmRequest(operation: string, request: Record<string, JsonValue>): InternalRequest {
  let action = operation;
  const payload: Record<string, JsonValue> = { ...without(request, "operation") };
  if (operation === "snapshot_create") action = "snapshot";
  else if (operation === "snapshot_revert") action = "snapshot_revert";
  else if (operation === "snapshot_delete") action = "snapshot_delete";
  return { method: "POST", url: "/api/vms/actions", payload: { action, ...payload } };
}

function networkRequest(
  operation: string,
  request: Record<string, JsonValue>,
  secrets: Readonly<Record<string, string>>
): InternalRequest {
  switch (operation) {
    case "ethernet_stage": return { method: "PUT", url: `/api/system/network/ethernet/${encoded(request.deviceId)}`, payload: { config: request.config, expectedRevision: request.expectedRevision } };
    case "ethernet_apply": return { method: "POST", url: "/api/system/network/ethernet/apply", payload: { confirmed: true } };
    case "ethernet_confirm": return { method: "POST", url: `/api/system/network/ethernet/apply/${encoded(request.transactionId)}/confirm` };
    case "ethernet_rollback": return { method: "POST", url: `/api/system/network/ethernet/apply/${encoded(request.transactionId)}/rollback` };
    case "wifi_connect": return { method: "POST", url: "/api/system/network/wifi/connect", payload: { ...without(request, "operation"), ...(secrets.wifiPassword ? { password: secrets.wifiPassword } : {}), confirmed: true } };
    case "wifi_disconnect": return { method: "POST", url: "/api/system/network/wifi/disconnect", payload: { device: request.device, confirmed: true } };
    case "wifi_radio": return { method: "PUT", url: "/api/system/network/wifi/radio", payload: { enabled: request.enabled, confirmed: true } };
    case "wifi_profile": return { method: "PATCH", url: `/api/system/network/wifi/profiles/${encoded(request.connectionId)}`, payload: { ...without(request, "operation", "connectionId", "replacePassword"), ...(secrets.wifiPassword ? { password: secrets.wifiPassword } : {}), confirmed: true } };
    case "hotspot": return { method: "PUT", url: "/api/system/network/wifi/hotspot", payload: { ...without(request, "operation", "replacePassword"), ...(secrets.wifiPassword ? { password: secrets.wifiPassword } : {}), confirmed: true } };
    case "hotspot_start": return { method: "POST", url: "/api/system/network/wifi/hotspot/start", payload: { device: request.device, confirmed: true } };
    case "hotspot_stop": return { method: "POST", url: "/api/system/network/wifi/hotspot/stop", payload: { device: request.device, confirmed: true } };
    case "hotspot_delete": return { method: "DELETE", url: "/api/system/network/wifi/hotspot", payload: { device: request.device, confirmed: true } };
    default: throw invalidOperation("network", operation);
  }
}

function storageRequest(
  operation: string,
  request: Record<string, JsonValue>,
  secrets: Readonly<Record<string, string>>
): InternalRequest {
  switch (operation) {
    case "pool_create": return { method: "POST", url: "/api/storage/actions", payload: { action: "create_pool", name: request.name, raidLevel: request.level, devices: request.deviceIds, filesystem: request.filesystem, confirm: true } };
    case "pool_delete": return { method: "POST", url: "/api/storage/actions", payload: { action: "delete_pool", poolId: request.poolId, confirmation: request.confirmation, confirm: true } };
    case "shares_update": return { method: "POST", url: "/api/shares/settings", payload: { settings: { enabled: request.enabled, shares: request.shares } } };
    case "share_account": return { method: "PUT", url: "/api/shares/account", payload: { username: request.username, password: secrets.sharePassword, expectedUpdatedAt: request.expectedUpdatedAt } };
    default: throw invalidOperation("storage", operation);
  }
}

function settingsRequest(
  operation: string,
  request: Record<string, JsonValue>,
  secrets: Readonly<Record<string, string>>
): InternalRequest {
  const body = without(request, "operation");
  if (operation === "indexer") return { method: "PATCH", url: "/api/settings/indexer", payload: body };
  if (operation === "agent_policy") return { method: "PATCH", url: "/api/settings/agent-capability-policy", payload: { policies: request.policies } };
  if (operation === "model_provider") return { method: "PATCH", url: "/api/settings/model-provider", payload: { ...without(body, "replaceApiKey"), ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}) } };
  throw invalidOperation("settings", operation);
}

function terminalRequest(operation: string, request: Record<string, JsonValue>): InternalRequest {
  switch (operation) {
    case "create": return { method: "POST", url: "/api/terminal/tabs", payload: { rootId: request.rootId } };
    case "rename": return { method: "PATCH", url: `/api/terminal/tabs/${encoded(request.tabId)}`, payload: { customTitle: request.customTitle } };
    case "activate": return { method: "POST", url: `/api/terminal/tabs/${encoded(request.tabId)}/activate` };
    case "restart": return { method: "POST", url: `/api/terminal/tabs/${encoded(request.tabId)}/restart` };
    case "close": return { method: "DELETE", url: `/api/terminal/tabs/${encoded(request.tabId)}` };
    default: throw invalidOperation("terminal", operation);
  }
}

function alertRequest(
  operation: string,
  request: Record<string, JsonValue>,
  secrets: Readonly<Record<string, string>>
): InternalRequest {
  const id = request.id;
  const revision = request.expectedRevision;
  switch (operation) {
    case "create_rule": return { method: "POST", url: "/api/monitoring/alerts/rules", payload: request.rule! };
    case "update_rule": return { method: "PATCH", url: `/api/monitoring/alerts/rules/${encoded(id)}`, payload: { rule: request.rule, expectedRevision: revision } };
    case "delete_rule": return deleteWithRevision("/api/monitoring/alerts/rules", id, revision);
    case "acknowledge_incident": return { method: "POST", url: `/api/monitoring/alerts/incidents/${encoded(id)}/acknowledge` };
    case "create_silence": return { method: "POST", url: "/api/monitoring/alerts/silences", payload: without(request, "operation") };
    case "delete_silence": return deleteWithRevision("/api/monitoring/alerts/silences", id, revision);
    case "create_contact": return { method: "POST", url: "/api/monitoring/alerts/contacts", payload: without(request, "operation") };
    case "update_contact": return { method: "PATCH", url: `/api/monitoring/alerts/contacts/${encoded(id)}`, payload: { contact: without(request, "operation", "id", "expectedRevision"), expectedRevision: revision } };
    case "delete_contact": return deleteWithRevision("/api/monitoring/alerts/contacts", id, revision);
    case "update_smtp": return { method: "PATCH", url: "/api/monitoring/alerts/smtp", payload: { smtp: { ...without(request, "operation", "expectedRevision", "replacePassword"), ...(secrets.smtpPassword ? { password: secrets.smtpPassword } : {}) }, expectedRevision: revision } };
    case "test_email": return { method: "POST", url: "/api/monitoring/alerts/test-email", payload: { recipient: request.recipient } };
    case "create_group": return { method: "POST", url: "/api/monitoring/alerts/groups", payload: without(request, "operation") };
    case "update_group": return { method: "PATCH", url: `/api/monitoring/alerts/groups/${encoded(id)}`, payload: { group: without(request, "operation", "id", "expectedRevision"), expectedRevision: revision } };
    case "delete_group": return deleteWithRevision("/api/monitoring/alerts/groups", id, revision);
    case "create_schedule": return { method: "POST", url: "/api/monitoring/alerts/schedules", payload: without(request, "operation") };
    case "update_schedule": return { method: "PATCH", url: `/api/monitoring/alerts/schedules/${encoded(id)}`, payload: { schedule: without(request, "operation", "id", "expectedRevision"), expectedRevision: revision } };
    case "delete_schedule": return deleteWithRevision("/api/monitoring/alerts/schedules", id, revision);
    case "create_override": return { method: "POST", url: `/api/monitoring/alerts/schedules/${encoded(request.scheduleId)}/overrides`, payload: without(request, "operation", "scheduleId") };
    case "delete_override": return deleteWithRevision("/api/monitoring/alerts/overrides", request.overrideId, revision);
    case "create_policy": return { method: "POST", url: "/api/monitoring/alerts/policies", payload: without(request, "operation") };
    case "update_policy": return { method: "PATCH", url: `/api/monitoring/alerts/policies/${encoded(id)}`, payload: { policy: without(request, "operation", "id", "expectedRevision"), expectedRevision: revision } };
    case "delete_policy": return deleteWithRevision("/api/monitoring/alerts/policies", id, revision);
    case "update_health_routing": return { method: "PATCH", url: "/api/monitoring/alerts/health-routing", payload: { routing: without(request, "operation", "expectedRevision"), expectedRevision: revision } };
    default: throw invalidOperation("alert", operation);
  }
}

async function executeFileEdit(server: FastifyInstance, request: Record<string, JsonValue>): Promise<JsonValue> {
  const rootId = requiredString(request.rootId, "rootId");
  const filePath = requiredString(request.path, "path");
  const current = await injectJson(server, {
    method: "GET",
    url: `/api/files/edit-text?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(filePath)}`
  });
  if (!isRecord(current) || typeof current.content !== "string") throw new CapabilityError("INVALID_ARGUMENT", "File is not editable text");
  if (typeof request.expectedSha256 === "string") {
    const digest = createHash("sha256").update(current.content, "utf8").digest("hex");
    if (digest !== request.expectedSha256.toLowerCase()) {
      throw new CapabilityError("CONFLICT", "File changed after it was read");
    }
  }
  const find = requiredString(request.find, "find", false);
  const replacement = typeof request.replace === "string" ? request.replace : "";
  const occurrences = current.content.split(find).length - 1;
  if (occurrences === 0) throw new CapabilityError("CONFLICT", "Edit text no longer exists in the file");
  if (request.replaceAll !== true && occurrences !== 1) throw new CapabilityError("CONFLICT", "Edit text is not unique; set replaceAll to replace every match");
  const content = request.replaceAll === true ? current.content.split(find).join(replacement) : current.content.replace(find, replacement);
  return injectJson(server, { method: "PUT", url: "/api/files/edit-text", payload: { rootId, path: filePath, content, expectedModifiedAt: current.modifiedAt ?? null } });
}

async function executeFileWrite(db: CyberOsDatabase, request: Record<string, JsonValue>): Promise<JsonValue> {
  const root = requireReadyRoot(db, requiredString(request.rootId, "rootId"));
  const requestedPath = requiredString(request.path, "path");
  const content = typeof request.content === "string" ? request.content : null;
  if (content === null || Buffer.byteLength(content, "utf8") > 1_048_576) throw new CapabilityError("INVALID_ARGUMENT", "File content exceeds the 1 MiB limit");
  const target = await resolveSafeTargetPath(root.path, requestedPath);
  const parent = await resolveSafeExistingPath(root.path, path.dirname(target.relativePath));
  if (!(await stat(parent.realPath)).isDirectory()) throw new CapabilityError("INVALID_ARGUMENT", "File parent must be a directory");
  let existed = false;
  try {
    const existing = await resolveSafeExistingPath(root.path, requestedPath);
    const metadata = await lstat(existing.absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new CapabilityError("INVALID_ARGUMENT", "Write target must be a regular file");
    existed = true;
    if (request.createOnly === true) throw new CapabilityError("CONFLICT", "Write target already exists");
    if (typeof request.expectedSha256 === "string") {
      const digest = createHash("sha256").update(await readFile(existing.realPath)).digest("hex");
      if (digest !== request.expectedSha256.toLocaleLowerCase()) throw new CapabilityError("CONFLICT", "Write target changed after it was read");
    }
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent.realPath, `.${path.basename(target.absolutePath)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    if (existed) await rename(temporary, target.absolutePath);
    else {
      await link(temporary, target.absolutePath);
      await unlink(temporary);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const operation = recordAppliedOperation(db, {
    approvalId: null,
    operation: "edit",
    sourcePath: target.relativePath,
    targetPath: target.relativePath,
    status: "applied",
    metadata: { rootId: root.id, reversible: false, created: !existed, sizeBytes: Buffer.byteLength(content, "utf8") }
  });
  return toJson({ path: target.relativePath, created: !existed, sizeBytes: Buffer.byteLength(content, "utf8"), operation });
}

async function importPhotosFromNas(db: CyberOsDatabase, request: Record<string, JsonValue>): Promise<JsonValue> {
  const plan = await resolvePhotoImportPlan(db, request);
  const imported: JsonValue[] = [];
  for (const item of plan.items) {
    await copyFile(item.source.realPath, item.target.absolutePath, 1);
    const operation = recordAppliedOperation(db, {
      approvalId: null,
      operation: "copy",
      sourcePath: item.source.relativePath,
      targetPath: item.target.relativePath,
      status: "applied",
      metadata: {
        rootId: plan.libraryRoot.id,
        storagePoolId: plan.settings.storagePoolId,
        sourceRootId: plan.sourceRoot.id,
        reversible: true,
        photoImport: true
      }
    });
    imported.push({ path: item.target.relativePath, operationId: operation.id });
  }
  const job = enqueuePhotostaffJob(db, { settings: plan.settings, kind: "full_scan", path: plan.settings.path });
  return toJson({ imported, job });
}

async function resolvePhotoImportPlan(db: CyberOsDatabase, request: Record<string, JsonValue>) {
  const settings = getPhotostaffLibrarySettings(db);
  if (!settings) throw new CapabilityError("NOT_READY", "Photo library is not configured", { retryable: true });
  const sourceRoot = requireReadyRoot(db, requiredString(request.sourceRootId, "sourceRootId"));
  const libraryRoot = requireReadyRoot(db, settings.rootId);
  const libraryDirectory = await resolveSafeExistingPath(libraryRoot.path, settings.path);
  const destinationDirectory = await resolveSafeExistingPath(
    libraryRoot.path,
    typeof request.targetDirectory === "string" ? request.targetDirectory : settings.path
  );
  if (
    !(await stat(destinationDirectory.realPath)).isDirectory() ||
    !isPathInside(libraryDirectory.realPath, destinationDirectory.realPath)
  ) {
    throw new CapabilityError("INVALID_ARGUMENT", "Photo import target must be a directory inside the configured photo library");
  }
  const targetPaths = new Set<string>();
  const items = [];
  for (const sourcePath of stringArray(request.sourcePaths, "sourcePaths")) {
    const source = await resolveSafeExistingPath(sourceRoot.path, sourcePath);
    const sourceStat = await lstat(source.absolutePath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || !photostaffMediaKind(source.relativePath)) {
      throw new CapabilityError("INVALID_ARGUMENT", "Photo import sources must be supported regular media files");
    }
    const target = await resolveSafeTargetPath(
      libraryRoot.path,
      path.join(destinationDirectory.relativePath, path.basename(source.realPath))
    );
    if (!isPathInside(libraryDirectory.realPath, target.absolutePath) || targetPaths.has(target.relativePath)) {
      throw new CapabilityError("CONFLICT", "Photo import targets must be unique and stay inside the configured library");
    }
    targetPaths.add(target.relativePath);
    try {
      await lstat(target.absolutePath);
      throw new CapabilityError("CONFLICT", `Photo import target already exists: ${path.basename(target.relativePath)}`);
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    items.push({ source, target });
  }
  return { settings, sourceRoot, libraryRoot, destinationDirectory, items };
}

async function executeBackup(db: CyberOsDatabase, config: CyberOsConfig, request: Record<string, JsonValue>): Promise<JsonValue> {
  const operation = requiredString(request.operation, "operation");
  if (operation === "validate") return toJson(await validateBackup({ db, config }));
  if (operation === "init") {
    await initBackup({ db, config });
    return { initialized: true };
  }
  if (operation === "run") return toJson(await runBackup({ db, config, kind: request.schedule === "weekly" ? "weekly" : "daily" }));
  if (operation === "check") return toJson(await checkBackup({ db, config }));
  if (operation === "restore") return toJson(await restoreBackup({ db, config, snapshot: requiredString(request.snapshotId, "snapshotId") }));
  throw invalidOperation("backup", operation);
}

async function injectJson(server: FastifyInstance, request: InternalRequest): Promise<JsonValue> {
  const response = request.payload === undefined
    ? await server.inject({ method: request.method, url: request.url })
    : await server.inject({ method: request.method, url: request.url, payload: request.payload as string | object });
  return parseInternalResponse(response.statusCode, response.body);
}

function parseInternalResponse(statusCode: number, body: string): JsonValue {
  let parsed: JsonValue = null;
  if (body) {
    try { parsed = JSON.parse(body) as JsonValue; } catch { parsed = { error: "Domain service returned an invalid response" }; }
  }
  if (statusCode < 400) return parsed;
  const message = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : `Domain service failed with status ${statusCode}`;
  if (statusCode === 409) throw new CapabilityError("CONFLICT", message);
  if (statusCode === 401 || statusCode === 403) throw new CapabilityError("FORBIDDEN", message);
  if (statusCode === 501 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    throw new CapabilityError("NOT_READY", message, { retryable: statusCode !== 501 });
  }
  if (statusCode >= 400 && statusCode < 500) throw new CapabilityError("INVALID_ARGUMENT", message);
  throw new CapabilityError("INTERNAL", "Domain service execution failed");
}

function resourceCapabilityError(error: unknown): CapabilityError {
  if (!(error instanceof McpResourceError)) {
    return new CapabilityError("INTERNAL", "Resource link creation failed", { cause: error });
  }
  if (error.statusCode === 409) return new CapabilityError("CONFLICT", error.message, { cause: error });
  if (error.statusCode >= 500) return new CapabilityError("NOT_READY", error.message, { retryable: true, cause: error });
  return new CapabilityError("INVALID_ARGUMENT", error.message, { cause: error });
}

function capabilityAvailability(capabilityId: string, config: CyberOsConfig) {
  if (capabilityId.startsWith("cyberos.docker.")) return config.docker.enabled
    ? { available: true }
    : { available: false, reason: "Docker management is disabled" };
  if (capabilityId.startsWith("cyberos.vm.")) return config.vm?.enabled
    ? { available: true }
    : { available: false, reason: "Virtual machine management is disabled" };
  if (capabilityId === "cyberos.vod.control-propose") return config.vodPlayer.enabled
    ? { available: true }
    : { available: false, reason: "VOD Player is disabled" };
  if (capabilityId === "cyberos.backup.run-propose") return config.backup?.enabled
    ? { available: true }
    : { available: false, reason: "Backup is disabled" };
  if (
    (capabilityId === "cyberos.network.manage-propose" || capabilityId === "cyberos.storage.manage-propose") &&
    config.hostd.mutationPolicy === "declarative"
  ) return { available: false, reason: "Host configuration is managed declaratively" };
  return { available: true };
}

async function validateHostPolicy(capabilityId: string, request: Record<string, JsonValue>, config: CyberOsConfig): Promise<void> {
  if (config.hostd.mutationPolicy !== "declarative") return;
  if (capabilityId === "cyberos.network.manage-propose" || capabilityId === "cyberos.storage.manage-propose") {
    throw new CapabilityError("NOT_READY", "Host configuration is managed declaratively");
  }
  if (capabilityId === "cyberos.docker.manage-propose" && request.operation === "daemon_update") {
    throw new CapabilityError("NOT_READY", "Docker daemon configuration is managed declaratively");
  }
}

function validateMcpRequest(request: Record<string, JsonValue>): void {
  if (request.operation === "model_provider" && request.replaceApiKey === true && request.clearApiKey === true) {
    throw new CapabilityError("INVALID_ARGUMENT", "Model API key cannot be replaced and cleared in the same request");
  }
  for (const field of ["url", "baseUrl", "serverAddress"] as const) {
    const value = request[field];
    if (typeof value !== "string" || !value) continue;
    let parsed: URL;
    try {
      parsed = new URL(field === "serverAddress" && !value.includes("://") ? `https://${value}` : value);
    } catch {
      throw new CapabilityError("INVALID_ARGUMENT", `${field} must be a valid URL or registry address`);
    }
    if (parsed.username || parsed.password) {
      throw new CapabilityError("INVALID_ARGUMENT", `${field} cannot contain embedded credentials`);
    }
  }
  if (typeof request.composeContent === "string") {
    const document = parseDocument(request.composeContent);
    if (document.errors.length) throw new CapabilityError("INVALID_ARGUMENT", "Compose YAML is invalid");
    rejectComposeCredentials(document.toJS({ maxAliasCount: 20 }));
  }
}

function rejectComposeCredentials(value: unknown, pathSegments: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectComposeCredentials(item, [...pathSegments, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-_]/gu, "").toLowerCase();
    if (
      normalized === "secrets" || normalized === "password" || normalized === "passphrase" ||
      normalized === "apikey" || normalized === "token" || normalized === "credential"
    ) {
      throw new CapabilityError(
        "INVALID_ARGUMENT",
        `Compose credential field ${[...pathSegments, key].join(".")} must be configured locally`
      );
    }
    rejectComposeCredentials(item, [...pathSegments, key]);
  }
}

async function validateRootReferences(request: Record<string, JsonValue>, db: CyberOsDatabase): Promise<void> {
  for (const reference of rootReferences(request)) requireReadyRoot(db, reference.rootId);
}

async function capabilityRevision(
  db: CyberOsDatabase,
  config: CyberOsConfig,
  capabilityId: string,
  request: Record<string, JsonValue>
): Promise<string> {
  const rootStates = rootReferences(request).map(({ field, rootId }) => {
    const root = getNasRoot(db, rootId);
    const readiness = getRootReadiness(db, rootId);
    return { field, rootId, enabled: root?.enabled ?? false, readiness: readiness?.status ?? null, checkedAt: readiness?.checkedAt ?? null };
  });
  const tables = revisionTables(capabilityId);
  const tableStates = tables.map((table) => {
    try {
      return toJson(db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS updatedAt FROM ${table}`).get());
    } catch {
      return null;
    }
  });
  const resourceState = await capabilityResourceState(db, capabilityId, request);
  return createHash("sha256").update(JSON.stringify({
    capabilityId,
    operation: request.operation,
    hostMutationPolicy: config.hostd.mutationPolicy ?? "mutable",
    rootStates,
    tableStates,
    resourceState
  })).digest("base64url");
}

function rootReferences(value: JsonValue, prefix = "request"): Array<{ field: string; rootId: string }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => rootReferences(item, `${prefix}[${index}]`));
  if (!isRecord(value)) return [];
  const references: Array<{ field: string; rootId: string }> = [];
  for (const [key, item] of Object.entries(value)) {
    const field = `${prefix}.${key}`;
    if (["rootId", "sourceRootId", "targetRootId", "isoRootId"].includes(key) && typeof item === "string") {
      references.push({ field, rootId: item });
    }
    if (Array.isArray(item) || isRecord(item)) references.push(...rootReferences(item, field));
  }
  return [...new Map(references.map((reference) => [`${reference.field}\0${reference.rootId}`, reference])).values()];
}

async function capabilityResourceState(
  db: CyberOsDatabase,
  capabilityId: string,
  request: Record<string, JsonValue>
): Promise<JsonValue> {
  if (capabilityId === "cyberos.files.edit" || capabilityId === "cyberos.files.write") {
    const root = requireReadyRoot(db, requiredString(request.rootId, "rootId"));
    return toJson(await fileTargetState(
      root.path,
      requiredString(request.path, "path"),
      capabilityId === "cyberos.files.write"
    ));
  }
  if (capabilityId === "cyberos.files.export-propose") {
    try {
      return await fileExportResourceRevision(
        db,
        requiredString(request.rootId, "rootId"),
        stringArray(request.paths, "paths")
      );
    } catch (error) {
      throw resourceCapabilityError(error);
    }
  }
  if (capabilityId === "cyberos.photos.manage-propose" && request.operation === "export") {
    try {
      return await photoExportResourceRevision(db, stringArray(request.assetIds, "assetIds"));
    } catch (error) {
      throw resourceCapabilityError(error);
    }
  }
  if (capabilityId === "cyberos.photos.manage-propose" && request.operation === "import") {
    const plan = await resolvePhotoImportPlan(db, request);
    return toJson({
      settingsUpdatedAt: plan.settings.updatedAt,
      destination: await fileSystemState(plan.destinationDirectory.realPath),
      items: await Promise.all(plan.items.map(async (item) => ({
        source: item.source.relativePath,
        sourceState: await fileSystemState(item.source.realPath),
        target: item.target.relativePath,
        targetState: "missing"
      })))
    });
  }
  return null;
}

async function fileTargetState(
  rootPath: string,
  requestedPath: string,
  allowMissing: boolean
): Promise<JsonValue> {
  try {
    const safe = await resolveSafeExistingPath(rootPath, requestedPath);
    const metadata = await lstat(safe.absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new CapabilityError("INVALID_ARGUMENT", "File target must be a regular file");
    }
    const state = await fileSystemState(safe.realPath);
    if (metadata.size <= 1_048_576) {
      return toJson({ ...state, sha256: createHash("sha256").update(await readFile(safe.realPath)).digest("hex") });
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!allowMissing) throw new CapabilityError("INVALID_ARGUMENT", "File target was not found");
    const target = await resolveSafeTargetPath(rootPath, requestedPath);
    const parent = await resolveSafeExistingPath(rootPath, path.dirname(target.relativePath));
    return toJson({ path: target.relativePath, state: "missing", parent: await fileSystemState(parent.realPath) });
  }
}

async function fileSystemState(filePath: string): Promise<Record<string, JsonValue>> {
  const metadata = await lstat(filePath);
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ino: metadata.ino,
    mode: metadata.mode,
    kind: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other"
  };
}

function revisionTables(capabilityId: string): string[] {
  if (capabilityId.startsWith("cyberos.files.")) return ["file_operations", "trash_entries"];
  if (capabilityId.startsWith("cyberos.photos.")) return ["photostaff_assets", "photostaff_jobs", "system_settings"];
  if (capabilityId.startsWith("cyberos.downloads.")) return ["download_tasks", "system_settings"];
  if (capabilityId.startsWith("cyberos.alerts.")) return ["monitoring_alert_rules", "monitoring_alert_incidents", "system_settings"];
  if (capabilityId.startsWith("cyberos.notifications.")) return ["operation_notifications"];
  if (capabilityId.startsWith("cyberos.docker.")) return ["docker_operations", "docker_compose_apps", "docker_registry_credentials", "system_settings"];
  if (capabilityId.startsWith("cyberos.vm.")) return ["vm_operations"];
  if (capabilityId.startsWith("cyberos.settings.")) return ["system_settings"];
  if (capabilityId.startsWith("cyberos.terminal.")) return ["terminal_tabs"];
  return [];
}

function secretRequirements(capabilityId: string, request: Record<string, JsonValue>): CapabilitySecretRequirement[] {
  const operation = request.operation;
  if (capabilityId === "cyberos.network.manage-propose" && (
    (operation === "wifi_connect" && request.profileId === undefined && request.security !== "open") ||
    (operation === "wifi_profile" && request.replacePassword === true && request.security !== "open") ||
    (operation === "hotspot" && request.replacePassword === true)
  )) return [{ name: "wifiPassword", label: "Wi-Fi password", minLength: 8, maxLength: 63 }];
  if (capabilityId === "cyberos.alerts.manage-propose" && operation === "update_smtp" && request.replacePassword === true) {
    return [{ name: "smtpPassword", label: "SMTP password", maxLength: 1024 }];
  }
  if (capabilityId === "cyberos.docker.manage-propose" && operation === "registry_create") {
    return [{ name: "registryPassword", label: "Registry password", maxLength: 4096 }];
  }
  if (capabilityId === "cyberos.docker.manage-propose" && operation === "registry_update" && request.replacePassword === true) {
    return [{ name: "registryPassword", label: "Registry password", maxLength: 4096 }];
  }
  if (capabilityId === "cyberos.settings.update-propose" && operation === "model_provider" && request.replaceApiKey === true) {
    return [{ name: "apiKey", label: "Model API key", maxLength: 4096 }];
  }
  if (capabilityId === "cyberos.storage.manage-propose" && operation === "share_account") {
    return [{ name: "sharePassword", label: "Share account password", maxLength: 256 }];
  }
  return [];
}

function capabilitySummary(capabilityId: string, request: Record<string, JsonValue>): string {
  const operation = requiredString(request.operation, "operation");
  const target = [request.path, request.taskId, request.containerId, request.appId, request.domainName, request.connectionId, request.poolId, request.tabId, request.id]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const title = capabilityId.replace(/^cyberos\./u, "").replace(/-propose$/u, "").replaceAll(".", " ");
  return `${title}: ${operation.replaceAll("_", " ")}${target ? ` (${target})` : ""}`;
}

function capabilityTarget(request: Record<string, JsonValue>): JsonValue {
  return toJson({
    ...(typeof request.rootId === "string" ? { rootId: request.rootId } : {}),
    ...(typeof request.path === "string" ? { path: request.path } : {}),
    ...(typeof request.taskId === "string" ? { taskId: request.taskId } : {}),
    ...(typeof request.containerId === "string" ? { containerId: request.containerId } : {}),
    ...(typeof request.domainName === "string" ? { domainName: request.domainName } : {})
  });
}

function adapterRequest(prepared: PreparedCapabilityAction): Record<string, JsonValue> {
  if (!isRecord(prepared.privatePayload) || !isRecord(prepared.privatePayload.request)) {
    throw new CapabilityError("INTERNAL", "Stored capability payload is invalid");
  }
  return prepared.privatePayload.request;
}

function domainLink(result: JsonValue): { domainOperationType?: string; domainOperationId?: string } {
  if (!isRecord(result)) return {};
  for (const [key, type] of [["operation", "operation"], ["job", "job"], ["task", "download"], ["delivery", "alert_delivery"]] as const) {
    const value = result[key];
    if (isRecord(value) && typeof value.id === "string") return { domainOperationType: type, domainOperationId: value.id };
  }
  if (typeof result.operationId === "string") return { domainOperationType: "file_operation", domainOperationId: result.operationId };
  if (typeof result.deliveryId === "string") return { domainOperationType: "alert_delivery", domainOperationId: result.deliveryId };
  return {};
}

function deleteWithRevision(base: string, id: JsonValue | undefined, revision: JsonValue | undefined): InternalRequest {
  return { method: "DELETE", url: `${base}/${encoded(id)}?expectedRevision=${encodeURIComponent(String(revision ?? ""))}` };
}

function composeAction(value: JsonValue | undefined): string {
  const action = requiredString(value, "action");
  const mapped: Record<string, string> = { up: "compose_up", down: "compose_down", pull: "compose_pull", restart: "compose_restart" };
  if (!mapped[action]) throw invalidOperation("Compose", action);
  return mapped[action];
}

function requestObject(value: JsonValue): Record<string, JsonValue> {
  if (!isRecord(value)) throw new CapabilityError("INVALID_ARGUMENT", "request must be an object");
  return value;
}

function requireReadyRoot(db: CyberOsDatabase, rootId: string) {
  const root = getNasRoot(db, rootId);
  if (!root || !root.enabled) throw new CapabilityError("INVALID_ARGUMENT", "NAS root not found");
  if (root.mountPolicy === "required" && getRootReadiness(db, root.id)?.status !== "ready") {
    throw new CapabilityError("NOT_READY", "NAS root is not ready", { retryable: true });
  }
  return root;
}

function without(value: Record<string, JsonValue>, ...keys: string[]): Record<string, JsonValue> {
  const denied = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !denied.has(key)));
}

function encoded(value: JsonValue | undefined): string {
  return encodeURIComponent(requiredString(value, "identifier"));
}

function requiredString(value: JsonValue | undefined, field: string, trim = true): string {
  if (typeof value !== "string" || (trim ? !value.trim() : value.length === 0)) throw new CapabilityError("INVALID_ARGUMENT", `${field} is required`);
  return trim ? value.trim() : value;
}

function stringArray(value: JsonValue | undefined, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new CapabilityError("INVALID_ARGUMENT", `${field} must be a non-empty string array`);
  }
  return value as string[];
}

function invalidOperation(domain: string, operation: string): CapabilityError {
  return new CapabilityError("INVALID_ARGUMENT", `Unsupported ${domain} operation: ${operation}`);
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
