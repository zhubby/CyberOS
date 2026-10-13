import type {
  DockerCreateInput,
  DockerDaemonConfigSnapshot,
  DockerDaemonConfigUpdateInput,
  DockerDaemonConfigUpdateResult,
  DockerDaemonStatus,
  DockerImagePullInput,
  DockerImagePullResult,
  DockerImageRemoveInput,
  DockerImageRemoveResult,
  DockerImageSummary as SharedDockerImageSummary,
  DockerComposeAppCreateInput,
  DockerComposeAppDeleteInput,
  DockerComposeAppDetail as SharedDockerComposeAppDetail,
  DockerComposeAppSummary as SharedDockerComposeAppSummary,
  DockerComposeAppUpdateInput,
  DockerComposeAppValidateInput,
  DockerComposeAppValidationResult,
  DockerOperationAction,
  DockerOperationProposal as SharedDockerOperationProposal,
  DockerOperationRecord,
  DockerOperationTargetType,
  DockerCreateResult,
  DockerContainerDetails as SharedDockerContainerDetails,
  DockerNetworkDetails as SharedDockerNetworkDetails,
  DockerVolumeDetails as SharedDockerVolumeDetails,
  DockerSettingsRecord,
  DockerRegistryCredentialCreateInput,
  DockerRegistryCredentialSummary as SharedDockerRegistryCredentialSummary,
  DockerRegistryCredentialUpdateInput,
  GitDirectoryStatus,
  GitFileStatus,
  IndexRootStatus,
  IndexReindexRequest as SharedIndexReindexRequest,
  IndexSearchCategory as SharedIndexSearchCategory,
  IndexSearchPage as SharedIndexSearchPage,
  IndexSearchRequest as SharedIndexSearchRequest,
  IndexSearchResult as SharedIndexSearchResult,
  IndexSearchSortField as SharedIndexSearchSortField,
  IndexerServiceStatus as SharedIndexerServiceStatus,
  IndexerSettingsRecord as SharedIndexerSettingsRecord,
  ModelProviderName as SharedModelProviderName,
  PublicBuildInfo,
  PublicModelProviderSettings,
  PublicShareSettings,
  DockerSummary as PublicDockerSummary,
  PublicSystemInfo,
  ShareOperationRecord,
  ShareOperationProposal as SharedShareOperationProposal,
  StorageFilesystem as SharedStorageFilesystem,
  StorageOperationProposal as SharedStorageOperationProposal,
  StorageOperationRecord,
  StorageRaidLevel as SharedStorageRaidLevel,
  ShareSummary as PublicShareSummary,
  SystemNetworkSummary,
  SystemNetworkTrafficSummary,
  SystemEthernetApplyTransaction as SharedSystemEthernetApplyTransaction,
  SystemEthernetStatus as SharedSystemEthernetStatus,
  SystemEthernetUpdateInput,
  SystemPowerAction as SharedSystemPowerAction,
  SystemPowerResult as SharedSystemPowerResult,
  SystemWifiConnectInput,
  SystemWifiHotspotActionInput,
  SystemWifiHotspotUpdateInput,
  SystemWifiOperationResult,
  SystemWifiProfileUpdateInput,
  SystemWifiRadioInput,
  SystemWifiScanInput,
  SystemWifiScanResult,
  SystemWifiStatus,
  SystemStorageSummary,
  BackupRunSummary,
  RootReadiness,
  IndexerAlert,
  SystemHealthSummary,
  DownloadWorkerHealth as SharedDownloadWorkerHealth,
  DownloadTaskRecord as SharedDownloadTask,
  PublicDownloadSettings,
  VmSummary as PublicVmSummary,
  VmOperationRecord,
  VmOperationAction,
  VmOperationProposal as SharedVmOperationProposal,
  VmCpuMode,
  VmDiskBus,
  VmDiskCache,
  VmDiskDiscard,
  VmFirmware,
  VmGraphics,
  VmMemoryBacking,
  VmNetworkModel,
  VmVideoModel,
  VodPlayerStatus as SharedVodPlayerStatus,
  VodPlayerCommand as SharedVodPlayerCommand,
  OperationNotificationRecord as SharedOperationNotification,
  OpsRunRecord as SharedOpsRunRecord,
  OpsTask as SharedOpsTask,
  OpsTaskOverview as SharedOpsTaskOverview,
  SystemOperationsResponse as SharedSystemOperationsResponse,
  PhotoAssetRecord as SharedPhotoAsset,
  PhotoJobRecord as SharedPhotoJob,
  PhotoLibrarySettingsRecord as SharedPhotoLibrarySettings,
  PhotoLibraryStatus as SharedPhotoLibraryStatus,
  PhotoProcessingSettingsRecord as SharedPhotoProcessingSettings,
  PhotoWorkerHealth as SharedPhotoWorkerHealth,
  PhotoMapQueryRequest as SharedPhotoMapQueryRequest,
  PhotoMapQueryResult as SharedPhotoMapQueryResult,
  PhotoManagedMapSettings as SharedPhotoMapSettings,
  PhotoMapSettingsResponse as SharedPhotoMapSettingsResponse,
  PhotoMetadataDetail as SharedPhotoMetadataDetail,
  PhotoMetadataField as SharedPhotoMetadataField,
  PhotoQueryAsset as SharedPhotoQueryAsset,
  PhotoQueryPage as SharedPhotoQueryPage,
  PhotoQueryRequest as SharedPhotoQueryRequest,
  PhotoTimelinePage as SharedPhotoTimelinePage,
  TerminalTab as SharedTerminalTab,
  TerminalTabState as SharedTerminalTabState
} from "@sigmaos/shared";

export interface NasRoot {
  id: string;
  name: string;
  path: string;
  homePath: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  mimeType?: string;
  sizeBytes: number;
  modifiedAt: string;
  isSafe: boolean;
  gitStatus?: GitFileStatus;
}

export interface FileListing {
  entries: FileEntry[];
  git: GitDirectoryStatus | null;
}

export interface FileSearchResult {
  files: FileEntry[];
  git: GitDirectoryStatus | null;
}

export type IndexerRootStatus = IndexRootStatus;
export type IndexReindexRequest = SharedIndexReindexRequest;
export type IndexSearchCategory = SharedIndexSearchCategory;
export type IndexSearchPage = SharedIndexSearchPage;
export type IndexSearchRequest = SharedIndexSearchRequest;
export type IndexSearchResult = SharedIndexSearchResult;
export type IndexSearchSortField = SharedIndexSearchSortField;
export type IndexerServiceStatus = SharedIndexerServiceStatus;
export type IndexerSettings = SharedIndexerSettingsRecord;

export interface IndexerOverview extends IndexerServiceStatus {
  roots: IndexerRootStatus[];
}

export interface BackupStatus {
  enabled: boolean;
  repositoryConfigured: boolean;
  repositoryAvailable: boolean;
  passwordConfigured: boolean;
  repositoryPath: string | null;
  stagingPath: string | null;
  runs: BackupRunSummary[];
  alerts: IndexerAlert[];
}

