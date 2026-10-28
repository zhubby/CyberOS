import type { JsonSchema, JsonValue } from "./contracts.js";
import { EMPTY_OBJECT_SCHEMA, strictObject } from "./schemas.js";

const id = (maxLength = 256): JsonSchema => ({ type: "string", minLength: 1, maxLength });
const text = (maxLength = 4096): JsonSchema => ({ type: "string", maxLength });
const nonEmptyText = (maxLength = 4096): JsonSchema => ({ type: "string", minLength: 1, maxLength });
const integer = (minimum: number, maximum: number): JsonSchema => ({ type: "integer", minimum, maximum });
const number = (minimum: number, maximum: number): JsonSchema => ({ type: "number", minimum, maximum });
const boolean: JsonSchema = { type: "boolean" };
const nullableText = (maxLength = 4096): JsonSchema => ({ type: ["string", "null"], maxLength });
const stringEnum = <T extends string>(values: readonly T[]): JsonSchema => ({ type: "string", enum: [...values] });
const valueEnum = (values: Array<string | number | boolean | null>): JsonSchema => ({ enum: values });
const arrayOf = (items: JsonSchema, minItems = 0, maxItems = 200): JsonSchema => ({
  type: "array",
  items,
  minItems,
  maxItems
});
const relativePath: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4096,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"
};
const rootId = id(128);
const cursor = nullableText(4096);
const limit = (maximum = 200): JsonSchema => integer(1, maximum);
const idempotencyKey: JsonSchema = { type: "string", minLength: 8, maxLength: 200 };
const sha256: JsonSchema = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };
const revision = nonEmptyText(256);
const timestamp: JsonSchema = { type: "string", format: "date-time", maxLength: 64 };
const email: JsonSchema = { type: "string", format: "email", maxLength: 254 };
const stringMap = (maxProperties = 64, maxValueLength = 4096): JsonSchema => ({
  type: "object",
  additionalProperties: { type: "string", maxLength: maxValueLength },
  maxProperties
});

const alertRule = strictObject({
  name: nonEmptyText(120),
  enabled: boolean,
  metric: nonEmptyText(120),
  selector: stringMap(8, 128),
  transform: stringEnum(["value", "rate"]),
  aggregation: stringEnum(["last", "avg", "min", "max"]),
  windowSeconds: valueEnum([60, 300, 900, 1800, 3600]),
  comparator: stringEnum([">", ">=", "<", "<="]),
  triggerThreshold: { type: "number" },
  recoveryThreshold: { type: "number" },
  triggerDurationSeconds: integer(0, 86_400),
  recoveryDurationSeconds: integer(0, 86_400),
  severity: stringEnum(["warning", "critical"]),
  noDataPolicy: stringEnum(["ignore", "firing"]),
  escalationPolicyId: { type: ["string", "null"], maxLength: 128 }
}, [
  "name", "enabled", "metric", "selector", "transform", "aggregation", "windowSeconds",
  "comparator", "triggerThreshold", "recoveryThreshold", "triggerDurationSeconds",
  "recoveryDurationSeconds", "severity", "noDataPolicy", "escalationPolicyId"
]);

const escalationStage = strictObject({
  delaySeconds: integer(0, 604_800),
  repeatIntervalSeconds: { type: ["integer", "null"], minimum: 300, maximum: 604_800 },
  repeatCount: integer(0, 10),
  targets: arrayOf(strictObject({
    type: stringEnum(["contact", "group", "oncall"]),
    id: id(128)
  }, ["type", "id"]), 1, 100)
}, ["delaySeconds", "repeatIntervalSeconds", "repeatCount", "targets"]);

const ethernetFamily = (family: 4 | 6): JsonSchema => strictObject({
  mode: stringEnum(family === 4 ? ["disabled", "dhcp", "static"] : ["disabled", "automatic", "static"]),
  address: nullableText(128),
  prefixLength: { type: ["integer", "null"], minimum: 0, maximum: family === 4 ? 32 : 128 },
  gateway: nullableText(128),
  dnsMode: stringEnum(["automatic", "manual"]),
  dns: arrayOf(nonEmptyText(128), 0, 3),
  useDefaultRoute: boolean,
  routeMetric: integer(1, 65_535)
}, ["mode", "address", "prefixLength", "gateway", "dnsMode", "dns", "useDefaultRoute", "routeMetric"]);

const ethernetConfig = strictObject({
  enabled: boolean,
  ipv4: ethernetFamily(4),
  ipv6: ethernetFamily(6)
}, ["enabled", "ipv4", "ipv6"]);

const shareProtocols = strictObject({
  smb: strictObject({ enabled: boolean, readOnly: boolean, browseable: boolean, allowGuest: boolean }),
  webdav: strictObject({ enabled: boolean, readOnly: boolean, allowGuest: boolean, port: integer(1, 65_535), pathPrefix: nonEmptyText(256) }),
  ftp: strictObject({ enabled: boolean, readOnly: boolean, allowGuest: boolean, port: integer(1, 65_535), passivePortStart: integer(1, 65_535), passivePortEnd: integer(1, 65_535) }),
  nfs: strictObject({ enabled: boolean, readOnly: boolean, allowedCidrs: arrayOf(nonEmptyText(128), 0, 100), rootSquash: boolean }),
  dlna: strictObject({ enabled: boolean, mediaTypes: arrayOf(stringEnum(["audio", "video", "pictures"]), 0, 3), bindInterface: nullableText(128), bindAddress: nullableText(128), friendlyName: nonEmptyText(128) })
});

const shareDefinition = strictObject({
  id: id(64),
  name: nonEmptyText(128),
  rootId,
  path: relativePath,
  description: text(500),
  protocols: shareProtocols
}, ["id", "name", "rootId", "path"]);

const dockerMount = {
  oneOf: [
    strictObject({
      type: { const: "bind" },
      rootId,
      sourcePath: relativePath,
      target: nonEmptyText(4096),
      readOnly: boolean
    }, ["type", "rootId", "sourcePath", "target"]),
    strictObject({
      type: { const: "volume" },
      source: nonEmptyText(255),
      target: nonEmptyText(4096),
      readOnly: boolean,
      noCopy: boolean
    }, ["type", "source", "target"]),
    strictObject({
      type: { const: "tmpfs" },
      target: nonEmptyText(4096),
      readOnly: boolean,
      sizeBytes: integer(1, Number.MAX_SAFE_INTEGER),
      mode: integer(0, 0o7777)
    }, ["type", "target"])
  ]
} satisfies JsonSchema;

