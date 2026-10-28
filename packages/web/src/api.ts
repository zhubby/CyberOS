import type {
  AgentCapabilityId as SharedAgentCapabilityId,
  AgentCapabilityPolicyMode as SharedAgentCapabilityPolicyMode,
  PublicAgentCapabilityPolicySettings,
  PublicAgentMcpSettings,
  BluetoothAdapterInput,
  BluetoothAudioDevice as SharedBluetoothAudioDevice,
  BluetoothDeviceInput,
  BluetoothInboxStatus as SharedBluetoothInboxStatus,
  BluetoothOperationResult,
  BluetoothPairingChallengeInput,
  BluetoothSettingsRecord as SharedBluetoothSettings,
  BluetoothStatus as SharedBluetoothStatus,
  BluetoothTransferRecord as SharedBluetoothTransfer,
  BluetoothTransferServiceHealth as SharedBluetoothTransferServiceHealth,
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
  DockerHostAccessCatalog as SharedDockerHostAccessCatalog,
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
  IndexStoragePoolStatus,
  IndexReindexRequest as SharedIndexReindexRequest,
  IndexSearchCategory as SharedIndexSearchCategory,
  IndexSearchPage as SharedIndexSearchPage,
  IndexSearchRequest as SharedIndexSearchRequest,
  IndexSearchResult as SharedIndexSearchResult,
  IndexSearchSortField as SharedIndexSearchSortField,
  IndexerServiceStatus as SharedIndexerServiceStatus,
  IndexerSettingsRecord as SharedIndexerSettingsRecord,
  JobStatus as SharedJobStatus,
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
  FileBatchRecord as SharedFileBatch,
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
  TerminalTabState as SharedTerminalTabState,
  MonitoringCatalogResponse as SharedMonitoringCatalogResponse,
  MonitoringOverviewResponse as SharedMonitoringOverviewResponse,
  MonitoringQueryRequest as SharedMonitoringQueryRequest,
  MonitoringQueryResponse as SharedMonitoringQueryResponse,
  MonitoringStreamEvent as SharedMonitoringStreamEvent,
  MonitoringAlertRule as SharedMonitoringAlertRule,
  MonitoringAlertRuleInput as SharedMonitoringAlertRuleInput,
  MonitoringAlertIncident as SharedMonitoringAlertIncident,
  MonitoringAlertIncidentEvent as SharedMonitoringAlertIncidentEvent,
  MonitoringAlertIncidentDetail as SharedMonitoringAlertIncidentDetail,
  MonitoringAlertSilence as SharedMonitoringAlertSilence,
  MonitoringAlertSilenceInput as SharedMonitoringAlertSilenceInput,
  MonitoringAlertContact as SharedMonitoringAlertContact,
  MonitoringAlertContactInput as SharedMonitoringAlertContactInput,
  MonitoringAlertContactGroup as SharedMonitoringAlertContactGroup,
  MonitoringAlertContactGroupInput as SharedMonitoringAlertContactGroupInput,
  MonitoringOncallSchedule as SharedMonitoringOncallSchedule,
  MonitoringOncallScheduleInput as SharedMonitoringOncallScheduleInput,
  MonitoringOncallOverride as SharedMonitoringOncallOverride,
  MonitoringEscalationPolicy as SharedMonitoringEscalationPolicy,
  MonitoringEscalationPolicyInput as SharedMonitoringEscalationPolicyInput,
  MonitoringSmtpSettings as SharedMonitoringSmtpSettings,
  MonitoringSmtpSettingsInput as SharedMonitoringSmtpSettingsInput,
  MonitoringHealthRouting as SharedMonitoringHealthRouting,
  MonitoringAlertDelivery as SharedMonitoringAlertDelivery,
  MonitoringAlertSummary as SharedMonitoringAlertSummary,
  MediaLibraryStatus as SharedMediaLibraryStatus,
  MediaMatchCandidate as SharedMediaMatchCandidate,
  MediaMatchStatus as SharedMediaMatchStatus,
  MediaScanRunRecord as SharedMediaScanRun,
  MediaSourceKind as SharedMediaSourceKind,
  MediaSourceRecord as SharedMediaSource,
  MediaTitleSummary as SharedMediaTitleSummary,
  PublicMediaLibrarySettings as SharedPublicMediaLibrarySettings,
  TvModeStatus as SharedTvModeStatus
} from "@cyberos/shared";
import { createClientId } from "./lib/client-id.js";