export interface ReadinessResponse { roots: RootReadiness[]; }
export type SystemHealth = SystemHealthSummary;
export type OpsRun = SharedOpsRunRecord;
export type OpsTask = SharedOpsTask;
export type OpsTaskOverview = SharedOpsTaskOverview;
export type SystemOperations = SharedSystemOperationsResponse;
export type DownloadTask = SharedDownloadTask;
export type DownloadSettings = PublicDownloadSettings;
export type DownloadWorkerHealth = SharedDownloadWorkerHealth;
export type PhotoAsset = SharedPhotoAsset;
export type PhotoJob = SharedPhotoJob;
export type PhotoLibrarySettings = SharedPhotoLibrarySettings;
export type PhotoLibraryStatus = SharedPhotoLibraryStatus;
export type PhotoProcessingSettings = SharedPhotoProcessingSettings;
export type PhotoWorkerHealth = SharedPhotoWorkerHealth;
export type PhotoMapQueryRequest = SharedPhotoMapQueryRequest;
export type PhotoMapQueryResult = SharedPhotoMapQueryResult;
export type PhotoMapSettings = SharedPhotoMapSettings;
export type PhotoMapSettingsResponse = SharedPhotoMapSettingsResponse;
export type PhotoMetadataDetail = SharedPhotoMetadataDetail;
export type PhotoMetadataField = SharedPhotoMetadataField;
export type PhotoQueryAsset = SharedPhotoQueryAsset;
export type PhotoQueryPage = SharedPhotoQueryPage;
export type PhotoQueryRequest = SharedPhotoQueryRequest;
export type PhotoTimelinePage = SharedPhotoTimelinePage;
export type TerminalTab = SharedTerminalTab;
export type TerminalTabState = SharedTerminalTabState;
export type VmSummary = PublicVmSummary;
export type VmOperation = VmOperationRecord;
export type VmAction = VmOperationAction;
export interface VmActionResult { message: AgentMessage; job: Job; approval: null; operation: VmOperation; consoleSession?: VmConsoleSession; }
export interface VmConsoleSession { id: string; operationId: string; approvalId: string | null; domainName: string; status: string; createdAt: string; expiresAt: string; usedAt: string | null; websocketUrl: string; }