const dockerNetwork = strictObject({
  mode: stringEnum(["bridge", "host", "none", "custom"]),
  networkName: nonEmptyText(128),
  aliases: arrayOf(nonEmptyText(128), 0, 32),
  ipv4Address: nonEmptyText(128),
  ipv6Address: nonEmptyText(128),
  macAddress: nonEmptyText(32)
}, ["mode"]);

const dockerPort = strictObject({
  containerPort: integer(1, 65_535),
  protocol: stringEnum(["tcp", "udp", "sctp"]),
  hostIp: nonEmptyText(128),
  hostPort: integer(1, 65_535)
}, ["containerPort"]);

const dockerExtraHost = strictObject({
  hostname: nonEmptyText(253),
  address: nonEmptyText(128)
}, ["hostname", "address"]);

const dockerIpam = strictObject({
  subnet: nonEmptyText(128),
  ipRange: nonEmptyText(128),
  gateway: nonEmptyText(128),
  auxAddresses: stringMap(64, 128)
});

const dockerHostAccess = strictObject({
  capability: stringEnum([
    "host_os_identity", "host_processes", "host_sys", "nas_capacity", "account_map",
    "docker_metadata", "systemd_status"
  ]),
  rootId,
  target: nonEmptyText(4096)
}, ["capability"]);

function proposal(request: JsonSchema): JsonSchema {
  return strictObject({ request, idempotencyKey }, ["request"]);
}

function operation<T extends string>(
  name: T,
  properties: Record<string, JsonSchema> = {},
  required: string[] = []
): JsonSchema {
  return strictObject({ operation: { const: name }, ...properties }, ["operation", ...required]);
}

function operationUnion(...operations: JsonSchema[]): JsonSchema {
  return { oneOf: operations };
}

const pagination = { cursor, limit: limit() };
const rootPath = { rootId, path: relativePath };

export type FileGrepRequest = {
  rootId: string;
  path?: string;
  pattern: string;
  mode?: "literal" | "regex";
  caseSensitive?: boolean;
  include?: string[];
  exclude?: string[];
  cursor?: string | null;
  limit?: number;
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
};

export type FileFindRequest = {
  rootId: string;
  path?: string;
  glob?: string;
  kind?: "any" | "file" | "directory";
  cursor?: string | null;
  limit?: number;
  maxEntries?: number;
  timeoutMs?: number;
};

export type ShellRunRequest = {
  rootId: string;
  command: "git" | "rg" | "find" | "ls" | "stat" | "du" | "df" | "file" | "sha256sum";
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
};

export type CapabilityProposalRequest<TRequest extends CapabilityMutationRequest> = {
  request: TRequest;
  idempotencyKey?: string;
};

type Operation<Name extends string, Fields extends object = Record<never, never>> = { operation: Name } & Fields;
type OptionalJsonFields<Key extends string> = Partial<Record<Key, JsonValue>>;
type RevisionedIdOperation<Name extends string> = Operation<Name, { id: string; expectedRevision: number }>;

type PowerRequest = Operation<"reboot" | "shutdown">;
type OperationsRunRequest = Operation<"health" | "maintenance">;
type FileExportRequest = Operation<"export", { rootId: string; paths: string[]; archiveName?: string }>;
type FileEditRequest = Operation<"edit", {
  rootId: string;
  path: string;
  find: string;
  replace: string;
  replaceAll?: boolean;
  expectedSha256?: string;
}>;
type FileWriteRequest = Operation<"write", {
  rootId: string;
  path: string;
  content: string;
  createOnly?: boolean;
  expectedSha256?: string;
}>;
type FileRollbackRequest = Operation<"rollback", { operationId: string }>;
type ReindexRequest = Operation<"reindex", { rootId: string; path?: string; recursive?: boolean }>;

type PhotoManageRequest =
  | Operation<"configure", { rootId: string; storagePoolId: string; path: string }>
  | (Operation<"processing"> & OptionalJsonFields<
    "processingConcurrency" | "scanIntervalMs" | "maxAutoRetries" | "retryBaseDelayMs" |
    "retryMaxDelayMs" | "commandTimeoutMs" | "maxFileSizeBytes" | "maxXmpSizeBytes" |
    "maxIntermediateBytes" | "minFreeSpaceBytes" | "maxDecodedPixels"
  >)
  | Operation<"scan">
  | Operation<"import", { sourceRootId: string; sourcePaths: string[]; targetDirectory?: string }>
  | Operation<"export", { assetIds: string[]; archiveName?: string }>
  | Operation<"move", { assetIds: string[]; targetDirectory: string }>
  | Operation<"trash", { assetIds: string[] }>;

type DownloadManageRequest =
  | Operation<"create", {
    url: string;
    rootId: string;
    storagePoolId: string;
    targetDirectory: string;
    fileName: string;
    sha256?: string;
  }>
  | Operation<"pause" | "resume" | "cancel" | "retry" | "delete", { taskId: string }>
  | (Operation<"settings"> & OptionalJsonFields<
    "concurrency" | "parallelRequestsPerTask" | "segmentedDownloadMinBytes" | "maxAutoRetries" |
    "retryBaseDelayMs" | "retryMaxDelayMs" | "retryAfterMaxDelayMs" | "connectTimeoutMs" |
    "responseHeaderTimeoutMs" | "readIdleTimeoutMs" | "minFreeSpaceBytes" | "maxFileSizeBytes"
  >);

type BackupRunRequest =
  | Operation<"validate" | "init" | "check">
  | Operation<"run", { schedule: "daily" | "weekly" }>
  | Operation<"restore", { snapshotId: string }>;