export interface StoragePool {
  id: string;
  name: string;
  mountpoint: string | null;
  path: string;
  filesystem: string | null;
  status: SystemStorageSummary["pools"][number]["status"];
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

export type IndexerStoragePoolStatus = IndexStoragePoolStatus;
export type IndexReindexRequest = SharedIndexReindexRequest;
export type IndexSearchCategory = SharedIndexSearchCategory;
export type IndexSearchPage = SharedIndexSearchPage;
export type IndexSearchRequest = SharedIndexSearchRequest;
export type IndexSearchResult = SharedIndexSearchResult;
export type IndexSearchSortField = SharedIndexSearchSortField;
export type IndexerServiceStatus = SharedIndexerServiceStatus;
export type IndexerSettings = SharedIndexerSettingsRecord;

export interface IndexerOverview extends IndexerServiceStatus {
  storagePools: IndexerStoragePoolStatus[];
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

export type SystemHealth = SystemHealthSummary;
export type MonitoringCatalog = SharedMonitoringCatalogResponse;
export type MonitoringOverview = SharedMonitoringOverviewResponse;
export type MonitoringQueryRequest = SharedMonitoringQueryRequest;
export type MonitoringQueryResponse = SharedMonitoringQueryResponse;
export type MonitoringStreamEvent = SharedMonitoringStreamEvent;
export type MonitoringAlertRule = SharedMonitoringAlertRule;
export type MonitoringAlertRuleInput = SharedMonitoringAlertRuleInput;
export type MonitoringAlertIncident = SharedMonitoringAlertIncident;
export type MonitoringAlertIncidentEvent = SharedMonitoringAlertIncidentEvent;
export type MonitoringAlertIncidentDetail = SharedMonitoringAlertIncidentDetail;
export type MonitoringAlertSilence = SharedMonitoringAlertSilence;
export type MonitoringAlertSilenceInput = SharedMonitoringAlertSilenceInput;
export type MonitoringAlertContact = SharedMonitoringAlertContact;
export type MonitoringAlertContactInput = SharedMonitoringAlertContactInput;
export type MonitoringAlertContactGroup = SharedMonitoringAlertContactGroup;
export type MonitoringAlertContactGroupInput = SharedMonitoringAlertContactGroupInput;
export type MonitoringOncallSchedule = SharedMonitoringOncallSchedule;
export type MonitoringOncallScheduleInput = SharedMonitoringOncallScheduleInput;
export type MonitoringOncallOverride = SharedMonitoringOncallOverride;
export type MonitoringEscalationPolicy = SharedMonitoringEscalationPolicy;
export type MonitoringEscalationPolicyInput = SharedMonitoringEscalationPolicyInput;
export type MonitoringSmtpSettings = SharedMonitoringSmtpSettings;
export type MonitoringSmtpSettingsInput = SharedMonitoringSmtpSettingsInput;
export type MonitoringHealthRouting = SharedMonitoringHealthRouting;
export type MonitoringAlertDelivery = SharedMonitoringAlertDelivery;
export type MonitoringAlertSummary = SharedMonitoringAlertSummary;
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
export type MediaLibrarySettings = SharedPublicMediaLibrarySettings;
export type MediaLibraryStatus = SharedMediaLibraryStatus;
export type MediaMatchCandidate = SharedMediaMatchCandidate;
export type MediaMatchStatus = SharedMediaMatchStatus;
export type MediaScanRun = SharedMediaScanRun;
export type MediaSourceKind = SharedMediaSourceKind;
export type MediaSource = SharedMediaSource;
export type MediaTitleSummary = SharedMediaTitleSummary;
export type TvModeStatus = SharedTvModeStatus;
export type TerminalTab = SharedTerminalTab;
export type TerminalTabState = SharedTerminalTabState;
export type VmSummary = PublicVmSummary;
export type VmOperation = VmOperationRecord;
export type VmAction = VmOperationAction;
export interface VmActionResult { message: AgentMessage; job: Job; approval: null; operation: VmOperation; consoleSession?: VmConsoleSession; }
export interface VmConsoleSession { id: string; operationId: string; domainName: string; status: string; createdAt: string; expiresAt: string; usedAt: string | null; websocketUrl: string; }

export interface Session {
  id: string;
  currentPath: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionSummary extends Session {
  createdAt: string;
  updatedAt: string;
  firstMessage: string | null;
  lastMessage: string | null;
  pendingApprovalCount: number;
  activeJob?: Job | null;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sequence: number | null;
  streaming?: boolean;
}

type PersistedTranscriptMessage = Omit<TranscriptMessage, "sequence"> & { sequence: number };

export interface Job {
  id: string;
  sessionId: string;
  messageId: string;
  status: SharedJobStatus;
}

export type JobStatus = SharedJobStatus;

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

export interface FileOperationProposal {
  operation: string;
  storagePoolId: string;
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

export interface CapabilityApproval {
  id: string;
  runId: string;
  status: "pending";
  proposal: Record<string, unknown>;
  risk: "low" | "medium" | "high" | "critical";
  revision: number;
  requiresConfirmation: boolean;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  jobId: string;
  client: {
    id: string;
    name: string;
    kind: "pi" | "local" | "lan";
    tokenPrefix: string;
  } | null;
  run: {
    id: string;
    capabilityId: string;
    state: string;
    subjectId: string;
    subjectKind: "pi" | "local" | "lan" | "system";
    input: unknown;
    revision: number;
    createdAt: string;
  };
}

export interface ApprovalQueue {
  capabilityApprovals: CapabilityApproval[];
}

export interface FileOperation {
  id: string;
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
  schemaVersion?: 1;
  id: number;
  sessionId: string;
  jobId: string | null;
  type: string;
  audience: "chat" | "notification";
  transcriptSequence: number | null;
  source?: string;
  sourceId?: string | null;
  runId: string;
  sequence: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type AgentSessionCommandType =
  | "steer"
  | "follow_up"
  | "abort"
  | "compact"
  | "set_model"
  | "set_thinking_level"
  | "stats";

export interface AgentSessionCommand {
  id: string;
  idempotencyKey: string;
  sessionId: string;
  jobId: string | null;
  type: AgentSessionCommandType | "prompt";
  payload: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentToolActivity {
  id: string;
  runId: string;
  name: string;
  status: "running" | "completed" | "failed";
}

export type OperationNotification = SharedOperationNotification;
export type FileBatch = SharedFileBatch;

export interface NotificationListResult {
  notifications: OperationNotification[];
  unreadCount: number;
  bluetoothTransfers: BluetoothTransfer[];
  bluetoothUnreadCount: number;
}

export interface NotificationSummary {
  unreadCount: number;
  operations: number;
  alerts: number;
  bluetoothTransfers: number;
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
export type AgentCapabilityId = SharedAgentCapabilityId;
export type AgentCapabilityPolicyMode = SharedAgentCapabilityPolicyMode;

export type ModelProviderSettings = PublicModelProviderSettings;

export interface ModelProviderSettingsInput {
  providerName?: ModelProviderName;
  baseUrl?: string | null;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export type AgentCapabilityPolicySettings = PublicAgentCapabilityPolicySettings;
export type AgentMcpSettings = PublicAgentMcpSettings;

export type SystemInfo = PublicSystemInfo;
export type BuildInfo = PublicBuildInfo;
export type SystemPowerAction = SharedSystemPowerAction;
export type SystemPowerResult = SharedSystemPowerResult;
export type SystemInfoStorageVolume = PublicSystemInfo["storage"]["volumes"][number];
export type NetworkSummary = SystemNetworkSummary;
export type NetworkTrafficSummary = SystemNetworkTrafficSummary;
export type WifiStatus = SystemWifiStatus;
export type BluetoothStatus = SharedBluetoothStatus;
export type BluetoothAudioDevice = SharedBluetoothAudioDevice;
export type BluetoothInboxStatus = SharedBluetoothInboxStatus;
export type BluetoothSettings = SharedBluetoothSettings;
export type BluetoothTransfer = SharedBluetoothTransfer;
export type BluetoothTransferServiceHealth = SharedBluetoothTransferServiceHealth;
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
export type DockerHostAccessCatalog = SharedDockerHostAccessCatalog;
export type DockerOperation = DockerOperationRecord;
export type ShareOperation = ShareOperationRecord;
export type VodPlayerStatus = SharedVodPlayerStatus;
export type VodPlayerCommand =
  | { type: "play"; storagePoolId: string; path: string; startPositionSeconds?: number; audioDeviceId?: string }
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

export interface FileMutationResult {
  operation: FileOperation;
  targetPath: string | null;
}

export interface FileExportResult {
  url: string;
  expiresAt: string;
  fileName: string;
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
  operation: DockerOperation;
  result?: DockerCreateResult;
}

export type DockerCreateProposalInput = ({ action: "create" } & DockerCreateInput);
export type DockerLifecycleProposalInput = {
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

export async function getSystemBluetooth(): Promise<BluetoothStatus> {
  const response = await fetch("/api/system/bluetooth");
  await ensureOk(response);
  return ((await response.json()) as { bluetooth: BluetoothStatus }).bluetooth;
}

export interface BluetoothSettingsResponse {
  settings: BluetoothSettings;
  audioDevices: BluetoothAudioDevice[];
  inboxStatus: BluetoothInboxStatus;
}

export interface BluetoothTransfersResponse {
  transfers: BluetoothTransfer[];
  health: BluetoothTransferServiceHealth;
}

export async function getBluetoothSettings(): Promise<BluetoothSettingsResponse> {
  return fetchJson<BluetoothSettingsResponse>("/api/system/bluetooth/settings");
}

export async function saveBluetoothSettings(
  patch: Partial<Omit<BluetoothSettings, "updatedAt">>
): Promise<{ settings: BluetoothSettings; inboxStatus: BluetoothInboxStatus }> {
  return fetchJson<{ settings: BluetoothSettings; inboxStatus: BluetoothInboxStatus }>(
    "/api/system/bluetooth/settings",
    jsonRequest("PATCH", patch)
  );
}

export async function getBluetoothTransfers(): Promise<BluetoothTransfersResponse> {
  return fetchJson<BluetoothTransfersResponse>("/api/system/bluetooth/transfers");
}

export async function createBluetoothTransfers(input: {
  adapterId: string;
  address: string;
  storagePoolId: string;
  paths: string[];
}): Promise<BluetoothTransfer[]> {
  return fetchJson<{ transfers: BluetoothTransfer[] }>(
    "/api/system/bluetooth/transfers",
    jsonRequest("POST", input)
  ).then((body) => body.transfers);
}

export async function cancelBluetoothTransfer(id: string): Promise<BluetoothTransfer> {
  return fetchJson<{ transfer: BluetoothTransfer }>(
    `/api/system/bluetooth/transfers/${encodeURIComponent(id)}/cancel`,
    { method: "POST" }
  ).then((body) => body.transfer);
}

export function setBluetoothAdapterPower(input: BluetoothAdapterInput & { powered: boolean }) {
  return bluetoothMutation("/api/system/bluetooth/adapter/power", "PUT", input);
}

export function setDefaultBluetoothAdapter(input: BluetoothAdapterInput) {
  return bluetoothMutation("/api/system/bluetooth/default-adapter", "PUT", input);
}

export function startBluetoothScan(input: BluetoothAdapterInput) {
  return bluetoothMutation("/api/system/bluetooth/scan/start", "POST", input);
}

export function stopBluetoothScan(input: BluetoothAdapterInput) {
  return bluetoothMutation("/api/system/bluetooth/scan/stop", "POST", input);
}

export function pairBluetoothDevice(input: BluetoothDeviceInput) {
  return bluetoothMutation("/api/system/bluetooth/devices/pair", "POST", input);
}

export function cancelBluetoothPairing(input: BluetoothDeviceInput) {
  return bluetoothMutation("/api/system/bluetooth/devices/cancel-pairing", "POST", input);
}

export function respondBluetoothPairing(input: BluetoothPairingChallengeInput & { accept: boolean }) {
  return bluetoothMutation("/api/system/bluetooth/pairing/respond", "POST", input);
}

export function setBluetoothDeviceTrust(input: BluetoothDeviceInput & { trusted: boolean }) {
  return bluetoothMutation("/api/system/bluetooth/devices/trust", "PUT", input);
}

export function connectBluetoothDevice(input: BluetoothDeviceInput) {
  return bluetoothMutation("/api/system/bluetooth/devices/connect", "POST", input);
}

export function disconnectBluetoothDevice(input: BluetoothDeviceInput) {
  return bluetoothMutation("/api/system/bluetooth/devices/disconnect", "POST", input);
}

export function unpairBluetoothDevice(input: BluetoothDeviceInput) {
  return bluetoothMutation("/api/system/bluetooth/devices/unpair", "POST", input);
}

async function bluetoothMutation(url: string, method: "POST" | "PUT", input: unknown): Promise<BluetoothOperationResult> {
  const response = await fetch(url, jsonRequest(method, input));
  await ensureOk(response);
  return ((await response.json()) as { result: BluetoothOperationResult }).result;
}

export async function getMonitoringOverview(): Promise<MonitoringOverview> {
  const response = await fetch("/api/monitoring/overview");
  await ensureOk(response);
  return (await response.json()) as MonitoringOverview;
}

export async function getMonitoringCatalog(): Promise<MonitoringCatalog> {
  const response = await fetch("/api/monitoring/catalog");
  await ensureOk(response);
  return (await response.json()) as MonitoringCatalog;
}

export async function queryMonitoringMetrics(input: MonitoringQueryRequest): Promise<MonitoringQueryResponse> {
  const response = await fetch("/api/monitoring/query", jsonRequest("POST", input));
  await ensureOk(response);
  return (await response.json()) as MonitoringQueryResponse;
}

export async function getMonitoringAlertSummary(): Promise<MonitoringAlertSummary> {
  return fetchJson<{ summary: MonitoringAlertSummary }>("/api/monitoring/alerts/summary").then((body) => body.summary);
}

export async function getMonitoringAlertRules(): Promise<MonitoringAlertRule[]> {
  return fetchJson<{ rules: MonitoringAlertRule[] }>("/api/monitoring/alerts/rules").then((body) => body.rules);
}

export async function createMonitoringAlertRule(input: MonitoringAlertRuleInput): Promise<MonitoringAlertRule> {
  return fetchJson<{ rule: MonitoringAlertRule }>("/api/monitoring/alerts/rules", jsonRequest("POST", input))
    .then((body) => body.rule);
}

export async function updateMonitoringAlertRule(rule: MonitoringAlertRule): Promise<MonitoringAlertRule> {
  const { id, revision, builtin: _builtin, deletedAt: _deletedAt, createdAt: _createdAt,
    updatedAt: _updatedAt, evaluationError: _evaluationError,
    lastEvaluatedAt: _lastEvaluatedAt, ...input } = rule;
  return fetchJson<{ rule: MonitoringAlertRule }>(
    `/api/monitoring/alerts/rules/${encodeURIComponent(id)}`,
    jsonRequest("PATCH", { expectedRevision: revision, rule: input })
  ).then((body) => body.rule);
}

export async function deleteMonitoringAlertRule(id: string, revision: number): Promise<void> {
  await fetchEmpty(`/api/monitoring/alerts/rules/${encodeURIComponent(id)}?expectedRevision=${revision}`, { method: "DELETE" });
}

export async function getMonitoringAlertIncidents(
  status?: "firing" | "resolved",
  groupHealthEpisodes = false
): Promise<MonitoringAlertIncident[]> {
  const params = new URLSearchParams({ limit: "200" });
  if (status) params.set("status", status);
  if (groupHealthEpisodes) params.set("groupHealth", "true");
  const query = `?${params.toString()}`;
  return fetchJson<{ incidents: MonitoringAlertIncident[] }>(`/api/monitoring/alerts/incidents${query}`)
    .then((body) => body.incidents);
}

export async function getMonitoringAlertIncident(id: string): Promise<MonitoringAlertIncidentDetail> {
  return fetchJson<MonitoringAlertIncidentDetail>(
    `/api/monitoring/alerts/incidents/${encodeURIComponent(id)}`
  );
}

export async function readMonitoringAlertIncident(id: string): Promise<MonitoringAlertIncident> {
  return alertIncidentAction(id, "read");
}

export async function readAllMonitoringAlertIncidents(): Promise<number> {
  return fetchJson<{ updated: number }>("/api/monitoring/alerts/incidents/read-all", { method: "POST" })
    .then((body) => body.updated);
}

export async function acknowledgeMonitoringAlertIncident(id: string): Promise<MonitoringAlertIncident> {
  return alertIncidentAction(id, "acknowledge");
}

async function alertIncidentAction(id: string, action: "read" | "acknowledge") {
  return fetchJson<{ incident: MonitoringAlertIncident }>(
    `/api/monitoring/alerts/incidents/${encodeURIComponent(id)}/${action}`,
    { method: "POST" }
  ).then((body) => body.incident);
}

export async function getMonitoringAlertSilences(): Promise<MonitoringAlertSilence[]> {
  return fetchJson<{ silences: MonitoringAlertSilence[] }>("/api/monitoring/alerts/silences")
    .then((body) => body.silences);
}

export async function createMonitoringAlertSilence(input: MonitoringAlertSilenceInput): Promise<MonitoringAlertSilence> {
  return fetchJson<{ silence: MonitoringAlertSilence }>("/api/monitoring/alerts/silences", jsonRequest("POST", input))
    .then((body) => body.silence);
}

export async function deleteMonitoringAlertSilence(id: string, revision: number): Promise<void> {
  await fetchEmpty(`/api/monitoring/alerts/silences/${encodeURIComponent(id)}?expectedRevision=${revision}`, { method: "DELETE" });
}

export async function getMonitoringAlertContacts(): Promise<MonitoringAlertContact[]> {
  return fetchJson<{ contacts: MonitoringAlertContact[] }>("/api/monitoring/alerts/contacts").then((body) => body.contacts);
}

export async function createMonitoringAlertContact(input: MonitoringAlertContactInput): Promise<MonitoringAlertContact> {
  return fetchJson<{ contact: MonitoringAlertContact }>("/api/monitoring/alerts/contacts", jsonRequest("POST", input))
    .then((body) => body.contact);
}

export async function updateMonitoringAlertContact(contact: MonitoringAlertContact): Promise<MonitoringAlertContact> {
  return fetchJson<{ contact: MonitoringAlertContact }>(
    `/api/monitoring/alerts/contacts/${encodeURIComponent(contact.id)}`,
    jsonRequest("PATCH", {
      expectedRevision: contact.revision,
      contact: { name: contact.name, email: contact.email, enabled: contact.enabled }
    })
  ).then((body) => body.contact);
}

export async function deleteMonitoringAlertContact(id: string, revision: number): Promise<void> {
  await fetchEmpty(`/api/monitoring/alerts/contacts/${encodeURIComponent(id)}?expectedRevision=${revision}`, { method: "DELETE" });
}

export async function getMonitoringAlertGroups(): Promise<MonitoringAlertContactGroup[]> {
  return fetchJson<{ groups: MonitoringAlertContactGroup[] }>("/api/monitoring/alerts/groups").then((body) => body.groups);
}

export async function saveMonitoringAlertGroup(
  group: MonitoringAlertContactGroupInput & { id?: string; revision?: number }
): Promise<MonitoringAlertContactGroup> {
  const url = group.id ? `/api/monitoring/alerts/groups/${encodeURIComponent(group.id)}` : "/api/monitoring/alerts/groups";
  const init = group.id
    ? jsonRequest("PATCH", { expectedRevision: group.revision, group: { name: group.name, contactIds: group.contactIds } })
    : jsonRequest("POST", { name: group.name, contactIds: group.contactIds });
  return fetchJson<{ group: MonitoringAlertContactGroup }>(url, init).then((body) => body.group);
}

export async function deleteMonitoringAlertGroup(id: string, revision: number): Promise<void> {
  await fetchEmpty(`/api/monitoring/alerts/groups/${encodeURIComponent(id)}?expectedRevision=${revision}`, { method: "DELETE" });
}

export async function getMonitoringOncallSchedules(): Promise<MonitoringOncallSchedule[]> {
  return fetchJson<{ schedules: MonitoringOncallSchedule[] }>("/api/monitoring/alerts/schedules")
    .then((body) => body.schedules);
}

export async function saveMonitoringOncallSchedule(
  schedule: MonitoringOncallScheduleInput & { id?: string; revision?: number }
): Promise<MonitoringOncallSchedule> {
  const url = schedule.id ? `/api/monitoring/alerts/schedules/${encodeURIComponent(schedule.id)}` : "/api/monitoring/alerts/schedules";
  const payload = {
    name: schedule.name,
    timezone: schedule.timezone,
    handoffWeekday: schedule.handoffWeekday,
    handoffTime: schedule.handoffTime,
    anchorDate: schedule.anchorDate,
    contactIds: schedule.contactIds
  };
  const init = schedule.id
    ? jsonRequest("PATCH", { expectedRevision: schedule.revision, schedule: payload })
    : jsonRequest("POST", payload);
  return fetchJson<{ schedule: MonitoringOncallSchedule }>(url, init).then((body) => body.schedule);
}

export async function deleteMonitoringOncallSchedule(id: string, revision: number): Promise<void> {
  await fetchEmpty(`/api/monitoring/alerts/schedules/${encodeURIComponent(id)}?expectedRevision=${revision}`, { method: "DELETE" });
}

export async function createMonitoringOncallOverride(
  scheduleId: string,
  input: Omit<MonitoringOncallOverride, "id" | "scheduleId" | "revision" | "createdAt" | "updatedAt">
): Promise<MonitoringOncallOverride> {
  return fetchJson<{ override: MonitoringOncallOverride }>(
    `/api/monitoring/alerts/schedules/${encodeURIComponent(scheduleId)}/overrides`,
    jsonRequest("POST", input)
  ).then((body) => body.override);
}

export async function deleteMonitoringOncallOverride(id: string, revision: number): Promise<void> {
  await fetchEmpty(`/api/monitoring/alerts/overrides/${encodeURIComponent(id)}?expectedRevision=${revision}`, { method: "DELETE" });
}

export async function getMonitoringEscalationPolicies(): Promise<MonitoringEscalationPolicy[]> {
  return fetchJson<{ policies: MonitoringEscalationPolicy[] }>("/api/monitoring/alerts/policies")
    .then((body) => body.policies);
}

export async function saveMonitoringEscalationPolicy(
  policy: MonitoringEscalationPolicyInput & { id?: string; revision?: number }
): Promise<MonitoringEscalationPolicy> {
  const url = policy.id ? `/api/monitoring/alerts/policies/${encodeURIComponent(policy.id)}` : "/api/monitoring/alerts/policies";
  const payload = { name: policy.name, enabled: policy.enabled, stages: policy.stages };
  const init = policy.id
    ? jsonRequest("PATCH", { expectedRevision: policy.revision, policy: payload })
    : jsonRequest("POST", payload);
  return fetchJson<{ policy: MonitoringEscalationPolicy }>(url, init).then((body) => body.policy);
}

export async function deleteMonitoringEscalationPolicy(id: string, revision: number): Promise<void> {
  await fetchEmpty(`/api/monitoring/alerts/policies/${encodeURIComponent(id)}?expectedRevision=${revision}`, { method: "DELETE" });
}

export async function getMonitoringSmtpSettings(): Promise<MonitoringSmtpSettings> {
  return fetchJson<{ smtp: MonitoringSmtpSettings }>("/api/monitoring/alerts/smtp").then((body) => body.smtp);
}

export async function saveMonitoringSmtpSettings(
  expectedRevision: number,
  smtp: MonitoringSmtpSettingsInput
): Promise<MonitoringSmtpSettings> {
  return fetchJson<{ smtp: MonitoringSmtpSettings }>(
    "/api/monitoring/alerts/smtp",
    jsonRequest("PATCH", { expectedRevision, smtp })
  ).then((body) => body.smtp);
}

export async function testMonitoringEmail(recipient: string): Promise<string> {
  return fetchJson<{ deliveryId: string }>(
    "/api/monitoring/alerts/test-email",
    jsonRequest("POST", { recipient })
  ).then((body) => body.deliveryId);
}

export async function getMonitoringAlertDelivery(id: string): Promise<MonitoringAlertDelivery> {
  return fetchJson<{ delivery: MonitoringAlertDelivery }>(`/api/monitoring/alerts/deliveries/${encodeURIComponent(id)}`)
    .then((body) => body.delivery);
}

export async function getMonitoringHealthRouting(): Promise<MonitoringHealthRouting> {
  return fetchJson<{ routing: MonitoringHealthRouting }>("/api/monitoring/alerts/health-routing")
    .then((body) => body.routing);
}

export async function saveMonitoringHealthRouting(
  routing: MonitoringHealthRouting
): Promise<MonitoringHealthRouting> {
  return fetchJson<{ routing: MonitoringHealthRouting }>(
    "/api/monitoring/alerts/health-routing",
    jsonRequest("PATCH", {
      expectedRevision: routing.revision,
      routing: { warningPolicyId: routing.warningPolicyId, criticalPolicyId: routing.criticalPolicyId }
    })
  ).then((body) => body.routing);
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

export async function getVmOperations(): Promise<VmOperation[]> {
  const response = await fetch("/api/vms/operations");
  await ensureOk(response);
  return ((await response.json()) as { operations: VmOperation[] }).operations;
}

export async function executeVmOperation(input: {
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

export async function getDockerHostAccessCatalog(): Promise<DockerHostAccessCatalog> {
  const response = await fetch("/api/docker/host-access");
  await ensureOk(response);
  const body = (await response.json()) as { hostAccess: DockerHostAccessCatalog };
  return body.hostAccess;
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

export async function getDockerOperations(): Promise<DockerOperation[]> {
  const response = await fetch("/api/docker/operations");
  await ensureOk(response);
  const body = (await response.json()) as { operations: DockerOperation[] };
  return body.operations;
}

export async function runDockerOperation(input: DockerProposalInput): Promise<DockerProposalResult> {
  const response = await fetch("/api/docker/actions", {
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

export async function applyShareSettings(input: {
  settings: ShareSettingsInput;
}): Promise<{
  settings: ShareSettings;
  operation: ShareOperation;
}> {
  const response = await fetch("/api/shares/settings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return (await response.json()) as {
    settings: ShareSettings;
    operation: ShareOperation;
  };
}

export async function createStoragePool(input: {
  name: string;
  raidLevel: StorageRaidLevel;
  devices: string[];
  filesystem: StorageFilesystem;
  confirm: boolean;
}): Promise<{
  operation: StorageOperation;
}> {
  const response = await fetch("/api/storage/actions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action: "create_pool", ...input })
  });
  await ensureOk(response);
  return (await response.json()) as {
    operation: StorageOperation;
  };
}

export async function deleteStoragePool(input: {
  poolId: string;
  confirmation: string;
}): Promise<{
  operation: StorageOperation;
}> {
  const response = await fetch("/api/storage/actions", {
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

export async function getAgentCapabilityPolicySettings(): Promise<AgentCapabilityPolicySettings> {
  const response = await fetch("/api/settings/agent-capability-policy");
  await ensureOk(response);
  const body = (await response.json()) as { settings: AgentCapabilityPolicySettings };
  return body.settings;
}

export async function saveAgentCapabilityPolicySettings(
  input: Pick<AgentCapabilityPolicySettings, "policies">
): Promise<AgentCapabilityPolicySettings> {
  const response = await fetch("/api/settings/agent-capability-policy", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  const body = (await response.json()) as { settings: AgentCapabilityPolicySettings };
  return body.settings;
}

export async function getAgentMcpSettings(): Promise<AgentMcpSettings> {
  const response = await fetch("/api/settings/agent-mcp");
  await ensureOk(response);
  const body = (await response.json()) as { settings: AgentMcpSettings };
  return body.settings;
}

export async function saveAgentMcpSettings(enabled: boolean): Promise<AgentMcpSettings> {
  const response = await fetch("/api/settings/agent-mcp", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ enabled })
  });
  await ensureOk(response);
  const body = (await response.json()) as { settings: AgentMcpSettings };
  return body.settings;
}

export async function getSessions(): Promise<SessionSummary[]> {
  const response = await fetch("/api/sessions");
  await ensureOk(response);
  const body = (await response.json()) as { sessions: SessionSummary[] };
  return body.sessions;
}

export async function createSession(currentPath: string): Promise<Session> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path: currentPath })
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
  const body = (await response.json()) as { transcript: PersistedTranscriptMessage[] };
  return body.transcript;
}

export async function getFiles(storagePoolId: string, currentPath: string): Promise<FileListing> {
  const params = new URLSearchParams({
    storagePoolId,
    path: currentPath
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

export async function getMediaLibrarySettings(): Promise<MediaLibrarySettings> {
  return fetchJson<{ settings: MediaLibrarySettings }>("/api/media/settings").then((body) => body.settings);
}

export async function updateMediaLibrarySettings(input: {
  tmdbReadAccessToken?: string | null;
  language?: string;
  region?: string | null;
}): Promise<MediaLibrarySettings> {
  return fetchJson<{ settings: MediaLibrarySettings }>(
    "/api/media/settings",
    jsonRequest("PATCH", input)
  ).then((body) => body.settings);
}

export async function getMediaSources(): Promise<MediaSource[]> {
  return fetchJson<{ sources: MediaSource[] }>("/api/media/sources").then((body) => body.sources);
}

export async function createMediaSource(input: {
  name: string;
  kind: MediaSourceKind;
  storagePoolId: string;
  path: string;
}): Promise<{ source: MediaSource; scan: MediaScanRun }> {
  return fetchJson<{ source: MediaSource; scan: MediaScanRun }>(
    "/api/media/sources",
    jsonRequest("POST", input)
  );
}

export async function updateMediaSource(
  id: string,
  patch: { name?: string; enabled?: boolean }
): Promise<MediaSource> {
  return fetchJson<{ source: MediaSource }>(
    `/api/media/sources/${encodeURIComponent(id)}`,
    jsonRequest("PATCH", patch)
  ).then((body) => body.source);
}

export async function deleteMediaSource(id: string): Promise<void> {
  const response = await fetch(`/api/media/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  await ensureOk(response);
}

export async function requestMediaScan(sourceId: string): Promise<MediaScanRun> {
  return fetchJson<{ scan: MediaScanRun }>(
    `/api/media/sources/${encodeURIComponent(sourceId)}/scan`,
    { method: "POST" }
  ).then((body) => body.scan);
}

export async function getMediaLibraryStatus(): Promise<MediaLibraryStatus> {
  return fetchJson<{ status: MediaLibraryStatus }>("/api/media/status").then((body) => body.status);
}

export async function getTvStatus(): Promise<TvModeStatus> {
  return fetchJson<{ status: TvModeStatus }>("/api/tv/status").then((body) => body.status);
}

export async function getMediaScans(sourceId?: string, limit = 20): Promise<MediaScanRun[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (sourceId) params.set("sourceId", sourceId);
  return fetchJson<{ scans: MediaScanRun[] }>(`/api/media/scans?${params.toString()}`).then((body) => body.scans);
}

export async function getMediaTitles(input: {
  kind?: MediaSourceKind;
  matchStatus?: MediaMatchStatus;
  query?: string;
  limit?: number;
} = {}): Promise<MediaTitleSummary[]> {
  const params = new URLSearchParams();
  if (input.kind) params.set("kind", input.kind);
  if (input.matchStatus) params.set("matchStatus", input.matchStatus);
  if (input.query) params.set("query", input.query);
  if (input.limit) params.set("limit", String(input.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return fetchJson<{ titles: MediaTitleSummary[] }>(`/api/media/titles${suffix}`).then((body) => body.titles);
}

export async function getMediaMatchCandidates(id: string, query?: string): Promise<MediaMatchCandidate[]> {
  const params = new URLSearchParams();
  if (query?.trim()) params.set("query", query.trim());
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return fetchJson<{ candidates: MediaMatchCandidate[] }>(
    `/api/media/titles/${encodeURIComponent(id)}/match-candidates${suffix}`
  ).then((body) => body.candidates);
}

export async function updateMediaMatch(
  id: string,
  input: { tmdbId?: number | null; excluded?: boolean }
): Promise<MediaTitleSummary> {
  return fetchJson<{ title: MediaTitleSummary }>(
    `/api/media/titles/${encodeURIComponent(id)}/match`,
    jsonRequest("PUT", input)
  ).then((body) => body.title);
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

export async function applyPhotoOperation(input: {
  assetIds: string[];
  operation: "move" | "trash";
  targetDirectory?: string;
}): Promise<{ operations: FileOperation[] }> {
  const response = await fetch("/api/photos/actions", jsonRequest("POST", input));
  await ensureOk(response);
  return (await response.json()) as { operations: FileOperation[] };
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

export async function getTerminalTabs(): Promise<TerminalTabState> {
  const response = await fetch("/api/terminal/tabs");
  await ensureOk(response);
  return (await response.json()) as TerminalTabState;
}

export async function initializeTerminalTabs(): Promise<TerminalTabState> {
  const response = await fetch("/api/terminal/tabs/initialize", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  await ensureOk(response);
  return (await response.json()) as TerminalTabState;
}

export async function createTerminalTab(): Promise<TerminalTabState> {
  const response = await fetch("/api/terminal/tabs", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
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
  storagePoolId: string,
  currentPath: string,
  query: string
): Promise<FileSearchResult> {
  const params = new URLSearchParams({
    storagePoolId,
    path: currentPath,
    q: query
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

export async function getIndexerStatus(storagePoolId?: string): Promise<IndexerStoragePoolStatus[]> {
  const params = new URLSearchParams();
  if (storagePoolId) {
    params.set("storagePoolId", storagePoolId);
  }
  const query = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/indexer/status${query}`);
  await ensureOk(response);
  const body = (await response.json()) as { storagePools: IndexerStoragePoolStatus[] };
  return body.storagePools;
}

export async function getIndexerOverview(storagePoolId?: string): Promise<IndexerOverview> {
  const params = new URLSearchParams();
  if (storagePoolId) params.set("storagePoolId", storagePoolId);
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

export async function getFileMeta(storagePoolId: string, currentPath: string): Promise<FileMeta> {
  const params = new URLSearchParams({
    storagePoolId,
    path: currentPath
  });
  const response = await fetch(`/api/files/meta?${params.toString()}`);
  await ensureOk(response);
  const body = (await response.json()) as { meta: FileMeta };
  return body.meta;
}

export async function getTextPreview(
  storagePoolId: string,
  currentPath: string,
  maxBytes = 64 * 1024
): Promise<TextPreview> {
  const params = new URLSearchParams({
    storagePoolId,
    path: currentPath,
    maxBytes: String(maxBytes)
  });
  const response = await fetch(`/api/files/text?${params.toString()}`);
  await ensureOk(response);
  return (await response.json()) as TextPreview;
}

export async function getEditableText(storagePoolId: string, currentPath: string): Promise<EditableText> {
  const params = new URLSearchParams({
    storagePoolId,
    path: currentPath
  });
  const response = await fetch(`/api/files/edit-text?${params.toString()}`);
  await ensureOk(response);
  return (await response.json()) as EditableText;
}

export async function saveEditableText(input: {
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
      storagePoolId: input.storagePoolId,
      path: input.currentPath,
      content: input.content,
      expectedModifiedAt: input.expectedModifiedAt
    })
  });
  await ensureOk(response);
  return (await response.json()) as SaveEditableTextResult;
}

export async function applyFileMutation(input: {
  storagePoolId: string;
  operation: "mkdir" | "rename" | "copy";
  sourcePath?: string;
  targetName?: string;
  targetPath?: string;
}): Promise<FileMutationResult> {
  const response = await fetch("/api/files/mutations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return (await response.json()) as FileMutationResult;
}

export async function createFileBatch(input: {
  storagePoolId: string;
  operation: "move" | "trash";
  sourcePaths: string[];
  targetDirectory?: string;
}): Promise<FileBatch> {
  const response = await fetch("/api/files/batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  await ensureOk(response);
  return ((await response.json()) as { batch: FileBatch }).batch;
}

export async function getFileBatches(input: {
  storagePoolId?: string | null;
  limit?: number;
} = {}): Promise<FileBatch[]> {
  const params = new URLSearchParams();
  if (input.storagePoolId) params.set("storagePoolId", input.storagePoolId);
  params.set("limit", String(input.limit ?? 50));
  const response = await fetch(`/api/files/batches?${params.toString()}`);
  await ensureOk(response);
  return ((await response.json()) as { batches: FileBatch[] }).batches;
}

export async function cancelFileBatch(batchId: string): Promise<FileBatch> {
  const response = await fetch(`/api/files/batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST" });
  await ensureOk(response);
  return ((await response.json()) as { batch: FileBatch }).batch;
}

export async function extractFile(input: { storagePoolId: string; path: string }): Promise<ExtractFileResult> {
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
  storagePoolId: string;
  path: string;
  file: File;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}): Promise<UploadFileResult> {
  return await new Promise<UploadFileResult>((resolve, reject) => {
    const params = new URLSearchParams({
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

export function getFileBlobUrl(storagePoolId: string, currentPath: string): string {
  const params = new URLSearchParams({
    storagePoolId,
    path: currentPath
  });
  return `/api/files/blob?${params.toString()}`;
}

export function getFileDownloadUrl(storagePoolId: string, currentPath: string): string {
  const params = new URLSearchParams({
    storagePoolId,
    path: currentPath,
    download: "1"
  });
  return `/api/files/blob?${params.toString()}`;
}

export async function createFileExport(input: {
  storagePoolId: string;
  sourcePaths: string[];
}): Promise<FileExportResult> {
  const response = await fetch("/api/files/exports", jsonRequest("POST", input));
  await ensureOk(response);
  return (await response.json()) as FileExportResult;
}

export function getFileVideoUrl(storagePoolId: string, currentPath: string): string {
  const params = new URLSearchParams({
    storagePoolId,
    path: currentPath
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

export async function getApprovals(sessionId: string): Promise<ApprovalQueue> {
  const response = await fetch(`/api/approvals?sessionId=${encodeURIComponent(sessionId)}`);
  await ensureOk(response);
  return (await response.json()) as ApprovalQueue;
}

export async function decideCapabilityApproval(
  approval: Pick<CapabilityApproval, "id" | "revision" | "sessionId">,
  decision: "approved" | "rejected",
  options: { confirmed?: boolean; secretInput?: Record<string, string> } = {}
): Promise<void> {
  const response = await fetch(`/api/capability-approvals/${encodeURIComponent(approval.id)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: approval.sessionId,
      decision,
      expectedRevision: approval.revision,
      confirmed: options.confirmed === true,
      ...(options.secretInput ? { secretInput: options.secretInput } : {})
    })
  });
  await ensureOk(response);
}

export async function getNotifications(limit = 100): Promise<NotificationListResult> {
  const response = await fetch(`/api/notifications?limit=${limit}`);
  await ensureOk(response);
  return (await response.json()) as NotificationListResult;
}

export async function getNotificationsSummary(): Promise<NotificationSummary> {
  return fetchJson<NotificationSummary>("/api/notifications/summary");
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

export async function markBluetoothTransferRead(id: string): Promise<{
  transfer: BluetoothTransfer;
  unreadCount: number;
}> {
  return fetchJson<{ transfer: BluetoothTransfer; unreadCount: number }>(
    `/api/notifications/bluetooth/${encodeURIComponent(id)}/read`,
    { method: "PATCH" }
  );
}

export async function markAllBluetoothTransfersRead(): Promise<number> {
  const result = await fetchJson<{ updated: number }>(
    "/api/notifications/bluetooth/read-all",
    { method: "POST" }
  );
  return result.updated;
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

export async function sendMessage(
  sessionId: string,
  content: string,
  path?: string
): Promise<{ job: Job; transcriptMessage: TranscriptMessage }> {
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content, ...(path ? { path } : {}) })
  });
  await ensureOk(response);
  const body = (await response.json()) as {
    job: Job;
    transcriptMessage?: PersistedTranscriptMessage;
  };
  if (!body.transcriptMessage) throw new Error("Message response did not include a transcript message");
  return { job: body.job, transcriptMessage: body.transcriptMessage };
}

export async function sendAgentSessionCommand(
  sessionId: string,
  type: AgentSessionCommandType,
  payload: Record<string, unknown> = {}
): Promise<AgentSessionCommand> {
  const response = await fetch(`/api/sessions/${sessionId}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      payload,
      idempotencyKey: createClientId()
    })
  });
  await ensureOk(response);
  return ((await response.json()) as { command: AgentSessionCommand }).command;
}

export async function retryAgentJob(
  jobId: string
): Promise<{ job: Job; transcriptMessage: TranscriptMessage }> {
  const response = await fetch(`/api/jobs/${jobId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: createClientId() })
  });
  await ensureOk(response);
  return (await response.json()) as { job: Job; transcriptMessage: TranscriptMessage };
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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  await ensureOk(response);
  return (await response.json()) as T;
}

async function fetchEmpty(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  await ensureOk(response);
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