export interface Session {
  id: string;
  rootId: string;
  currentPath: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionSummary extends Session {
  createdAt: string;
  updatedAt: string;
  firstMessage: string | null;
  lastMessage: string | null;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface Job {
  id: string;
  sessionId: string;
  messageId: string;
  status: string;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

export interface FileOperationProposal {
  operation: string;
  rootId: string;
  storagePoolId?: string;
  sourcePath?: string;
  targetPath?: string;
  tag?: string;
  trashEntryId?: string;
  risk: "low" | "medium" | "high";
  reversible: boolean;
  summary: string;
}

export interface PiToolCallApproval {
  toolCallId: string;
  toolName: "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
  args: Record<string, unknown>;
  cwd: string;
  risk: "low" | "medium" | "high";
  summary: string;
}

export type DockerOperationProposal = SharedDockerOperationProposal;

export type VmOperationProposal = SharedVmOperationProposal;

export type ShareOperationProposal = SharedShareOperationProposal;
export type StorageOperationProposal = SharedStorageOperationProposal;

export type PendingApprovalProposal =
  | FileOperationProposal
  | PiToolCallApproval
  | DockerOperationProposal
  | VmOperationProposal
  | ShareOperationProposal
  | StorageOperationProposal;

export interface PendingApproval {
  id: string;
  jobId: string;
  sessionId: string;
  kind: "file_operation" | "pi_tool_call" | "docker_operation" | "vm_operation" | "share_operation" | "storage_operation";
  status: string;
  proposal: PendingApprovalProposal[];
  createdAt: string;
}

export interface FileOperation {
  id: string;
  approvalId: string | null;
  operation: string;
  sourcePath: string | null;
  targetPath: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type StorageOperation = StorageOperationRecord;
export type StorageFilesystem = SharedStorageFilesystem;
export type StorageRaidLevel = SharedStorageRaidLevel;

export interface AgentEvent {
  id: number;
  type: string;
  audience: "chat" | "notification";
  payload: Record<string, unknown>;
  createdAt: string;
}

export type OperationNotification = SharedOperationNotification;

export interface NotificationListResult {
  notifications: OperationNotification[];
  unreadCount: number;
}

export type FilePreviewKind =
  | "directory"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "unsupported";

export type ModelProviderName = SharedModelProviderName;
export type ModelProviderKind = ModelProviderName;
export type PiToolPolicyMode = "auto" | "ask" | "disabled";
export type PiDangerousToolPolicyMode = "ask" | "disabled";

export type ModelProviderSettings = PublicModelProviderSettings;

export interface ModelProviderSettingsInput {
  providerName?: ModelProviderName;
  baseUrl?: string | null;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface PiToolPolicySettings {
  read: PiToolPolicyMode;
  grep: PiToolPolicyMode;
  find: PiToolPolicyMode;
  ls: PiToolPolicyMode;
  bash: PiDangerousToolPolicyMode;
  edit: PiDangerousToolPolicyMode;
  write: PiDangerousToolPolicyMode;
  updatedAt: string;
}

export type SystemInfo = PublicSystemInfo;
export type BuildInfo = PublicBuildInfo;
export type SystemPowerAction = SharedSystemPowerAction;
export type SystemPowerResult = SharedSystemPowerResult;
export type SystemInfoStorageVolume = PublicSystemInfo["storage"]["volumes"][number];
export type NetworkSummary = SystemNetworkSummary;
export type NetworkTrafficSummary = SystemNetworkTrafficSummary;
export type WifiStatus = SystemWifiStatus;
export type EthernetStatus = SharedSystemEthernetStatus;
export type EthernetApplyTransaction = SharedSystemEthernetApplyTransaction;
export type StorageSummary = SystemStorageSummary;
export type DockerSummary = PublicDockerSummary;
export type DockerImageSummary = SharedDockerImageSummary;
export type DockerRegistryCredential = SharedDockerRegistryCredentialSummary;
export type {
  DockerImagePullInput,
  DockerImagePullResult,
  DockerImageRemoveInput,
  DockerImageRemoveResult,
  DockerRegistryCredentialCreateInput,
  DockerRegistryCredentialUpdateInput
};
export type { DockerDaemonConfigSnapshot, DockerDaemonConfigUpdateInput, DockerDaemonConfigUpdateResult, DockerDaemonStatus };
export type {
  SystemWifiConnectInput,
  SystemWifiHotspotActionInput,
  SystemWifiHotspotUpdateInput,
  SystemWifiOperationResult,
  SystemWifiProfileUpdateInput,
  SystemWifiRadioInput,
  SystemWifiScanInput,
  SystemWifiScanResult
};
export type ShareSettings = PublicShareSettings;
export type ShareSummary = PublicShareSummary;
export interface ShareAccountUpdateInput {
  username: string;
  password?: string;
  expectedUpdatedAt: string;
}
export type ShareSettingsInput = Omit<ShareSettings, "account" | "updatedAt"> & {
  account: {
    username: string;
    password?: string;
    clearPassword?: boolean;
  };
};
export type DockerContainer = DockerSummary["containers"][number];
export type DockerContainerDetails = SharedDockerContainerDetails;
export type DockerNetworkDetails = SharedDockerNetworkDetails;
export type DockerVolumeDetails = SharedDockerVolumeDetails;
export type DockerComposeProject = DockerSummary["composeProjects"][number];
export type DockerComposeApp = SharedDockerComposeAppSummary;
export type DockerComposeAppDetail = SharedDockerComposeAppDetail;
export type DockerOperation = DockerOperationRecord;
export type ShareOperation = ShareOperationRecord;
export type VodPlayerStatus = SharedVodPlayerStatus;
export type VodPlayerCommand =
  | { type: "play"; rootId: string; storagePoolId: string; path: string; startPositionSeconds?: number }
  | Exclude<SharedVodPlayerCommand, { type: "play" }>;

export interface FileMeta {
  path: string;
  name: string;
  kind: FileEntry["kind"];
  mimeType: string;
  previewKind: FilePreviewKind;
  sizeBytes: number;
  modifiedAt: string;
}

export interface TextPreview {
  path: string;
  content: string;
  truncated: boolean;
  maxBytes: number;
}

export interface EditableText extends TextPreview {
  modifiedAt: string;
  sizeBytes: number;
}

export interface SaveEditableTextResult {
  meta: FileMeta;
  textPreview: TextPreview;
  operation: FileOperation;
}

export interface FileProposalResult {
  message: AgentMessage;
  job: Job;
  approval: PendingApproval;
}

export interface PhotoExportResult {
  url: string;
  expiresAt: string | null;
}

export interface UploadProgress {
  loadedBytes: number;
  totalBytes: number;
  lengthComputable: boolean;
}

export interface UploadFileResult {
  meta: FileMeta;
  operation: FileOperation;
}

export interface ExtractFileResult {
  operation: FileOperation;
  targetPath: string;
}

export interface DockerProposalResult {
  message: AgentMessage;
  job: Job;
  approval: PendingApproval | null;
  operation: DockerOperation;
  result?: DockerCreateResult;
}

export type DockerCreateProposalInput = ({ sessionId: string; action: "create" } & DockerCreateInput);
export type DockerLifecycleProposalInput = {
  sessionId: string;
  action: Exclude<DockerOperationAction, "create">;
  targetType?: DockerOperationTargetType;
  containerId?: string;
  composeProjectId?: string;
  service?: string;
  shell?: string;
};
export type DockerProposalInput = DockerCreateProposalInput | DockerLifecycleProposalInput;

export interface DockerConsoleSession {
  id: string;
  operationId: string;
  containerId: string;
  shell: string;
  expiresAt: string;
  websocketUrl: string;
}

export type DockerSettings = DockerSettingsRecord;

export const MAX_EDIT_TEXT_BYTES = 1024 * 1024;

export async function getRoots(): Promise<NasRoot[]> {
  const response = await fetch("/api/roots");
  await ensureOk(response);
  const body = (await response.json()) as { roots: NasRoot[] };
  return body.roots;
}

export async function getModelProviderSettings(): Promise<ModelProviderSettings> {
  const response = await fetch("/api/settings/model-provider");
  await ensureOk(response);
  const body = (await response.json()) as { settings: ModelProviderSettings };
  return body.settings;
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const response = await fetch("/api/settings/system-info");
  await ensureOk(response);
  const body = (await response.json()) as { info: SystemInfo };
  return body.info;
}

export async function getBuildInfo(): Promise<BuildInfo> {
  const response = await fetch("/api/system/build-info");
  await ensureOk(response);
  const body = (await response.json()) as { build: BuildInfo };
  return body.build;
}

export async function requestSystemPower(action: SystemPowerAction): Promise<SystemPowerResult> {
  const response = await fetch("/api/system/power", jsonRequest("POST", { action, confirmed: true }));
  await ensureOk(response);
  return ((await response.json()) as { result: SystemPowerResult }).result;
}

export async function getSystemNetwork(): Promise<NetworkSummary> {
  const response = await fetch("/api/system/network");
  await ensureOk(response);
  const body = (await response.json()) as { network: NetworkSummary };
  return body.network;
}

export async function getSystemNetworkTraffic(): Promise<NetworkTrafficSummary> {
  const response = await fetch("/api/system/network/traffic");
  await ensureOk(response);
  const body = (await response.json()) as { traffic: NetworkTrafficSummary };
  return body.traffic;
}

export async function getSystemEthernet(): Promise<EthernetStatus> {
  const response = await fetch("/api/system/network/ethernet");
  await ensureOk(response);
  return ((await response.json()) as { ethernet: EthernetStatus }).ethernet;
}

export async function saveSystemEthernet(deviceId: string, input: SystemEthernetUpdateInput): Promise<EthernetStatus> {
  const response = await fetch(`/api/system/network/ethernet/${encodeURIComponent(deviceId)}`, jsonRequest("PUT", input));
  await ensureOk(response);
  return ((await response.json()) as { ethernet: EthernetStatus }).ethernet;
}

export async function applySystemEthernet(confirmed: boolean): Promise<EthernetApplyTransaction> {
  return ethernetTransaction("/api/system/network/ethernet/apply", { confirmed });
}

export async function confirmSystemEthernet(transactionId: string): Promise<EthernetApplyTransaction> {
  return ethernetTransaction(`/api/system/network/ethernet/apply/${encodeURIComponent(transactionId)}/confirm`);
}

export async function rollbackSystemEthernet(transactionId: string): Promise<EthernetApplyTransaction> {
  return ethernetTransaction(`/api/system/network/ethernet/apply/${encodeURIComponent(transactionId)}/rollback`);
}

async function ethernetTransaction(url: string, input?: unknown): Promise<EthernetApplyTransaction> {
  const response = await fetch(url, input === undefined ? { method: "POST" } : jsonRequest("POST", input));
  await ensureOk(response);
  return ((await response.json()) as { transaction: EthernetApplyTransaction }).transaction;
}

export async function scanSystemWifi(input: SystemWifiScanInput): Promise<SystemWifiScanResult> {
  const response = await fetch("/api/system/network/wifi/scan", jsonRequest("POST", input));
  await ensureOk(response);
  return ((await response.json()) as { scan: SystemWifiScanResult }).scan;
}

export async function connectSystemWifi(input: SystemWifiConnectInput): Promise<SystemWifiOperationResult> {
  return wifiMutation("/api/system/network/wifi/connect", "POST", input);
}

export async function disconnectSystemWifi(device: string, confirmed: boolean): Promise<SystemWifiOperationResult> {
  return wifiMutation("/api/system/network/wifi/disconnect", "POST", { device, confirmed });
}

export async function setSystemWifiRadio(input: SystemWifiRadioInput): Promise<SystemWifiOperationResult> {
  return wifiMutation("/api/system/network/wifi/radio", "PUT", input);
}

export async function updateSystemWifiProfile(
  profileId: string,
  input: SystemWifiProfileUpdateInput
): Promise<SystemWifiOperationResult> {
  return wifiMutation(`/api/system/network/wifi/profiles/${encodeURIComponent(profileId)}`, "PATCH", input);
}

export async function deleteSystemWifiProfile(profileId: string, confirmed: boolean): Promise<SystemWifiOperationResult> {
  return wifiMutation(`/api/system/network/wifi/profiles/${encodeURIComponent(profileId)}`, "DELETE", { confirmed });
}

export async function updateSystemWifiHotspot(input: SystemWifiHotspotUpdateInput): Promise<SystemWifiOperationResult> {
  return wifiMutation("/api/system/network/wifi/hotspot", "PUT", input);
}

export async function startSystemWifiHotspot(input: SystemWifiHotspotActionInput): Promise<SystemWifiOperationResult> {
  return wifiMutation("/api/system/network/wifi/hotspot/start", "POST", input);
}

export async function stopSystemWifiHotspot(input: SystemWifiHotspotActionInput): Promise<SystemWifiOperationResult> {
  return wifiMutation("/api/system/network/wifi/hotspot/stop", "POST", input);
}

export async function deleteSystemWifiHotspot(input: SystemWifiHotspotActionInput): Promise<SystemWifiOperationResult> {
  return wifiMutation("/api/system/network/wifi/hotspot", "DELETE", input);
}

async function wifiMutation(url: string, method: "POST" | "PUT" | "PATCH" | "DELETE", input: unknown) {
  const response = await fetch(url, jsonRequest(method, input));
  await ensureOk(response);
  return ((await response.json()) as { result: SystemWifiOperationResult }).result;
}

function jsonRequest(method: string, input: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  };
}

export async function getSystemStorage(): Promise<StorageSummary> {
  const response = await fetch("/api/system/storage");
  await ensureOk(response);
  const body = (await response.json()) as { storage: StorageSummary };
  return body.storage;
}

export async function getDockerSummary(): Promise<DockerSummary> {
  const response = await fetch("/api/docker/summary");
  await ensureOk(response);
  const body = (await response.json()) as { summary: DockerSummary };
  return body.summary;
}

export async function getDockerRegistries(): Promise<DockerRegistryCredential[]> {
  const response = await fetch("/api/docker/registries");
  await ensureOk(response);
  return ((await response.json()) as { registries: DockerRegistryCredential[] }).registries;
}

export async function createDockerRegistry(
  input: DockerRegistryCredentialCreateInput
): Promise<DockerRegistryCredential> {
  const response = await fetch("/api/docker/registries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return ((await response.json()) as { registry: DockerRegistryCredential }).registry;
}

export async function updateDockerRegistry(
  id: string,
  input: DockerRegistryCredentialUpdateInput
): Promise<DockerRegistryCredential> {
  const response = await fetch(`/api/docker/registries/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return ((await response.json()) as { registry: DockerRegistryCredential }).registry;
}

export async function deleteDockerRegistry(id: string): Promise<void> {
  const response = await fetch(`/api/docker/registries/${encodeURIComponent(id)}`, { method: "DELETE" });
  await ensureOk(response);
}

export async function pullDockerImage(input: DockerImagePullInput): Promise<DockerImagePullResult> {
  const response = await fetch("/api/docker/images/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return ((await response.json()) as { result: DockerImagePullResult }).result;
}

export async function removeDockerImage(input: DockerImageRemoveInput): Promise<DockerImageRemoveResult> {
  const response = await fetch("/api/docker/images/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return ((await response.json()) as { result: DockerImageRemoveResult }).result;
}

export async function getDockerDaemonConfig(): Promise<DockerDaemonConfigSnapshot> {
  const response = await fetch("/api/docker/daemon/config");
  await ensureOk(response);
  return ((await response.json()) as { config: DockerDaemonConfigSnapshot }).config;
}

export class DockerDaemonApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly result?: DockerDaemonConfigUpdateResult
  ) {
    super(message);
    this.name = "DockerDaemonApiError";
  }
}

export async function updateDockerDaemonConfig(
  input: DockerDaemonConfigUpdateInput
): Promise<DockerDaemonConfigUpdateResult> {
  const response = await fetch("/api/docker/daemon/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const body = (await response.json().catch(() => ({}))) as {
    result?: DockerDaemonConfigUpdateResult;
    error?: string;
  };
  if (!response.ok) {
    throw new DockerDaemonApiError(body.error ?? response.statusText, response.status, body.result);
  }
  if (!body.result) {
    throw new DockerDaemonApiError("Docker daemon update returned no result", 502);
  }
  return body.result;
}

export async function getVmSummary(): Promise<VmSummary> {
  const response = await fetch("/api/vms/summary");
  await ensureOk(response);
  return ((await response.json()) as { summary: VmSummary }).summary;
}

export async function getVmOperations(sessionId?: string | null): Promise<VmOperation[]> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const response = await fetch(`/api/vms/operations${query}`);
  await ensureOk(response);
  return ((await response.json()) as { operations: VmOperation[] }).operations;
}

export async function executeVmOperation(input: {
  sessionId: string;
  action: VmAction;
  domainName?: string;
  snapshotName?: string;
  vcpu?: number;
  vcpuTopology?: { sockets: number; cores: number; threads: number };
  memoryBytes?: number;
  memoryBacking?: VmMemoryBacking;
  osVariant?: string;
  firmware?: VmFirmware;
  machineType?: string;
  cpuMode?: VmCpuMode;
  cpuModel?: string;
  diskSizeBytes?: number;
  diskBus?: VmDiskBus;
  diskCache?: VmDiskCache;
  diskDiscard?: VmDiskDiscard;
  isoPath?: string;
  isoRootId?: string;
  isoStoragePoolId?: string;
  diskPath?: string;
  networkName?: string;
  networkModel?: VmNetworkModel;
  macAddress?: string;
  graphics?: VmGraphics;
  videoModel?: VmVideoModel;
  bootMenu?: boolean;
  autostart?: boolean;
}): Promise<VmActionResult> {
  const response = await fetch("/api/vms/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  await ensureOk(response);
  return (await response.json()) as VmActionResult;
}

export async function createVmConsoleSession(operationId: string): Promise<VmConsoleSession> {
  const response = await fetch("/api/vms/console-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId }) });
  await ensureOk(response);
  return ((await response.json()) as { consoleSession: VmConsoleSession }).consoleSession;
}

export async function getDockerSettings(): Promise<DockerSettings> {
  const response = await fetch("/api/settings/docker");
  await ensureOk(response);
  const body = (await response.json()) as { settings: DockerSettings };
  return body.settings;
}

export async function getShareSettings(): Promise<ShareSettings> {
  const response = await fetch("/api/settings/shares");
  await ensureOk(response);
  const body = (await response.json()) as { settings: ShareSettings };
  return body.settings;
}

export async function updateShareAccount(input: ShareAccountUpdateInput): Promise<ShareSettings> {
  const response = await fetch("/api/shares/account", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  const body = (await response.json()) as { settings: ShareSettings };
  return body.settings;
}

export async function getShareSummary(): Promise<ShareSummary> {
  const response = await fetch("/api/shares/summary");
  await ensureOk(response);
  const body = (await response.json()) as { summary: ShareSummary };
  return body.summary;
}

export async function getDockerContainerLogs(containerId: string, tail = 200): Promise<string> {
  const params = new URLSearchParams({
    tail: String(tail)
  });
  const response = await fetch(`/api/docker/containers/${encodeURIComponent(containerId)}/logs?${params.toString()}`);
  await ensureOk(response);
  const body = (await response.json()) as { logs: string };
  return body.logs;
}

export async function getDockerContainerDetails(containerId: string): Promise<DockerContainerDetails> {
  const response = await fetch(`/api/docker/containers/${encodeURIComponent(containerId)}`);
  await ensureOk(response);
  const body = (await response.json()) as { container: DockerContainerDetails };
  return body.container;
}

export async function getDockerNetworkDetails(networkId: string): Promise<DockerNetworkDetails> {
  const response = await fetch(`/api/docker/networks/${encodeURIComponent(networkId)}`);
  await ensureOk(response);
  const body = (await response.json()) as { network: DockerNetworkDetails };
  return body.network;
}

export async function getDockerVolumeDetails(volumeName: string): Promise<DockerVolumeDetails> {
  const response = await fetch(`/api/docker/volumes/${encodeURIComponent(volumeName)}`);
  await ensureOk(response);
  const body = (await response.json()) as { volume: DockerVolumeDetails };
  return body.volume;
}

export async function getDockerComposeApps(): Promise<DockerComposeApp[]> {
  const response = await fetch("/api/docker/apps");
  await ensureOk(response);
  const body = (await response.json()) as { apps: DockerComposeApp[] };
  return body.apps;
}

export async function getDockerComposeApp(appId: string): Promise<DockerComposeAppDetail> {
  const response = await fetch(`/api/docker/apps/${encodeURIComponent(appId)}`);
  await ensureOk(response);
  const body = (await response.json()) as { app: DockerComposeAppDetail };
  return body.app;
}

export async function validateDockerComposeApp(
  input: DockerComposeAppValidateInput
): Promise<DockerComposeAppValidationResult> {
  const response = await fetch("/api/docker/apps/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  const body = (await response.json()) as { validation: DockerComposeAppValidationResult };
  return body.validation;
}

export async function createDockerComposeApp(input: DockerComposeAppCreateInput): Promise<DockerComposeAppDetail> {
  const response = await fetch("/api/docker/apps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  const body = (await response.json()) as { app: DockerComposeAppDetail };
  return body.app;
}

export async function updateDockerComposeApp(
  appId: string,
  input: DockerComposeAppUpdateInput
): Promise<DockerComposeAppDetail> {
  const response = await fetch(`/api/docker/apps/${encodeURIComponent(appId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  const body = (await response.json()) as { app: DockerComposeAppDetail };
  return body.app;
}

export async function deleteDockerComposeApp(appId: string, input: DockerComposeAppDeleteInput): Promise<void> {
  const response = await fetch(`/api/docker/apps/${encodeURIComponent(appId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
}

export async function executeDockerContainerAction(
  containerId: string,
  action: "start" | "stop" | "restart" | "remove"
): Promise<{ action: string; containerId: string }> {
  const response = await fetch(`/api/docker/containers/${encodeURIComponent(containerId)}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action })
  });
  await ensureOk(response);
  return (await response.json()) as { action: string; containerId: string };
}

export async function getDockerOperations(sessionId?: string | null): Promise<DockerOperation[]> {
  const params = new URLSearchParams();
  if (sessionId) {
    params.set("sessionId", sessionId);
  }
  const response = await fetch(`/api/docker/operations${params.size ? `?${params.toString()}` : ""}`);
  await ensureOk(response);
  const body = (await response.json()) as { operations: DockerOperation[] };
  return body.operations;
}

export async function proposeDockerOperation(input: DockerProposalInput): Promise<DockerProposalResult> {
  const response = await fetch("/api/docker/proposals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return (await response.json()) as DockerProposalResult;
}

export async function createDockerConsoleSession(operationId: string): Promise<DockerConsoleSession> {
  const response = await fetch("/api/docker/console-sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ operationId })
  });
  await ensureOk(response);
  const body = (await response.json()) as { consoleSession: DockerConsoleSession };
  return body.consoleSession;
}

export async function proposeShareSettings(input: {
  sessionId: string;
  settings: ShareSettingsInput;
}): Promise<{
  message: AgentMessage;
  job: Job;
  approval: PendingApproval;
  operation: ShareOperation;
}> {
  const response = await fetch("/api/shares/proposals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return (await response.json()) as {
    message: AgentMessage;
    job: Job;
    approval: PendingApproval;
    operation: ShareOperation;
  };
}

export async function createStoragePool(input: {
  sessionId: string;
  name: string;
  raidLevel: StorageRaidLevel;
  devices: string[];
  filesystem: StorageFilesystem;
  confirm: boolean;
}): Promise<{
  message: AgentMessage;
  job: Job;
  operation: StorageOperation;
}> {
  const response = await fetch("/api/storage/proposals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return (await response.json()) as {
    message: AgentMessage;
    job: Job;
    operation: StorageOperation;
  };
}

export async function deleteStoragePool(input: {
  sessionId: string;
  poolId: string;
  confirmation: string;
}): Promise<{
  message: AgentMessage;
  job: Job;
  operation: StorageOperation;
}> {
  const response = await fetch("/api/storage/proposals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "delete_pool",
      confirm: true,
      ...input
    })
  });
  await ensureOk(response);
  return (await response.json()) as {
    message: AgentMessage;
    job: Job;
    operation: StorageOperation;
  };
}

export async function saveDockerSettings(input: Omit<DockerSettings, "updatedAt">): Promise<DockerSettings> {
  const response = await fetch("/api/settings/docker", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  const body = (await response.json()) as { settings: DockerSettings };
  return body.settings;
}

export async function saveModelProviderSettings(
  input: ModelProviderSettingsInput
): Promise<ModelProviderSettings> {
  const response = await fetch("/api/settings/model-provider", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  const body = (await response.json()) as { settings: ModelProviderSettings };
  return body.settings;
}

export async function getPiToolPolicySettings(): Promise<PiToolPolicySettings> {
  const response = await fetch("/api/settings/pi-tool-policy");
  await ensureOk(response);
  const body = (await response.json()) as { settings: PiToolPolicySettings };
  return body.settings;
}

export async function savePiToolPolicySettings(
  input: Partial<PiToolPolicySettings>
): Promise<PiToolPolicySettings> {
  const response = await fetch("/api/settings/pi-tool-policy", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  const body = (await response.json()) as { settings: PiToolPolicySettings };
  return body.settings;
}

export async function getSessions(rootId?: string): Promise<SessionSummary[]> {
  const params = new URLSearchParams();
  if (rootId) {
    params.set("rootId", rootId);
  }
  const response = await fetch(`/api/sessions${params.size ? `?${params.toString()}` : ""}`);
  await ensureOk(response);
  const body = (await response.json()) as { sessions: SessionSummary[] };
  return body.sessions;
}

export async function createSession(rootId: string, currentPath: string): Promise<Session> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      rootId,
      path: currentPath
    })
  });
  await ensureOk(response);
  const body = (await response.json()) as { session: Session };
  return body.session;
}