type AlertManageRequest =
  | Operation<"create_rule", { rule: Record<string, JsonValue> }>
  | Operation<"update_rule", { id: string; rule: Record<string, JsonValue>; expectedRevision: number }>
  | RevisionedIdOperation<"delete_rule" | "delete_silence" | "delete_contact" | "delete_group" | "delete_schedule" | "delete_policy">
  | Operation<"acknowledge_incident", { id: string }>
  | Operation<"create_silence", { ruleId: string; seriesKey?: string | null; startsAt: string; endsAt: string; reason: string }>
  | Operation<"create_contact", { name: string; email: string; enabled: boolean }>
  | Operation<"update_contact", { id: string; name: string; email: string; enabled: boolean; expectedRevision: number }>
  | Operation<"update_smtp", {
    enabled: boolean;
    host: string;
    port: number;
    security: "none" | "starttls" | "tls";
    username: string;
    from: string;
    replacePassword: boolean;
    expectedRevision: number;
  }>
  | Operation<"test_email", { recipient: string }>
  | Operation<"create_group", { name: string; contactIds?: string[] }>
  | Operation<"update_group", { id: string; name: string; contactIds: string[]; expectedRevision: number }>
  | Operation<"create_schedule", {
    name: string;
    timezone: string;
    handoffWeekday: number;
    handoffTime: string;
    anchorDate: string;
    contactIds: string[];
  }>
  | Operation<"update_schedule", {
    id: string;
    name: string;
    timezone: string;
    handoffWeekday: number;
    handoffTime: string;
    anchorDate: string;
    contactIds: string[];
    expectedRevision: number;
  }>
  | Operation<"create_override", { scheduleId: string; contactId: string; startsAt: string; endsAt: string; reason: string }>
  | Operation<"delete_override", { overrideId: string; expectedRevision: number }>
  | Operation<"create_policy", { name: string; enabled: boolean; stages: JsonValue[] }>
  | Operation<"update_policy", { id: string; name: string; enabled: boolean; stages: JsonValue[]; expectedRevision: number }>
  | Operation<"update_health_routing", { warningPolicyId: string | null; criticalPolicyId: string | null; expectedRevision: number }>;

type DockerManageRequest =
  | (Operation<"create_container", { name: string; image: string }> & OptionalJsonFields<
    "platform" | "pullPolicy" | "start" | "hostname" | "user" | "workingDir" | "entrypoint" |
    "command" | "environment" | "labels" | "tty" | "openStdin" | "init" | "stopSignal" |
    "stopTimeoutSeconds" | "cpuLimit" | "cpuShares" | "cpusetCpus" | "memoryLimitBytes" |
    "memoryReservationBytes" | "memorySwapBytes" | "pidsLimit" | "shmSizeBytes" | "readonlyRootfs" |
    "privileged" | "privilegedAcknowledged" | "mounts" | "network" | "ports" | "publishAllPorts" |
    "dns" | "dnsSearch" | "extraHosts" | "hostAccess" | "restartPolicy" | "restartMaxRetries" | "autoRemove"
  >)
  | Operation<"create_volume", { name: string; labels?: Record<string, string> }>
  | (Operation<"create_network", { name: string; driver: "bridge" | "macvlan" | "ipvlan" }> & OptionalJsonFields<
    "internal" | "enableIpv4" | "enableIpv6" | "parent" | "mode" | "ipam" | "labels"
  >)
  | Operation<"container_action", { containerId: string; action: "start" | "stop" | "restart" | "remove" }>
  | Operation<"compose_create", { name: string; projectKey: string; composeContent: string }>
  | Operation<"compose_update", { appId: string; name: string; composeContent: string; expectedRevision: string }>
  | Operation<"compose_delete", { appId: string; expectedRevision: string }>
  | Operation<"compose_action", { appId: string; action: "up" | "down" | "restart" | "pull"; service?: string }>
  | Operation<"image_pull" | "image_remove", { image: string }>
  | Operation<"registry_create", { name: string; serverAddress: string; username: string }>
  | Operation<"registry_update", { registryId: string; name?: string; serverAddress?: string; username?: string; replacePassword: boolean }>
  | Operation<"registry_delete", { registryId: string }>
  | Operation<"daemon_update", { content: string; expectedRevision: string; restart: boolean }>;

type VmManageRequest =
  | (Operation<"create", {
    domainName: string;
    vcpu: number;
    memoryBytes: number;
    diskSizeBytes: number;
    isoRootId: string;
    isoStoragePoolId: string;
    isoPath: string;
  }> & OptionalJsonFields<
    "vcpuTopology" | "memoryBacking" | "osVariant" | "firmware" | "machineType" | "cpuMode" |
    "cpuModel" | "diskBus" | "diskCache" | "diskDiscard" | "networkName" | "networkModel" |
    "macAddress" | "graphics" | "videoModel" | "bootMenu" | "autostart"
  >)
  | Operation<"start" | "shutdown" | "stop" | "restart" | "pause" | "resume" | "reset" | "delete", { domainName: string }>
  | Operation<"snapshot_create" | "snapshot_revert" | "snapshot_delete", { domainName: string; snapshotName: string }>;

type NetworkManageRequest =
  | Operation<"ethernet_stage", { deviceId: string; config: Record<string, JsonValue>; expectedRevision: string }>
  | Operation<"ethernet_apply">
  | Operation<"ethernet_confirm" | "ethernet_rollback", { transactionId: string }>
  | Operation<"wifi_connect", { device: string; profileId: string; autoconnect?: boolean }>
  | Operation<"wifi_connect", { device: string; ssid: string; bssid?: string; security: "open" | "wpa2" | "wpa3"; autoconnect?: boolean }>
  | Operation<"wifi_disconnect", { device: string }>
  | Operation<"wifi_radio", { enabled: boolean }>
  | Operation<"wifi_profile", {
    connectionId: string;
    ssid?: string;
    security?: "open" | "wpa2" | "wpa3";
    autoconnect?: boolean;
    expectedRevision: string;
    replacePassword: boolean;
  }>
  | Operation<"hotspot", {
    device: string;
    ssid: string;
    band: "auto" | "2.4" | "5";
    channel: number | null;
    autostart: boolean;
    expectedRevision?: string;
    replacePassword: boolean;
  }>
  | Operation<"hotspot_start" | "hotspot_stop" | "hotspot_delete", { device: string }>;

type StorageManageRequest =
  | Operation<"pool_create", { name: string; level: "0" | "1" | "5" | "6" | "10"; deviceIds: string[]; filesystem: "ext4" | "btrfs" }>
  | Operation<"pool_delete", { poolId: string; confirmation: string }>
  | Operation<"shares_update", { enabled: boolean; shares: JsonValue[] }>
  | Operation<"share_account", { username: string; expectedUpdatedAt: string }>;