export async function updateSessionPath(sessionId: string, currentPath: string): Promise<Session> {
  const response = await fetch(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      path: currentPath
    })
  });
  await ensureOk(response);
  const body = (await response.json()) as { session: Session };
  return body.session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}`, {
    method: "DELETE"
  });
  await ensureOk(response);
}

export async function getTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  const response = await fetch(`/api/sessions/${sessionId}/transcript`);
  await ensureOk(response);
  const body = (await response.json()) as { transcript: TranscriptMessage[] };
  return body.transcript;
}

export async function getFiles(rootId: string, currentPath: string, storagePoolId: string): Promise<FileListing> {
  const params = new URLSearchParams({
    rootId,
    path: currentPath,
    storagePoolId
  });
  const response = await fetch(`/api/files?${params.toString()}`);
  await ensureOk(response);
  return (await response.json()) as FileListing;
}

export async function getPhotoLibrarySettings(): Promise<PhotoLibrarySettings | null> {
  const response = await fetch("/api/photos/settings");
  await ensureOk(response);
  return ((await response.json()) as { settings: PhotoLibrarySettings | null }).settings;
}

export async function savePhotoLibrarySettings(input: {
  rootId: string;
  storagePoolId: string;
  path: string;
}): Promise<{ settings: PhotoLibrarySettings; job: PhotoJob }> {
  const response = await fetch("/api/photos/settings", jsonRequest("PUT", input));
  await ensureOk(response);
  return (await response.json()) as { settings: PhotoLibrarySettings; job: PhotoJob };
}

export async function getPhotoTimeline(cursor?: string | null, limit = 60): Promise<PhotoTimelinePage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/photos?${params.toString()}`);
  await ensureOk(response);
  return (await response.json()) as PhotoTimelinePage;
}

export async function queryPhotos(input: PhotoQueryRequest): Promise<PhotoQueryPage> {
  const response = await fetch("/api/photos/query", jsonRequest("POST", input));
  await ensureOk(response);
  return (await response.json()) as PhotoQueryPage;
}

export async function getPhotoMetadata(assetId: string, includeSensitive = false): Promise<PhotoMetadataDetail> {
  const params = includeSensitive ? "?includeSensitive=1" : "";
  const response = await fetch(`/api/photos/${encodeURIComponent(assetId)}/metadata${params}`);
  await ensureOk(response);
  return ((await response.json()) as { metadata: PhotoMetadataDetail }).metadata;
}

export async function getPhotoRecord(assetId: string): Promise<PhotoQueryAsset> {
  const response = await fetch(`/api/photos/${encodeURIComponent(assetId)}/record`);
  await ensureOk(response);
  return ((await response.json()) as { photo: PhotoQueryAsset }).photo;
}

export async function getPhotoMetadataFields(query = ""): Promise<PhotoMetadataField[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const response = await fetch(`/api/photos/metadata/fields?${params.toString()}`);
  await ensureOk(response);
  return ((await response.json()) as { fields: PhotoMetadataField[] }).fields;
}

export async function queryPhotoMap(input: PhotoMapQueryRequest): Promise<PhotoMapQueryResult> {
  const response = await fetch("/api/photos/map/query", jsonRequest("POST", input));
  await ensureOk(response);
  return (await response.json()) as PhotoMapQueryResult;
}