type SettingsUpdateRequest =
  | (Operation<"indexer"> & OptionalJsonFields<
    "scanConcurrency" | "extractionConcurrency" | "reconciliationIntervalMs" | "maxExtractedTextBytes" |
    "maxSourceDocumentBytes" | "commandTimeoutMs" | "maxPdfTextPages" | "maxOcrPages" | "ocrRootIds"
  >)
  | (Operation<"model_provider"> & OptionalJsonFields<"providerName" | "baseUrl" | "model" | "replaceApiKey" | "clearApiKey">)
  | Operation<"agent_policy", { policies: Record<string, "auto" | "approve" | "confirm" | "disabled"> }>;

type TerminalManageRequest =
  | Operation<"create", { rootId: string }>
  | Operation<"rename", { tabId: string; customTitle: string | null }>
  | Operation<"activate" | "restart" | "close", { tabId: string }>;

type VodControlRequest =
  | Operation<"play", { rootId: string; storagePoolId: string; path: string; startPositionSeconds?: number; audioDeviceId?: string }>
  | Operation<"pause" | "resume" | "toggle-pause" | "stop" | "retry" | "cycle-audio-track" | "cycle-subtitle-track", { sessionId: string }>
  | Operation<"seek" | "seek-relative", { sessionId: string; seconds: number }>
  | Operation<"set-audio-track", { sessionId: string; trackId: number }>
  | Operation<"set-subtitle-track", { sessionId: string; trackId: number | null }>
  | Operation<"set-volume", { sessionId: string; volume: number }>;

export type CapabilityMutationRequest =
  | PowerRequest
  | OperationsRunRequest
  | FileExportRequest
  | FileEditRequest
  | FileWriteRequest
  | FileRollbackRequest
  | ReindexRequest
  | PhotoManageRequest
  | DownloadManageRequest
  | BackupRunRequest
  | AlertManageRequest
  | Operation<"set_read", { notificationId: string }>
  | Operation<"read_all">
  | DockerManageRequest
  | Operation<"console", { containerId: string; shell: "/bin/sh" | "/bin/bash" | "/bin/ash" }>
  | VmManageRequest
  | Operation<"console", { domainName: string }>
  | NetworkManageRequest
  | StorageManageRequest
  | SettingsUpdateRequest
  | TerminalManageRequest
  | VodControlRequest;

export interface PlannedCapabilityRequestMap {
  "cyberos.files.grep": FileGrepRequest;
  "cyberos.files.find": FileFindRequest;
  "cyberos.files.git": { rootId: string; path?: string };
  "cyberos.files.archive-inspect": { rootId: string; path: string; cursor?: string | null; limit?: number };
  "cyberos.photos.media": { assetId: string; variant: "thumbnail" | "preview" | "original" | "video"; maxWidth?: number };
  "cyberos.files.export-propose": CapabilityProposalRequest<FileExportRequest>;
  "cyberos.files.edit": CapabilityProposalRequest<FileEditRequest>;
  "cyberos.files.write": CapabilityProposalRequest<FileWriteRequest>;
  "cyberos.files.rollback-propose": CapabilityProposalRequest<FileRollbackRequest>;
  "cyberos.system.power-propose": CapabilityProposalRequest<PowerRequest>;
  "cyberos.operations.run-propose": CapabilityProposalRequest<OperationsRunRequest>;
  "cyberos.index.reindex-propose": CapabilityProposalRequest<ReindexRequest>;
  "cyberos.photos.manage-propose": CapabilityProposalRequest<PhotoManageRequest>;
  "cyberos.downloads.manage-propose": CapabilityProposalRequest<DownloadManageRequest>;
  "cyberos.backup.run-propose": CapabilityProposalRequest<BackupRunRequest>;
  "cyberos.alerts.manage-propose": CapabilityProposalRequest<AlertManageRequest>;
  "cyberos.notifications.read-state-propose": CapabilityProposalRequest<Operation<"set_read", { notificationId: string }> | Operation<"read_all">>;
  "cyberos.docker.manage-propose": CapabilityProposalRequest<DockerManageRequest>;
  "cyberos.docker.console-propose": CapabilityProposalRequest<Operation<"console", { containerId: string; shell: "/bin/sh" | "/bin/bash" | "/bin/ash" }>>;
  "cyberos.vm.manage-propose": CapabilityProposalRequest<VmManageRequest>;
  "cyberos.vm.console-propose": CapabilityProposalRequest<Operation<"console", { domainName: string }>>;
  "cyberos.network.manage-propose": CapabilityProposalRequest<NetworkManageRequest>;
  "cyberos.storage.manage-propose": CapabilityProposalRequest<StorageManageRequest>;
  "cyberos.settings.update-propose": CapabilityProposalRequest<SettingsUpdateRequest>;
  "cyberos.terminal.manage-propose": CapabilityProposalRequest<TerminalManageRequest>;
  "cyberos.vod.control-propose": CapabilityProposalRequest<VodControlRequest>;
  "cyberos.shell.run": ShellRunRequest;
}