export async function getPhotoMapSettings(): Promise<PhotoMapSettingsResponse> {
  const response = await fetch("/api/photos/map/settings");
  await ensureOk(response);
  return (await response.json()) as PhotoMapSettingsResponse;
}

export async function downloadPhotoMap(): Promise<PhotoMapSettingsResponse> {
  const response = await fetch("/api/photos/map/download", { method: "POST" });
  await ensureOk(response);
  return (await response.json()) as PhotoMapSettingsResponse;
}

export async function getPhotoLibraryStatus(): Promise<PhotoLibraryStatus> {
  return (await getPhotoStatus()).status;
}

export async function getPhotoStatus(): Promise<{
  status: PhotoLibraryStatus;
  workerHealth: PhotoWorkerHealth;
}> {
  const response = await fetch("/api/photos/status");
  await ensureOk(response);
  return (await response.json()) as {
    status: PhotoLibraryStatus;
    workerHealth: PhotoWorkerHealth;
  };
}

export async function getPhotoProcessingSettings(): Promise<PhotoProcessingSettings> {
  const response = await fetch("/api/settings/photos");
  await ensureOk(response);
  return ((await response.json()) as { settings: PhotoProcessingSettings }).settings;
}

export async function updatePhotoProcessingSettings(
  patch: Partial<Omit<PhotoProcessingSettings, "updatedAt">>
): Promise<PhotoProcessingSettings> {
  const response = await fetch("/api/settings/photos", jsonRequest("PATCH", patch));
  await ensureOk(response);
  return ((await response.json()) as { settings: PhotoProcessingSettings }).settings;
}

export async function requestPhotoScan(): Promise<PhotoJob> {
  const response = await fetch("/api/photos/scans", { method: "POST" });
  await ensureOk(response);
  return ((await response.json()) as { job: PhotoJob }).job;
}

export async function uploadPhoto(file: File, directory?: string): Promise<{ path: string; operation: FileOperation }> {
  const params = new URLSearchParams({ name: file.name });
  if (directory) params.set("directory", directory);
  const response = await fetch(`/api/photos/upload?${params.toString()}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: file
  });
  await ensureOk(response);
  return (await response.json()) as { path: string; operation: FileOperation };
}

export async function proposePhotoOperation(input: {
  sessionId: string;
  assetIds: string[];
  operation: "move" | "trash";
  targetDirectory?: string;
}): Promise<FileProposalResult> {
  const response = await fetch("/api/photos/proposals", jsonRequest("POST", input));
  await ensureOk(response);
  return (await response.json()) as FileProposalResult;
}

export async function createPhotoExport(assetIds: string[]): Promise<PhotoExportResult> {
  const response = await fetch("/api/photos/exports", jsonRequest("POST", { assetIds }));
  await ensureOk(response);
  return (await response.json()) as PhotoExportResult;
}

export async function getDownloads(): Promise<{
  tasks: DownloadTask[];
  health: DownloadWorkerHealth;
}> {
  const response = await fetch("/api/downloads");
  await ensureOk(response);
  return (await response.json()) as { tasks: DownloadTask[]; health: DownloadWorkerHealth };
}

export async function createDownload(input: {
  url: string;
  rootId: string;
  storagePoolId: string;
  targetDirectory: string;
  fileName: string;
  sha256?: string;
}): Promise<DownloadTask> {
  const response = await fetch("/api/downloads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  const body = (await response.json()) as { task: DownloadTask };
  return body.task;
}

export async function actOnDownload(
  id: string,
  action: "pause" | "resume" | "cancel" | "retry"
): Promise<DownloadTask> {
  const response = await fetch(`/api/downloads/${encodeURIComponent(id)}/${action}`, {
    method: "POST"
  });
  await ensureOk(response);
  const body = (await response.json()) as { task: DownloadTask };
  return body.task;
}

export async function deleteDownload(id: string): Promise<void> {
  const response = await fetch(`/api/downloads/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  await ensureOk(response);
}

export async function getTerminalTabs(rootId: string): Promise<TerminalTabState> {
  const params = new URLSearchParams({ rootId });
  const response = await fetch(`/api/terminal/tabs?${params.toString()}`);
  await ensureOk(response);
  return (await response.json()) as TerminalTabState;
}

export async function initializeTerminalTabs(rootId: string, legacySessionId?: string): Promise<TerminalTabState> {
  const response = await fetch("/api/terminal/tabs/initialize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootId, ...(legacySessionId ? { legacySessionId } : {}) })
  });
  await ensureOk(response);
  return (await response.json()) as TerminalTabState;
}

export async function createTerminalTab(rootId: string): Promise<TerminalTabState> {
  const response = await fetch("/api/terminal/tabs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootId })
  });
  await ensureOk(response);
  return (await response.json()) as TerminalTabState;
}

export async function renameTerminalTab(id: string, customTitle: string | null): Promise<TerminalTabState> {
  const response = await fetch(`/api/terminal/tabs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customTitle })
  });
  await ensureOk(response);
  return (await response.json()) as TerminalTabState;
}

export async function activateTerminalTab(id: string): Promise<TerminalTabState> {
  const response = await fetch(`/api/terminal/tabs/${encodeURIComponent(id)}/activate`, { method: "POST" });
  await ensureOk(response);
  return (await response.json()) as TerminalTabState;
}

export async function restartTerminalTab(id: string): Promise<TerminalTabState> {
  const response = await fetch(`/api/terminal/tabs/${encodeURIComponent(id)}/restart`, { method: "POST" });
  await ensureOk(response);
  return (await response.json()) as TerminalTabState;
}

export async function deleteTerminalTab(id: string): Promise<TerminalTabState> {
  const response = await fetch(`/api/terminal/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
  await ensureOk(response);
  return (await response.json()) as TerminalTabState;
}

export async function getDownloadSettings(): Promise<DownloadSettings> {
  const response = await fetch("/api/settings/downloads");
  await ensureOk(response);
  const body = (await response.json()) as { settings: DownloadSettings | null };
  return body.settings ?? {
    concurrency: 1,
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
    maxFileSizeBytes: null,
    updatedAt: new Date(0).toISOString()
  };
}

export async function updateDownloadSettings(
  patch: Partial<Omit<DownloadSettings, "updatedAt">>
): Promise<DownloadSettings> {
  const response = await fetch("/api/settings/downloads", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  await ensureOk(response);
  const body = (await response.json()) as { settings: DownloadSettings };
  return body.settings;
}

export async function searchFiles(
  rootId: string,
  currentPath: string,
  query: string,
  storagePoolId: string
): Promise<FileSearchResult> {
  const params = new URLSearchParams({
    rootId,
    path: currentPath,
    q: query,
    storagePoolId
  });
  const response = await fetch(`/api/search?${params.toString()}`);
  await ensureOk(response);
  return (await response.json()) as FileSearchResult;
}

export async function searchIndex(request: IndexSearchRequest): Promise<IndexSearchPage> {
  const response = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  await ensureOk(response);
  return (await response.json()) as IndexSearchPage;
}

export async function getIndexerStatus(rootId?: string): Promise<IndexerRootStatus[]> {
  const params = new URLSearchParams();
  if (rootId) {
    params.set("rootId", rootId);
  }
  const query = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/indexer/status${query}`);
  await ensureOk(response);
  const body = (await response.json()) as { roots: IndexerRootStatus[] };
  return body.roots;
}

export async function getIndexerOverview(rootId?: string): Promise<IndexerOverview> {
  const params = new URLSearchParams();
  if (rootId) params.set("rootId", rootId);
  const query = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/indexer/status${query}`);
  await ensureOk(response);
  return (await response.json()) as IndexerOverview;
}

export async function getIndexerSettings(): Promise<IndexerSettings> {
  const response = await fetch("/api/settings/indexer");
  await ensureOk(response);
  const body = (await response.json()) as { settings: IndexerSettings };
  return body.settings;
}

export async function updateIndexerSettings(
  patch: Partial<Omit<IndexerSettings, "updatedAt">>
): Promise<IndexerSettings> {
  const response = await fetch("/api/settings/indexer", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  await ensureOk(response);
  const body = (await response.json()) as { settings: IndexerSettings };
  return body.settings;
}

export async function requestReindex(input: IndexReindexRequest): Promise<void> {
  const response = await fetch("/api/indexer/reindex", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
}

export async function getRootReadiness(rootId?: string): Promise<RootReadiness[]> {
  const params = new URLSearchParams();
  if (rootId) params.set("rootId", rootId);
  const query = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/roots/readiness${query}`);
  await ensureOk(response);
  const body = (await response.json()) as ReadinessResponse;
  return body.roots;
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const response = await fetch("/api/backup/status");
  await ensureOk(response);
  return (await response.json()) as BackupStatus;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const response = await fetch("/api/system/health");
  await ensureOk(response);
  return (await response.json()) as SystemHealth;
}

export async function getSystemOperations(
  task?: OpsTask,
  limit = 60
): Promise<SystemOperations> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (task) params.set("task", task);
  const response = await fetch(`/api/system/operations?${params.toString()}`);
  await ensureOk(response);
  return (await response.json()) as SystemOperations;
}

export async function runSystemOperation(
  task: OpsTask,
  confirmed = false
): Promise<{ task: OpsTask; accepted: true }> {
  const response = await fetch(`/api/system/operations/${task}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task === "maintenance" ? { confirmed } : {})
  });
  await ensureOk(response);
  const body = (await response.json()) as { result: { task: OpsTask; accepted: true } };
  return body.result;
}

export async function getFileMeta(rootId: string, currentPath: string, storagePoolId: string): Promise<FileMeta> {
  const params = new URLSearchParams({
    rootId,
    path: currentPath,
    storagePoolId
  });
  const response = await fetch(`/api/files/meta?${params.toString()}`);
  await ensureOk(response);
  const body = (await response.json()) as { meta: FileMeta };
  return body.meta;
}

export async function getTextPreview(
  rootId: string,
  currentPath: string,
  storagePoolId: string,
  maxBytes = 64 * 1024
): Promise<TextPreview> {
  const params = new URLSearchParams({
    rootId,
    path: currentPath,
    storagePoolId,
    maxBytes: String(maxBytes)
  });
  const response = await fetch(`/api/files/text?${params.toString()}`);
  await ensureOk(response);
  return (await response.json()) as TextPreview;
}

export async function getEditableText(rootId: string, currentPath: string, storagePoolId: string): Promise<EditableText> {
  const params = new URLSearchParams({
    rootId,
    path: currentPath,
    storagePoolId
  });
  const response = await fetch(`/api/files/edit-text?${params.toString()}`);
  await ensureOk(response);
  return (await response.json()) as EditableText;
}