const schemas: Record<string, JsonSchema> = {
  "cyberos.catalog.get": EMPTY_OBJECT_SCHEMA,
  "cyberos.system.status": EMPTY_OBJECT_SCHEMA,
  "cyberos.system.power-propose": proposal(operationUnion(
    operation("reboot"),
    operation("shutdown")
  )),
  "cyberos.operations.list": strictObject({ task: stringEnum(["health", "maintenance"]), limit: limit(100) }),
  "cyberos.operations.run-propose": proposal(operationUnion(
    operation("health"),
    operation("maintenance")
  )),
  "cyberos.roots.list": strictObject({ rootId }),
  "cyberos.files.list": strictObject({ ...rootPath, ...pagination }, ["rootId"]),
  "cyberos.files.stat": strictObject(rootPath, ["rootId", "path"]),
  "cyberos.files.read": strictObject({ ...rootPath, maxBytes: integer(1, 131_072) }, ["rootId", "path"]),
  "cyberos.files.resource-link": strictObject(rootPath, ["rootId", "path"]),
  "cyberos.files.search": strictObject({
    ...rootPath,
    query: nonEmptyText(500),
    ...pagination
  }, ["rootId", "query"]),
  "cyberos.files.grep": strictObject({
    ...rootPath,
    pattern: nonEmptyText(500),
    mode: stringEnum(["literal", "regex"]),
    caseSensitive: boolean,
    include: arrayOf(nonEmptyText(256), 0, 32),
    exclude: arrayOf(nonEmptyText(256), 0, 32),
    ...pagination,
    maxFiles: integer(1, 20_000),
    maxBytes: integer(1, 268_435_456),
    timeoutMs: integer(100, 30_000)
  }, ["rootId", "pattern"]),
  "cyberos.files.find": strictObject({
    ...rootPath,
    glob: nonEmptyText(500),
    kind: stringEnum(["any", "file", "directory"]),
    ...pagination,
    maxEntries: integer(1, 100_000),
    timeoutMs: integer(100, 30_000)
  }, ["rootId"]),
  "cyberos.files.git": strictObject(rootPath, ["rootId"]),
  "cyberos.files.archive-inspect": strictObject({ ...rootPath, ...pagination }, ["rootId", "path"]),
  "cyberos.files.export-propose": proposal(operation("export", {
    rootId,
    paths: arrayOf(relativePath, 1, 200),
    archiveName: nonEmptyText(255)
  }, ["rootId", "paths"])),
  "cyberos.files.mutate": proposal(operationUnion(
    operation("mkdir", { rootId, targetPath: relativePath }, ["rootId", "targetPath"]),
    operation("move", { rootId, sourcePath: relativePath, targetPath: relativePath }, ["rootId", "sourcePath", "targetPath"]),
    operation("copy", { rootId, sourcePath: relativePath, targetPath: relativePath }, ["rootId", "sourcePath", "targetPath"]),
    operation("rename", { rootId, sourcePath: relativePath, targetPath: relativePath }, ["rootId", "sourcePath", "targetPath"]),
    operation("trash", { rootId, sourcePath: relativePath }, ["rootId", "sourcePath"])
  )),
  "cyberos.files.edit": proposal(operation("edit", {
    rootId,
    path: relativePath,
    find: nonEmptyText(262_144),
    replace: text(262_144),
    replaceAll: boolean,
    expectedSha256: sha256
  }, ["rootId", "path", "find", "replace"])),
  "cyberos.files.write": proposal(operation("write", {
    rootId,
    path: relativePath,
    content: text(1_048_576),
    createOnly: boolean,
    expectedSha256: sha256
  }, ["rootId", "path", "content"])),
  "cyberos.files.rollback-propose": proposal(operation("rollback", { operationId: id(128) }, ["operationId"])),
  "cyberos.index.status": strictObject({ rootId }),
  "cyberos.index.reindex-propose": proposal(operation("reindex", {
    rootId,
    path: relativePath,
    recursive: boolean
  }, ["rootId"])),
  "cyberos.photos.query": strictObject({ assetId: id(), ...pagination }),
  "cyberos.photos.status": EMPTY_OBJECT_SCHEMA,
  "cyberos.photos.media": strictObject({
    assetId: id(),
    variant: stringEnum(["thumbnail", "preview", "original", "video"]),
    maxWidth: integer(64, 4096)
  }, ["assetId", "variant"]),
  "cyberos.photos.manage-propose": proposal(operationUnion(
    operation("configure", { rootId, storagePoolId: id(128), path: relativePath }, ["rootId", "storagePoolId", "path"]),
    operation("processing", {
      processingConcurrency: integer(1, 4),
      scanIntervalMs: integer(60_000, 86_400_000),
      maxAutoRetries: integer(0, 20),
      retryBaseDelayMs: integer(500, 1_800_000),
      retryMaxDelayMs: integer(500, 1_800_000),
      commandTimeoutMs: integer(5_000, 900_000),
      maxFileSizeBytes: integer(1_048_576, 1_099_511_627_776),
      maxXmpSizeBytes: integer(1_024, 67_108_864),
      maxIntermediateBytes: integer(67_108_864, 8_589_934_592),
      minFreeSpaceBytes: integer(0, 1_099_511_627_776),
      maxDecodedPixels: integer(1_000_000, 268_402_689)
    }),
    operation("scan"),
    operation("import", {
      sourceRootId: rootId,
      sourcePaths: arrayOf(relativePath, 1, 200),
      targetDirectory: relativePath
    }, ["sourceRootId", "sourcePaths"]),
    operation("export", { assetIds: arrayOf(id(), 1, 500), archiveName: nonEmptyText(255) }, ["assetIds"]),
    operation("move", { assetIds: arrayOf(id(), 1, 500), targetDirectory: relativePath }, ["assetIds", "targetDirectory"]),
    operation("trash", { assetIds: arrayOf(id(), 1, 500) }, ["assetIds"])
  )),
  "cyberos.downloads.list": strictObject({
    statuses: arrayOf(stringEnum(["queued", "running", "paused", "completed", "failed", "cancelled"]), 0, 6),
    limit: limit()
  }),
  "cyberos.downloads.manage-propose": proposal(operationUnion(
    operation("create", {
      url: { type: "string", minLength: 1, maxLength: 8192, format: "uri" },
      rootId,
      storagePoolId: id(128),
      targetDirectory: relativePath,
      fileName: nonEmptyText(255),
      sha256
    }, ["url", "rootId", "storagePoolId", "targetDirectory", "fileName"]),
    operation("pause", { taskId: id(128) }, ["taskId"]),
    operation("resume", { taskId: id(128) }, ["taskId"]),
    operation("cancel", { taskId: id(128) }, ["taskId"]),
    operation("retry", { taskId: id(128) }, ["taskId"]),
    operation("delete", { taskId: id(128) }, ["taskId"]),
    operation("settings", {
      concurrency: integer(1, 64),
      parallelRequestsPerTask: integer(1, 32),
      segmentedDownloadMinBytes: integer(0, 1_099_511_627_776),
      maxAutoRetries: integer(0, 100),
      retryBaseDelayMs: integer(100, 3_600_000),
      retryMaxDelayMs: integer(100, 86_400_000),
      retryAfterMaxDelayMs: integer(100, 86_400_000),
      connectTimeoutMs: integer(100, 600_000),
      responseHeaderTimeoutMs: integer(100, 600_000),
      readIdleTimeoutMs: integer(100, 600_000),
      minFreeSpaceBytes: integer(0, Number.MAX_SAFE_INTEGER),
      maxFileSizeBytes: { type: ["integer", "null"], minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
    })
  )),
  "cyberos.backup.status": strictObject({ limit: limit(100) }),
  "cyberos.backup.run-propose": proposal(operationUnion(
    operation("validate"),
    operation("init"),
    operation("run", { schedule: stringEnum(["daily", "weekly"]) }, ["schedule"]),
    operation("check"),
    operation("restore", {
      snapshotId: id(256)
    }, ["snapshotId"])
  )),
  "cyberos.monitoring.overview": EMPTY_OBJECT_SCHEMA,
  "cyberos.monitoring.query": strictObject({
    start: nonEmptyText(64),
    end: nonEmptyText(64),
    maxPoints: integer(2, 720),
    selectors: arrayOf(strictObject({
      metric: nonEmptyText(256),
      labels: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 128 }, maxProperties: 32 },
      transform: stringEnum(["value", "rate"])
    }, ["metric"]), 1, 12)
  }, ["start", "end", "selectors"]),
  "cyberos.alerts.read": strictObject({ status: stringEnum(["firing", "resolved"]), limit: limit() }),
  "cyberos.alerts.manage-propose": proposal(operationUnion(
    operation("create_rule", { rule: alertRule }, ["rule"]),
    operation("update_rule", { id: id(128), rule: alertRule, expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "rule", "expectedRevision"]),
    operation("delete_rule", { id: id(128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "expectedRevision"]),
    operation("acknowledge_incident", { id: id(128) }, ["id"]),
    operation("create_silence", { ruleId: id(128), seriesKey: nullableText(128), startsAt: timestamp, endsAt: timestamp, reason: nonEmptyText(240) }, ["ruleId", "startsAt", "endsAt", "reason"]),
    operation("delete_silence", { id: id(128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "expectedRevision"]),
    operation("create_contact", { name: nonEmptyText(80), email, enabled: boolean }, ["name", "email", "enabled"]),
    operation("update_contact", { id: id(128), name: nonEmptyText(80), email, enabled: boolean, expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "name", "email", "enabled", "expectedRevision"]),
    operation("delete_contact", { id: id(128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "expectedRevision"]),
    operation("update_smtp", { enabled: boolean, host: text(253), port: integer(1, 65_535), security: stringEnum(["none", "starttls", "tls"]), username: text(254), from: text(254), replacePassword: boolean, expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["enabled", "host", "port", "security", "username", "from", "replacePassword", "expectedRevision"]),
    operation("test_email", { recipient: email }, ["recipient"]),
    operation("create_group", { name: nonEmptyText(200), contactIds: arrayOf(id(128), 0, 100) }, ["name"]),
    operation("update_group", { id: id(128), name: nonEmptyText(80), contactIds: arrayOf(id(128), 0, 128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "name", "contactIds", "expectedRevision"]),
    operation("delete_group", { id: id(128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "expectedRevision"]),
    operation("create_schedule", { name: nonEmptyText(80), timezone: nonEmptyText(80), handoffWeekday: integer(1, 7), handoffTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }, anchorDate: { type: "string", format: "date" }, contactIds: arrayOf(id(128), 1, 128) }, ["name", "timezone", "handoffWeekday", "handoffTime", "anchorDate", "contactIds"]),
    operation("update_schedule", { id: id(128), name: nonEmptyText(80), timezone: nonEmptyText(80), handoffWeekday: integer(1, 7), handoffTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }, anchorDate: { type: "string", format: "date" }, contactIds: arrayOf(id(128), 1, 128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "name", "timezone", "handoffWeekday", "handoffTime", "anchorDate", "contactIds", "expectedRevision"]),
    operation("delete_schedule", { id: id(128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "expectedRevision"]),
    operation("create_override", { scheduleId: id(128), contactId: id(128), startsAt: timestamp, endsAt: timestamp, reason: nonEmptyText(240) }, ["scheduleId", "contactId", "startsAt", "endsAt", "reason"]),
    operation("delete_override", { overrideId: id(128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["overrideId", "expectedRevision"]),
    operation("create_policy", { name: nonEmptyText(80), enabled: boolean, stages: arrayOf(escalationStage, 1, 5) }, ["name", "enabled", "stages"]),
    operation("update_policy", { id: id(128), name: nonEmptyText(80), enabled: boolean, stages: arrayOf(escalationStage, 1, 5), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "name", "enabled", "stages", "expectedRevision"]),
    operation("delete_policy", { id: id(128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["id", "expectedRevision"]),
    operation("update_health_routing", { warningPolicyId: { type: ["string", "null"], maxLength: 128 }, criticalPolicyId: { type: ["string", "null"], maxLength: 128 }, expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["warningPolicyId", "criticalPolicyId", "expectedRevision"])
  )),
  "cyberos.notifications.list": strictObject({ limit: limit(100) }),
  "cyberos.notifications.read-state-propose": proposal(operationUnion(
    operation("set_read", { notificationId: id(128) }, ["notificationId"]),
    operation("read_all")
  )),
  "cyberos.docker.status": EMPTY_OBJECT_SCHEMA,
  "cyberos.docker.manage-propose": proposal(operationUnion(
    operation("create_container", {
      name: nonEmptyText(128), image: nonEmptyText(512), platform: nonEmptyText(128),
      pullPolicy: stringEnum(["missing", "always", "never"]), start: boolean,
      hostname: nonEmptyText(255), user: nonEmptyText(128), workingDir: nonEmptyText(4096),
      entrypoint: arrayOf(text(4096), 0, 128), command: arrayOf(text(4096), 0, 128),
      environment: stringMap(256, 16_384), labels: stringMap(256, 4096), tty: boolean, openStdin: boolean, init: boolean,
      stopSignal: nonEmptyText(64), stopTimeoutSeconds: integer(0, 3600),
      cpuLimit: number(0.01, 1024), cpuShares: integer(2, 262144), cpusetCpus: nonEmptyText(1024),
      memoryLimitBytes: integer(6_291_456, Number.MAX_SAFE_INTEGER),
      memoryReservationBytes: integer(0, Number.MAX_SAFE_INTEGER), memorySwapBytes: integer(-1, Number.MAX_SAFE_INTEGER),
      pidsLimit: integer(-1, Number.MAX_SAFE_INTEGER), shmSizeBytes: integer(0, Number.MAX_SAFE_INTEGER),
      readonlyRootfs: boolean, privileged: boolean, privilegedAcknowledged: boolean,
      mounts: arrayOf(dockerMount, 0, 128), network: dockerNetwork, ports: arrayOf(dockerPort, 0, 256),
      publishAllPorts: boolean, dns: arrayOf(nonEmptyText(128), 0, 16), dnsSearch: arrayOf(nonEmptyText(253), 0, 16),
      extraHosts: arrayOf(dockerExtraHost, 0, 128), hostAccess: arrayOf(dockerHostAccess, 0, 32),
      restartPolicy: stringEnum(["no", "always", "unless-stopped", "on-failure"]),
      restartMaxRetries: integer(0, 1_000_000), autoRemove: boolean
    }, ["name", "image"]),
    operation("create_volume", { name: nonEmptyText(128), labels: stringMap(256, 4096) }, ["name"]),
    operation("create_network", { name: nonEmptyText(128), driver: stringEnum(["bridge", "macvlan", "ipvlan"]), internal: boolean, enableIpv4: boolean, enableIpv6: boolean, parent: nonEmptyText(128), mode: stringEnum(["bridge", "private", "vepa", "passthru", "l2", "l3", "l3s"]), ipam: arrayOf(dockerIpam, 0, 32), labels: stringMap(256, 4096) }, ["name", "driver"]),
    operation("container_action", { containerId: id(256), action: stringEnum(["start", "stop", "restart", "remove"]) }, ["containerId", "action"]),
    operation("compose_create", { name: nonEmptyText(128), projectKey: nonEmptyText(128), composeContent: nonEmptyText(524_288) }, ["name", "projectKey", "composeContent"]),
    operation("compose_update", { appId: id(128), name: nonEmptyText(128), composeContent: nonEmptyText(524_288), expectedRevision: revision }, ["appId", "name", "composeContent", "expectedRevision"]),
    operation("compose_delete", { appId: id(128), expectedRevision: revision }, ["appId", "expectedRevision"]),
    operation("compose_action", { appId: id(128), action: stringEnum(["up", "down", "restart", "pull"]), service: nonEmptyText(128) }, ["appId", "action"]),
    operation("image_pull", { image: nonEmptyText(512) }, ["image"]),
    operation("image_remove", { image: nonEmptyText(512) }, ["image"]),
    operation("registry_create", { name: nonEmptyText(128), serverAddress: nonEmptyText(2048), username: nonEmptyText(255) }, ["name", "serverAddress", "username"]),
    operation("registry_update", { registryId: id(128), name: nonEmptyText(128), serverAddress: nonEmptyText(2048), username: text(256), replacePassword: boolean }, ["registryId", "replacePassword"]),
    operation("registry_delete", { registryId: id(128) }, ["registryId"]),
    operation("daemon_update", { content: text(262_144), expectedRevision: revision, restart: boolean }, ["content", "expectedRevision", "restart"])
  )),
  "cyberos.docker.console-propose": proposal(operation("console", {
    containerId: id(256),
    shell: stringEnum(["/bin/sh", "/bin/bash", "/bin/ash"])
  }, ["containerId", "shell"])),
  "cyberos.vm.status": EMPTY_OBJECT_SCHEMA,
  "cyberos.vm.manage-propose": proposal(operationUnion(
    operation("create", { domainName: nonEmptyText(128), vcpu: integer(1, 128), vcpuTopology: strictObject({ sockets: integer(1, 128), cores: integer(1, 128), threads: integer(1, 128) }, ["sockets", "cores", "threads"]), memoryBytes: integer(268_435_456, Number.MAX_SAFE_INTEGER), memoryBacking: stringEnum(["default", "hugepages"]), osVariant: nonEmptyText(128), firmware: stringEnum(["bios", "uefi"]), machineType: nonEmptyText(128), cpuMode: stringEnum(["host-model", "host-passthrough", "custom"]), cpuModel: nonEmptyText(128), diskSizeBytes: integer(1_073_741_824, Number.MAX_SAFE_INTEGER), diskBus: stringEnum(["virtio", "scsi", "sata", "ide"]), diskCache: stringEnum(["none", "writeback", "writethrough", "directsync", "unsafe"]), diskDiscard: stringEnum(["ignore", "unmap"]), isoRootId: rootId, isoStoragePoolId: id(128), isoPath: relativePath, networkName: nonEmptyText(128), networkModel: stringEnum(["virtio", "e1000", "rtl8139"]), macAddress: nonEmptyText(32), graphics: stringEnum(["none", "spice", "vnc"]), videoModel: stringEnum(["none", "virtio", "qxl", "vga"]), bootMenu: boolean, autostart: boolean }, ["domainName", "vcpu", "memoryBytes", "diskSizeBytes", "isoRootId", "isoStoragePoolId", "isoPath"]),
    ...["start", "shutdown", "stop", "restart", "pause", "resume", "reset", "delete"].map((name) => operation(name, { domainName: nonEmptyText(128) }, ["domainName"])),
    operation("snapshot_create", { domainName: nonEmptyText(128), snapshotName: nonEmptyText(128) }, ["domainName", "snapshotName"]),
    operation("snapshot_revert", { domainName: nonEmptyText(128), snapshotName: nonEmptyText(128) }, ["domainName", "snapshotName"]),
    operation("snapshot_delete", { domainName: nonEmptyText(128), snapshotName: nonEmptyText(128) }, ["domainName", "snapshotName"])
  )),
  "cyberos.vm.console-propose": proposal(operation("console", { domainName: nonEmptyText(128) }, ["domainName"])),
  "cyberos.network.status": EMPTY_OBJECT_SCHEMA,
  "cyberos.network.manage-propose": proposal(operationUnion(
    operation("ethernet_stage", { deviceId: { type: "string", pattern: "^[0-9a-f]{12}$" }, config: ethernetConfig, expectedRevision: sha256 }, ["deviceId", "config", "expectedRevision"]),
    operation("ethernet_apply"),
    operation("ethernet_confirm", { transactionId: id(256) }, ["transactionId"]),
    operation("ethernet_rollback", { transactionId: id(256) }, ["transactionId"]),
    operation("wifi_connect", { device: nonEmptyText(128), profileId: id(256), autoconnect: boolean }, ["device", "profileId"]),
    operation("wifi_connect", { device: nonEmptyText(128), ssid: nonEmptyText(64), bssid: nonEmptyText(32), security: stringEnum(["open", "wpa2", "wpa3"]), autoconnect: boolean }, ["device", "ssid", "security"]),
    operation("wifi_disconnect", { device: nonEmptyText(128) }, ["device"]),
    operation("wifi_radio", { enabled: boolean }, ["enabled"]),
    operation("wifi_profile", { connectionId: id(256), ssid: nonEmptyText(64), security: stringEnum(["open", "wpa2", "wpa3"]), autoconnect: boolean, expectedRevision: revision, replacePassword: boolean }, ["connectionId", "expectedRevision", "replacePassword"]),
    operation("hotspot", { device: nonEmptyText(128), ssid: nonEmptyText(64), band: stringEnum(["auto", "2.4", "5"]), channel: { type: ["integer", "null"], minimum: 1, maximum: 196 }, autostart: boolean, expectedRevision: revision, replacePassword: boolean }, ["device", "ssid", "band", "channel", "autostart", "replacePassword"]),
    operation("hotspot_start", { device: nonEmptyText(128) }, ["device"]),
    operation("hotspot_stop", { device: nonEmptyText(128) }, ["device"]),
    operation("hotspot_delete", { device: nonEmptyText(128) }, ["device"])
  )),
  "cyberos.storage.status": EMPTY_OBJECT_SCHEMA,
  "cyberos.storage.manage-propose": proposal(operationUnion(
    operation("pool_create", { name: nonEmptyText(32), level: stringEnum(["0", "1", "5", "6", "10"]), deviceIds: arrayOf(nonEmptyText(512), 1, 32), filesystem: stringEnum(["ext4", "btrfs"]) }, ["name", "level", "deviceIds", "filesystem"]),
    operation("pool_delete", { poolId: id(128), confirmation: nonEmptyText(128) }, ["poolId", "confirmation"]),
    operation("shares_update", { enabled: boolean, shares: arrayOf(shareDefinition, 0, 100) }, ["enabled", "shares"]),
    operation("share_account", { username: nonEmptyText(32), expectedUpdatedAt: timestamp }, ["username", "expectedUpdatedAt"])
  )),
  "cyberos.settings.public": EMPTY_OBJECT_SCHEMA,
  "cyberos.settings.update-propose": proposal(operationUnion(
    operation("indexer", { scanConcurrency: integer(1, 16), extractionConcurrency: integer(1, 8), reconciliationIntervalMs: integer(60_000, 86_400_000), maxExtractedTextBytes: integer(65_536, 16_777_216), maxSourceDocumentBytes: integer(1_048_576, 2_199_023_255_552), commandTimeoutMs: integer(5_000, 900_000), maxPdfTextPages: integer(1, 5_000), maxOcrPages: integer(1, 100), ocrRootIds: arrayOf(rootId, 0, 100) }),
    operation("model_provider", { providerName: stringEnum(["openai", "anthropic"]), baseUrl: nullableText(2048), model: text(256), replaceApiKey: boolean, clearApiKey: boolean }),
    operation("agent_policy", { policies: { type: "object", additionalProperties: stringEnum(["auto", "approve", "confirm", "disabled"]), maxProperties: 9 } }, ["policies"])
  )),
  "cyberos.terminal.tabs": strictObject({ rootId }, ["rootId"]),
  "cyberos.terminal.manage-propose": proposal(operationUnion(
    operation("create", { rootId }, ["rootId"]),
    operation("rename", { tabId: id(128), customTitle: { type: ["string", "null"], maxLength: 80 } }, ["tabId", "customTitle"]),
    operation("activate", { tabId: id(128) }, ["tabId"]),
    operation("restart", { tabId: id(128) }, ["tabId"]),
    operation("close", { tabId: id(128) }, ["tabId"])
  )),
  "cyberos.shell.run": strictObject({
    rootId,
    command: stringEnum(["git", "rg", "find", "ls", "stat", "du", "df", "file", "sha256sum"]),
    args: arrayOf(text(4096), 0, 128),
    cwd: relativePath,
    timeoutMs: integer(100, 30_000),
    idempotencyKey
  }, ["rootId", "command"]),
  "cyberos.vod.status": EMPTY_OBJECT_SCHEMA,
  "cyberos.vod.control-propose": proposal(operationUnion(
    operation("play", { rootId, storagePoolId: id(128), path: relativePath, startPositionSeconds: number(0, Number.MAX_SAFE_INTEGER), audioDeviceId: id(256) }, ["rootId", "storagePoolId", "path"]),
    ...["pause", "resume", "toggle-pause", "stop", "retry", "cycle-audio-track", "cycle-subtitle-track"].map((name) => operation(name, { sessionId: id(256) }, ["sessionId"])),
    operation("seek", { sessionId: id(256), seconds: number(0, Number.MAX_SAFE_INTEGER) }, ["sessionId", "seconds"]),
    operation("seek-relative", { sessionId: id(256), seconds: number(-3600, 3600) }, ["sessionId", "seconds"]),
    operation("set-audio-track", { sessionId: id(256), trackId: integer(1, 1_000_000) }, ["sessionId", "trackId"]),
    operation("set-subtitle-track", { sessionId: id(256), trackId: { type: ["integer", "null"], minimum: 1, maximum: 1_000_000 } }, ["sessionId", "trackId"]),
    operation("set-volume", { sessionId: id(256), volume: number(0, 100) }, ["sessionId", "volume"])
  )),
  "cyberos.runs.get": strictObject({ runId: { type: "string", format: "uuid" } }, ["runId"]),
  "cyberos.runs.list": strictObject({ ...pagination }),
  "cyberos.runs.wait": strictObject({ runId: { type: "string", format: "uuid" }, timeoutMs: integer(0, 20_000) }, ["runId"]),
  "cyberos.runs.cancel": strictObject({ runId: { type: "string", format: "uuid" } }, ["runId"])
};

export function capabilityInputSchema(capabilityId: string): JsonSchema {
  const schema = schemas[capabilityId];
  if (!schema) throw new Error(`Missing strict input schema for ${capabilityId}`);
  return schema;
}

export function hasStrictCapabilityInputSchema(capabilityId: string): boolean {
  return schemas[capabilityId]?.additionalProperties === false;
}