export async function saveEditableText(input: {
  rootId: string;
  storagePoolId: string;
  currentPath: string;
  content: string;
  expectedModifiedAt: string | null;
}): Promise<SaveEditableTextResult> {
  const response = await fetch("/api/files/edit-text", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      rootId: input.rootId,
      storagePoolId: input.storagePoolId,
      path: input.currentPath,
      content: input.content,
      expectedModifiedAt: input.expectedModifiedAt
    })
  });
  await ensureOk(response);
  return (await response.json()) as SaveEditableTextResult;
}

export async function proposeFileOperation(input: {
  sessionId: string;
  rootId: string;
  storagePoolId: string;
  operation: "mkdir" | "rename" | "trash" | "move" | "copy";
  sourcePath?: string;
  targetName?: string;
  targetPath?: string;
}): Promise<FileProposalResult> {
  const response = await fetch("/api/files/proposals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return (await response.json()) as FileProposalResult;
}

export async function extractFile(input: { rootId: string; storagePoolId: string; path: string }): Promise<ExtractFileResult> {
  const response = await fetch("/api/files/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return (await response.json()) as ExtractFileResult;
}

export async function uploadFile(input: {
  rootId: string;
  storagePoolId: string;
  path: string;
  file: File;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}): Promise<UploadFileResult> {
  return await new Promise<UploadFileResult>((resolve, reject) => {
    const params = new URLSearchParams({
      rootId: input.rootId,
      storagePoolId: input.storagePoolId,
      path: input.path
    });
    const xhr = new XMLHttpRequest();
    let abortListener: (() => void) | null = null;

    function cleanup() {
      if (abortListener && input.signal) {
        input.signal.removeEventListener("abort", abortListener);
      }
      abortListener = null;
    }

    xhr.open("PUT", `/api/files/upload?${params.toString()}`);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      input.onProgress?.({
        loadedBytes: event.loaded,
        totalBytes: event.total,
        lengthComputable: event.lengthComputable
      });
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(readXhrError(xhr));
        return;
      }

      const response =
        xhr.response && typeof xhr.response === "object"
          ? (xhr.response as UploadFileResult)
          : (JSON.parse(xhr.responseText) as UploadFileResult);
      resolve(response);
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Upload failed"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };

    if (input.signal) {
      if (input.signal.aborted) {
        xhr.abort();
        return;
      }
      abortListener = () => xhr.abort();
      input.signal.addEventListener("abort", abortListener, { once: true });
    }

    xhr.send(input.file);
  });
}

export function getFileBlobUrl(rootId: string, currentPath: string, storagePoolId: string): string {
  const params = new URLSearchParams({
    rootId,
    path: currentPath,
    storagePoolId
  });
  return `/api/files/blob?${params.toString()}`;
}

export function getFileDownloadUrl(rootId: string, currentPath: string, storagePoolId: string): string {
  const params = new URLSearchParams({
    rootId,
    path: currentPath,
    storagePoolId,
    download: "1"
  });
  return `/api/files/blob?${params.toString()}`;
}

export function getFileVideoUrl(rootId: string, currentPath: string, storagePoolId: string): string {
  const params = new URLSearchParams({
    rootId,
    path: currentPath,
    storagePoolId
  });
  return `/api/files/video?${params.toString()}`;
}

export async function getVodPlayerStatus(): Promise<VodPlayerStatus> {
  const response = await fetch("/api/vod-player/status");
  await ensureOk(response);
  const body = (await response.json()) as { status: VodPlayerStatus };
  return body.status;
}

export async function sendVodPlayerCommand(command: VodPlayerCommand): Promise<VodPlayerStatus> {
  const response = await fetch("/api/vod-player/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  await ensureOk(response);
  const body = (await response.json()) as { status: VodPlayerStatus };
  return body.status;
}

export async function getApprovals(): Promise<PendingApproval[]> {
  const response = await fetch("/api/approvals");
  await ensureOk(response);
  const body = (await response.json()) as { approvals: PendingApproval[] };
  return body.approvals;
}

export async function getNotifications(limit = 100): Promise<NotificationListResult> {
  const response = await fetch(`/api/notifications?limit=${limit}`);
  await ensureOk(response);
  return (await response.json()) as NotificationListResult;
}

export async function markNotificationRead(id: string): Promise<{
  notification: OperationNotification;
  unreadCount: number;
}> {
  const response = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: "PATCH"
  });
  await ensureOk(response);
  return (await response.json()) as {
    notification: OperationNotification;
    unreadCount: number;
  };
}

export async function markAllNotificationsRead(): Promise<number> {
  const response = await fetch("/api/notifications/read-all", { method: "POST" });
  await ensureOk(response);
  return ((await response.json()) as { updated: number }).updated;
}

export async function getOperations(): Promise<FileOperation[]> {
  const response = await fetch("/api/operations");
  await ensureOk(response);
  const body = (await response.json()) as { operations: FileOperation[] };
  return body.operations;
}

export async function approveRequest(approvalId: string): Promise<void> {
  const response = await fetch(`/api/approvals/${approvalId}/approve`, {
    method: "POST"
  });
  await ensureOk(response);
}

export async function rejectRequest(approvalId: string): Promise<void> {
  const response = await fetch(`/api/approvals/${approvalId}/reject`, {
    method: "POST"
  });
  await ensureOk(response);
}

export async function restoreTrashEntry(trashEntryId: string): Promise<void> {
  const response = await fetch(`/api/trash/${trashEntryId}/restore`, {
    method: "POST"
  });
  await ensureOk(response);
}

export async function rollbackOperation(operationId: string): Promise<void> {
  const response = await fetch(`/api/operations/${operationId}/rollback`, {
    method: "POST"
  });
  await ensureOk(response);
}

export async function sendMessage(sessionId: string, content: string): Promise<Job> {
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content })
  });
  await ensureOk(response);
  const body = (await response.json()) as { job: Job };
  return body.job;
}

export async function cancelJob(jobId: string): Promise<void> {
  const response = await fetch(`/api/jobs/${jobId}/cancel`, {
    method: "POST"
  });
  await ensureOk(response);
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  let message = response.statusText;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    message = body.error ?? message;
    code = body.code;
  } catch {
    // Keep status text.
  }

  const error = Object.assign(new Error(message), {
    statusCode: response.status,
    ...(code ? { code } : {})
  });
  throw error;
}

function readXhrError(xhr: XMLHttpRequest): Error {
  let message = xhr.statusText || "Upload failed";
  if (xhr.response && typeof xhr.response === "object") {
    const body = xhr.response as { error?: unknown };
    if (typeof body.error === "string" && body.error) {
      return new Error(body.error);
    }
  }
  try {
    if (xhr.responseType === "" || xhr.responseType === "text") {
      const body = JSON.parse(xhr.responseText) as { error?: string };
      message = body.error ?? message;
    }
  } catch {
    // Keep status text.
  }

  return new Error(message);
}
