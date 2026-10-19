import type { PhotostaffMediaKind } from "./photostaff-config.js";
import type { MonitoringHealthStatus } from "./monitoring.js";
import type { VodPlayerErrorCode, VodPlayerState } from "./vod-player-protocol.js";
import type { ZosPaths } from "./paths.js";

export type JobStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type JobKind = "agent" | "file_batch";

export type AgentEventAudience = "chat" | "notification";

export type OperationNotificationKind = "file" | "docker" | "vm" | "storage" | "share";

export type OperationNotificationStatus =
  | "pending_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "applied"
  | "failed";

export type FileOperationStatus = "proposed" | "applied" | "rolled_back" | "failed";

export type FileMutationOperation =
  | "mkdir"
  | "move"
  | "copy"
  | "rename"
  | "tag"
  | "trash"
  | "restore"
  | "edit"
  | "extract"
  | "upload"
  | "download";

export type DownloadTaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type DownloadTaskPhase =
  | "probing"
  | "downloading"
  | "verifying"
  | "publishing"
  | "retry_wait";

export type DownloadMode = "single" | "segmented";
export type DownloadControlRequest = "pause" | "cancel";
export type DownloadErrorCode =
  | "dns"
  | "ssrf_blocked"
  | "connect"
  | "timeout"
  | "tls"
  | "http_status"
  | "redirect_policy"
  | "range_protocol"
  | "source_changed"
  | "size_limit"
  | "disk_space"
  | "storage"
  | "target_conflict"
  | "checksum_mismatch"
  | "permission"
  | "database"
  | "internal";

export interface DownloadTaskRecord {
  id: string;
  url: string;
  rootId: string;
  storagePoolId: string;
  targetDirectory: string;
  targetFileName: string;
  targetPath: string;
  partialPath: string;
  status: DownloadTaskStatus;
  receivedBytes: number;
  totalBytes: number | null;
  speedBytesPerSecond: number;
  etag: string | null;
  lastModified: string | null;
  error: string | null;
  workerId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastProgressAt: string | null;
  fileOperationId: string | null;
  phase: DownloadTaskPhase | null;
  downloadMode: DownloadMode | null;
  expectedSha256: string | null;
  actualSha256: string | null;
  errorCode: DownloadErrorCode | null;
  errorRetryable: boolean;
  retryCount: number;
  nextRetryAt: string | null;
  controlRequested: DownloadControlRequest | null;
  segmentCount: number;
}

export interface DownloadTaskCreateInput {
  url: string;
  rootId: string;
  storagePoolId: string;
  targetDirectory: string;
  targetFileName: string;
  expectedSha256?: string | null;
}

export interface DownloadSettingsRecord {
  concurrency: number;
  parallelRequestsPerTask: number;
  segmentedDownloadMinBytes: number;
  maxAutoRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retryAfterMaxDelayMs: number;
  connectTimeoutMs: number;
  responseHeaderTimeoutMs: number;
  readIdleTimeoutMs: number;
  minFreeSpaceBytes: number;
  maxFileSizeBytes: number | null;
  updatedAt: string;
}

export type PublicDownloadSettings = DownloadSettingsRecord;

export interface DownloadWorkerHealth {
  status: "ready" | "stale" | "unavailable";
  freshWorkers: number;
  lastHeartbeatAt: string | null;
  activeTasks: number;
  queuedTasks: number;
  retryWaitTasks: number;
}

export type PhotostaffTakenAtSource = "exif" | "file_mtime";
export type PhotostaffAssetStatus = "ready" | "failed";
export type PhotostaffJobKind = "full_scan" | "path_refresh";
export type PhotostaffJobStatus = "queued" | "running" | "retrying" | "completed" | "failed";
export type PhotostaffJobPhase = "discovering" | "processing" | "publishing" | "cleanup" | "retry_wait";
export type PhotostaffErrorCode =
  | "PHOTOSTAFF_STORAGE_UNAVAILABLE"
  | "SOURCE_CHANGED"
  | "INVALID_PATH"
  | "UNSUPPORTED_MEDIA"
  | "CORRUPT_MEDIA"
  | "SIZE_LIMIT"
  | "DISK_SPACE"
  | "TOOL_UNAVAILABLE"
  | "COMMAND_TIMEOUT"
  | "COMMAND_FAILED"
  | "PUBLISH_CONFLICT"
  | "PERMISSION_DENIED"
  | "DATABASE"
  | "INTERNAL";

export interface PhotostaffLibrarySettingsRecord {
  rootId: string;
  storagePoolId: string;
  path: string;
  updatedAt: string;
}

export interface PhotostaffAssetRecord {
  id: string;
  rootId: string;
  storagePoolId: string;
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  takenAt: string;
  takenAtSource: PhotostaffTakenAtSource;
  thumbnailKey: string | null;
  previewKey: string | null;
  status: PhotostaffAssetStatus;
  error: string | null;
  errorCode: PhotostaffErrorCode | null;
  errorRetryable: boolean;
  derivativeSchemaVersion: number;
  indexedAt: string;
}

export interface PhotostaffProcessingSettingsRecord {
  processingConcurrency: number;
  scanIntervalMs: number;
  maxAutoRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  commandTimeoutMs: number;
  maxFileSizeBytes: number;
  maxXmpSizeBytes: number;
  maxIntermediateBytes: number;
  minFreeSpaceBytes: number;
  maxDecodedPixels: number;
  updatedAt: string;
}

export interface PhotostaffTimelinePage {
  photostaff: PhotostaffAssetRecord[];
  nextCursor: string | null;
}

/** Public Photos API timeline response. */
export interface PhotoTimelinePage {
  photos: PhotostaffAssetRecord[];
  nextCursor: string | null;
}

export type PhotostaffMetadataStatus = "ready" | "partial";
export type PhotostaffMetadataScalar = string | number | boolean;
export type PhotostaffMetadataValueType = "text" | "number" | "date" | "boolean";
export type PhotostaffMetadataCaptureSource = "sidecar_xmp" | "embedded_xmp" | "iptc" | "exif" | "video" | "file_mtime";

export interface PhotostaffMetadataSummary {
  schemaVersion: number;
  status: PhotostaffMetadataStatus;
  mediaKind: PhotostaffMediaKind;
  capturedAt: string | null;
  capturedAtLocal: string | null;
  captureOffsetMinutes: number | null;
  captureSource: PhotostaffMetadataCaptureSource;
  durationMs: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  software: string | null;
  lensMake: string | null;
  lensModel: string | null;
  iso: number | null;
  exposureTimeSeconds: number | null;
  aperture: number | null;
  focalLengthMm: number | null;
  focalLength35Mm: number | null;
  exposureBiasEv: number | null;
  exposureProgram: string | null;
  meteringMode: string | null;
  flash: string | null;
  whiteBalance: string | null;
  title: string | null;
  description: string | null;
  creator: string | null;
  copyright: string | null;
  rating: number | null;
  hasLocation: boolean;
  hasSensitiveMetadata: boolean;
}

export interface PhotostaffMetadataIndexStatus {
  schemaVersion: number;
  total: number;
  indexed: number;
  partial: number;
  pending: number;
}

export type PhotostaffMetadataOperator =
  | "eq"
  | "contains"
  | "prefix"
  | "in"
  | "exists"
  | "not_exists"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between";

export interface PhotostaffMetadataCondition {
  key: string;
  operator: PhotostaffMetadataOperator;
  value?: PhotostaffMetadataScalar | PhotostaffMetadataScalar[];
  valueTo?: string | number;
}

export interface PhotostaffNumberRange {
  min?: number;
  max?: number;
}

export interface PhotostaffDateRange {
  from?: string;
  to?: string;
}

export interface PhotostaffLocationBounds {
  kind: "bounds";
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface PhotostaffLocationNear {
  kind: "near";
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface PhotostaffQueryFilters {
  text?: string;
  capturedAt?: PhotostaffDateRange;
  mediaKinds?: PhotostaffMediaKind[];
  cameraModels?: string[];
  lensModels?: string[];
  iso?: PhotostaffNumberRange;
  aperture?: PhotostaffNumberRange;
  exposureTimeSeconds?: PhotostaffNumberRange;
  focalLengthMm?: PhotostaffNumberRange;
  rating?: PhotostaffNumberRange;
  keywords?: string[];
  hasLocation?: boolean;
  location?: PhotostaffLocationBounds | PhotostaffLocationNear;
  advanced?: {
    mode: "all" | "any";
    conditions: PhotostaffMetadataCondition[];
  };
}

export type PhotostaffQuerySortField = "captured_at" | "indexed_at" | "name" | "size_bytes" | "rating" | "distance";

export interface PhotostaffQueryRequest {
  filters?: PhotostaffQueryFilters;
  sort?: { field: PhotostaffQuerySortField; direction: "asc" | "desc" };
  cursor?: string | null;
  limit?: number;
  includeFacets?: boolean;
}

export interface PhotostaffQueryAsset extends PhotostaffAssetRecord {
  metadata: PhotostaffMetadataSummary | null;
  keywords: string[];
  distanceMeters: number | null;
}

export interface PhotostaffFacetValue {
  value: string;
  count: number;
}

export interface PhotostaffQueryFacets {
  mediaKinds: PhotostaffFacetValue[];
  cameraModels: PhotostaffFacetValue[];
  lensModels: PhotostaffFacetValue[];
  ratings: PhotostaffFacetValue[];
  keywords: PhotostaffFacetValue[];
  numeric: Record<string, { min: number | null; max: number | null }>;
}

export interface PhotostaffQueryPage {
  photostaff: PhotostaffQueryAsset[];
  nextCursor: string | null;
  total: number;
  facets: PhotostaffQueryFacets | null;
  metadataIndex: PhotostaffMetadataIndexStatus;
}

/** Public Photos API query response. */
export interface PhotoQueryPage {
  photos: PhotostaffQueryAsset[];
  nextCursor: string | null;
  total: number;
  facets: PhotostaffQueryFacets | null;
  metadataIndex: PhotostaffMetadataIndexStatus;
}

export interface PhotostaffMetadataField {
  key: string;
  valueType: PhotostaffMetadataValueType;
  count: number;
  sensitive: boolean;
}

export interface PhotostaffMetadataDetail {
  assetId: string;
  summary: PhotostaffMetadataSummary | null;
  keywords: string[];
  groups: Record<string, Record<string, PhotostaffMetadataScalar[]>>;
  sensitiveGroups?: Record<string, Record<string, PhotostaffMetadataScalar[]>>;
  sensitiveOmitted: boolean;
  warnings: string[];
}

export interface PhotostaffMapQueryRequest {
  filters?: PhotostaffQueryFilters;
  bounds: PhotostaffLocationBounds;
  columns?: number;
  rows?: number;
}

export interface PhotostaffMapCluster {
  latitude: number;
  longitude: number;
  count: number;
  assetId: string | null;
}

export interface PhotostaffMapQueryResult {
  clusters: PhotostaffMapCluster[];
  metadataIndex: PhotostaffMetadataIndexStatus;
}

export interface PhotostaffMapSettingsRecord {
  rootId: string;
  storagePoolId: string;
  path: string;
  tileType: "png" | "jpeg" | "webp";
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number] | null;
  attribution: string | null;
  updatedAt: string;
}

export interface PhotostaffManagedMapInfo {
  name: string;
  version: string;
  attribution: string | null;
  sizeBytes: number;
}

export interface PhotostaffManagedMapSettings extends PhotostaffManagedMapInfo {
  tileType: "png" | "jpeg" | "webp";
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number] | null;
  updatedAt: string;
}

export type PhotostaffMapDownloadState = "not_downloaded" | "downloading" | "ready" | "failed";

export interface PhotostaffMapDownloadStatus {
  state: PhotostaffMapDownloadState;
  receivedBytes: number;
  totalBytes: number;
  error: string | null;
}

export interface PhotostaffMapSettingsResponse {
  map: PhotostaffManagedMapInfo;
  settings: PhotostaffManagedMapSettings | null;
  download: PhotostaffMapDownloadStatus;
}

export interface PhotostaffJobRecord {
  id: string;
  kind: PhotostaffJobKind;
  status: PhotostaffJobStatus;
  rootId: string;
  storagePoolId: string;
  path: string;
  libraryUpdatedAt: string;
  scanned: number;
  processed: number;
  failed: number;
  currentPath: string | null;
  phase: PhotostaffJobPhase | null;
  error: string | null;
  errorCode: PhotostaffErrorCode | null;
  errorRetryable: boolean;
  retryCount: number;
  nextRetryAt: string | null;
  scanGeneration: string;
  workerId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PhotostaffLibraryStatus {
  state: "unconfigured" | "queued" | "discovering" | "processing" | "retrying" | "ready" | "degraded" | "offline";
  total: number;
  metadataIndex?: PhotostaffMetadataIndexStatus;
  failed: number;
  scanned: number;
  processed: number;
  currentPath: string | null;
  phase: PhotostaffJobPhase | null;
  error: string | null;
  errorCode: PhotostaffErrorCode | null;
  retryCount: number;
  nextRetryAt: string | null;
  updatedAt: string | null;
}

export interface PhotostaffWorkerHealth {
  status: "ready" | "stale" | "unavailable";
  freshWorkers: number;
  lastHeartbeatAt: string | null;
  activeJobs: number;
  queuedJobs: number;
  retryingJobs: number;
}

// Public Photos API and Web names. The underlying records remain owned by the
// internal Photostaff service and database implementation.
export type PhotoAssetRecord = PhotostaffAssetRecord;
export type PhotoJobRecord = PhotostaffJobRecord;
export type PhotoLibrarySettingsRecord = PhotostaffLibrarySettingsRecord;
export type PhotoLibraryStatus = PhotostaffLibraryStatus;
export type PhotoProcessingSettingsRecord = PhotostaffProcessingSettingsRecord;
export type PhotoWorkerHealth = PhotostaffWorkerHealth;
export type PhotoLocationBounds = PhotostaffLocationBounds;
export type PhotoLocationNear = PhotostaffLocationNear;
export type PhotoMetadataCondition = PhotostaffMetadataCondition;
export type PhotoMetadataDetail = PhotostaffMetadataDetail;
export type PhotoMetadataField = PhotostaffMetadataField;
export type PhotoQueryAsset = PhotostaffQueryAsset;
export type PhotoQueryFacets = PhotostaffQueryFacets;
export type PhotoQueryFilters = PhotostaffQueryFilters;
export type PhotoQueryRequest = PhotostaffQueryRequest;
export type PhotoQuerySortField = PhotostaffQuerySortField;
export type PhotoMapQueryRequest = PhotostaffMapQueryRequest;
export type PhotoMapQueryResult = PhotostaffMapQueryResult;
export type PhotoManagedMapSettings = PhotostaffManagedMapSettings;
export type PhotoMapSettingsResponse = PhotostaffMapSettingsResponse;

export type GitFileStatus = "tracked" | "staged" | "modified" | "untracked" | "conflicted";

export interface GitStatusSummary {
  tracked: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
}

export interface GitDirectoryStatus {
  repositoryName: string;
  repositoryPath: string;
  currentPath: string;
  branch: string | null;
  headSha: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  summary: GitStatusSummary;
}

export type PendingApprovalKind =
  | "file_operation"
  | "pi_tool_call"
  | "docker_operation"
  | "vm_operation"
  | "share_operation"
  | "storage_operation";

export type PiToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export type PiToolPolicyMode = "auto" | "ask" | "disabled";

export type PiDangerousToolPolicyMode = Exclude<PiToolPolicyMode, "auto">;

export type AgentEventType =
  | "agent.started"
  | "agent.message"
  | "agent.completed"
  | "agent.failed"
  | "tool_call.started"
  | "tool_call.completed"
  | "tool_call.failed"
  | "approval.pending"
  | "job.running"
  | "job.completed"
  | "job.failed"
  | "job.cancelled";

export interface NasRootConfig {
  id: string;
  name: string;
  path: string;
  mountPolicy?: MountPolicy;
  expectedSource?: string | null;
  expectedUuid?: string | null;
  expectedFstype?: string | null;
}

export type DeploymentMode = "development" | "production";
export type MountPolicy = "required" | "optional";
export type RootReadinessStatus = "ready" | "not_ready" | "unknown" | "config_invalid";

export interface RootReadiness {
  rootId: string;
  status: RootReadinessStatus;
  checkedAt: string | null;
  reason: string | null;
  source: string | null;
  uuid: string | null;
  fstype: string | null;
}

export interface BackupConfig {
  enabled: boolean;
  repositoryPath: string | null;
  passwordFile: string | null;
  stagingPath: string;
  requireMount: boolean;
  retryCount: number;
  timeoutMs: number;
  keepDaily: number;
  keepWeekly: number;
}

export type BackupRunKind = "daily" | "weekly" | "check" | "restore";
export type BackupRunStatus = "never_run" | "validating" | "running" | "completed" | "failed" | "interrupted";

export interface BackupFailure {
  rootId?: string;
  path?: string;
  reason: string;
  code?: string;
}

export interface BackupRunSummary {
  id: string;
  kind: BackupRunKind;
  status: BackupRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  snapshotIds: string[];
  files: number;
  bytes: number;
  verified: boolean;
  error: string | null;
  failures: BackupFailure[];
}

export type HealthAlertSeverity = "warning" | "critical";
export type HealthAlertStatus = "active" | "resolved";

export const OPS_TASKS = ["health", "maintenance"] as const;
export type OpsTask = (typeof OPS_TASKS)[number];
export type OpsRunStatus = "running" | "completed" | "failed" | "interrupted";
export type OpsTaskStatus = "never_run" | "running" | "ready" | "failed" | "stale";

export interface OpsRunRecord {
  id: string;
  task: OpsTask;
  status: OpsRunStatus;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  summary: Record<string, unknown> | null;
  error: string | null;
}

export interface OpsTaskOverview {
  task: OpsTask;
  status: OpsTaskStatus;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  error: string | null;
}

export interface SystemOperationsResponse {
  tasks: Record<OpsTask, OpsTaskOverview>;
  runs: OpsRunRecord[];
}

export interface OpsMaintenanceSummary {
  generatedAt: string;
  walCheckpoint: {
    busy: number;
    logFrames: number;
    checkpointedFrames: number;
  };
  trash: {
    unrestoredEntries: number;
  };
  restoreStaging: {
    status: "completed" | "deferred";
    removed: number;
    reason: string | null;
  };
  retention: {
    operationNotificationsRemoved: number;
    backupRunsRemoved: number;
    resolvedAlertsRemoved: number;
  };
}

export interface IndexerMetrics {
  durationMs: number | null;
  scanRate: number | null;
  bytes: number;
  fileCount: number;
  textFileCount: number;
  indexSizeBytes: number | null;
  freshnessMs: number | null;
  consecutiveFailures: number;
}

export interface IndexerProgress {
  phase: string | null;
  currentPath: string | null;
  lastProgressAt: string | null;
}

export interface IndexerAlert {
  id: string;
  code: string;
  rootId: string | null;
  severity: HealthAlertSeverity;
  status: HealthAlertStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  details: string | null;
}

export type IndexRunKind = "full" | "incremental" | "manual";
export type IndexQueueStatus = "queued" | "running" | "retrying" | "failed";
export type IndexExtractionSource = "plain_text" | "pdftotext" | "docx" | "xlsx" | "pptx" | "ocr";
export type IndexExtractionStatus = "pending" | "ready" | "stale" | "error" | "skipped";
export type IndexWatcherStatus = "starting" | "ready" | "degraded" | "unsupported";
export type IndexRebuildStatus = "legacy" | "copying" | "rebuilding" | "ready" | "failed";

export interface IndexerSettingsRecord {
  scanConcurrency: number;
  extractionConcurrency: number;
  reconciliationIntervalMs: number;
  maxExtractedTextBytes: number;
  maxSourceDocumentBytes: number;
  commandTimeoutMs: number;
  maxPdfTextPages: number;
  maxOcrPages: number;
  ocrRootIds: string[];
  updatedAt: string;
}

export interface IndexerWorkerHealth {
  status: "ready" | "stale" | "unavailable";
  freshWorkers: number;
  lastHeartbeatAt: string | null;
}

export interface IndexerWatcherHealth {
  status: IndexWatcherStatus;
  degradedRoots: string[];
  reason: string | null;
}

export interface IndexerQueueHealth {
  queued: number;
  running: number;
  retrying: number;
  failed: number;
  oldestQueuedAt: string | null;
  stalled: boolean;
}

export interface IndexerRebuildHealth {
  status: IndexRebuildStatus;
  copied: number;
  total: number;
  rootsReady: number;
  rootsTotal: number;
}

export interface IndexerServiceStatus {
  service: IndexerWorkerHealth;
  watcher: IndexerWatcherHealth;
  queue: IndexerQueueHealth;
  rebuild: IndexerRebuildHealth;
}

export type IndexSearchCategory = "text" | "document" | "spreadsheet" | "presentation" | "pdf" | "other";
export type IndexSearchSortField = "relevance" | "name" | "mtime" | "size";

export interface IndexSearchRequest {
  rootId: string;
  storagePoolId: string;
  path?: string;
  query?: string;
  mimeTypes?: string[];
  categories?: IndexSearchCategory[];
  modifiedFrom?: string;
  modifiedTo?: string;
  sizeMin?: number;
  sizeMax?: number;
  extractionSources?: IndexExtractionSource[];
  extractionStatuses?: IndexExtractionStatus[];
  sort?: { field: IndexSearchSortField; direction: "asc" | "desc" };
  cursor?: string | null;
  limit?: number;
}

export interface IndexSearchHighlightRange {
  start: number;
  end: number;
}

export interface IndexSearchResult {
  fileId: string;
  rootId: string;
  path: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  mtimeMs: number;
  score: number | null;
  snippet: string;
  highlightRanges: IndexSearchHighlightRange[];
  extractionSource: IndexExtractionSource | null;
  extractionStatus: IndexExtractionStatus;
}

export interface IndexSearchPage {
  files: IndexSearchResult[];
  nextCursor: string | null;
}

export interface IndexReindexRequest {
  rootId: string;
  path?: string;
  recursive?: boolean;
}

export interface SystemHealthSummary {
  status: "ready" | "degraded" | "failed";
  checkedAt: string;
  issues: Array<{
    code: string;
    severity: HealthAlertSeverity;
    rootId?: string;
    message: string;
  }>;
  roots: RootReadiness[];
  indexerFreshnessMs: number | null;
  backupFreshnessMs: number | null;
  downloader: DownloadWorkerHealth;
  indexer?: IndexerServiceStatus;
  photostaff: PhotostaffWorkerHealth;
  vodPlayer: VodPlayerHealth;
  operations: Record<OpsTask, OpsTaskOverview>;
  monitoring?: MonitoringHealthStatus;
}

export interface VodPlayerHealth {
  status: "disabled" | "ready" | "degraded" | "critical";
  state: VodPlayerState | null;
  errorCode: VodPlayerErrorCode | null;
  checkedAt: string;
}

export interface DockerConfig {
  enabled: boolean;
  socketPath: string;
  composeCommand: string;
  operationTimeoutMs: number;
  consoleShells: string[];
}

export interface DockerSettingsRecord extends DockerConfig {
  updatedAt: string;
}

export type PublicDockerSettings = DockerSettingsRecord;

export const SHARE_PROTOCOLS = ["smb", "webdav", "ftp", "nfs", "dlna"] as const;

export type ShareProtocol = (typeof SHARE_PROTOCOLS)[number];

export type ShareOperationAction = "apply_settings";

export type ShareOperationStatus = "proposed" | "approved" | "applied" | "failed";

export type ShareProtocolServiceStatus = "disabled" | "active" | "inactive" | "failed" | "unknown";

export type DlnaMediaType = "audio" | "video" | "pictures";

export interface ShareAccountConfig {
  username: string;
  password: string | null;
}

export interface PublicShareAccountConfig {
  username: string;
  passwordConfigured: boolean;
}

export interface SmbShareConfig {
  enabled: boolean;
  readOnly: boolean;
  browseable: boolean;
  allowGuest: boolean;
}

export interface WebDavShareConfig {
  enabled: boolean;
  readOnly: boolean;
  allowGuest: boolean;
  port: number;
  pathPrefix: string;
}

export interface FtpShareConfig {
  enabled: boolean;
  readOnly: boolean;
  allowGuest: boolean;
  port: number;
  passivePortStart: number;
  passivePortEnd: number;
}

export interface NfsShareConfig {
  enabled: boolean;
  readOnly: boolean;
  allowedCidrs: string[];
  rootSquash: boolean;
}

export interface DlnaShareConfig {
  enabled: boolean;
  mediaTypes: DlnaMediaType[];
  bindInterface: string | null;
  bindAddress: string | null;
  friendlyName: string;
}

export interface ShareProtocolConfig {
  smb: SmbShareConfig;
  webdav: WebDavShareConfig;
  ftp: FtpShareConfig;
  nfs: NfsShareConfig;
  dlna: DlnaShareConfig;
}

export interface ShareDefinitionConfig {
  id: string;
  name: string;
  rootId: string;
  path: string;
  description: string;
  protocols: ShareProtocolConfig;
}

export interface ShareConfig {
  enabled: boolean;
  account: ShareAccountConfig;
  shares: ShareDefinitionConfig[];
}

export interface HostdConfig {
  socketPath: string;
}

export interface TerminalConfig {
  user: string | null;
  termuxSocketPath: string;
  sessionIdleTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxSessions?: number;
}

export interface TerminalTab {
  id: string;
  rootId: string;
  ordinal: number;
  customTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalTabState {
  initialized: boolean;
  tabs: TerminalTab[];
  activeTabId: string | null;
  maxSessions: number;
}

export interface VodPlayerConfig {
  enabled: boolean;
  socketPath: string;
  statePath: string;
  commandTimeoutMs: number;
  startupTimeoutMs: number;
  checkpointIntervalMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  videoOutput: "drm";
  drmConnector: string | null;
  audioOutput: "alsa";
  audioDevice: string | null;
  hwdec: "auto-safe" | "auto" | "no";
  user: string;
}

export interface ShareSettingsRecord extends ShareConfig {
  updatedAt: string;
}

export interface PublicShareSettings extends Omit<ShareSettingsRecord, "account"> {
  account: PublicShareAccountConfig;
}

export interface ZosConfig {
  environment?: DeploymentMode;
  rootDir?: string;
  paths?: ZosPaths;
  stateDir?: string;
  dataRoot?: string;
  appsRoot?: string;
  isoRoot?: string;
  vmRoot?: string;
  backupRoot?: string;
  dataDir: string;
  databasePath: string;
  metricsDatabasePath?: string;
  api: {
    host: string;
    port: number;
    allowedOrigins: string[];
  };
  worker: {
    pollMs: number;
  };
  admin: {
    displayName: string;
    authMode: "local-only";
  };
  model: {
    provider: "pi" | "cloud" | "local";
    piCommand: string;
    localEndpoint: string | null;
  };
  docker: DockerConfig;
  vm?: VmConfig;
  hostd: HostdConfig;
  shares: ShareConfig;
  terminal: TerminalConfig;
  vodPlayer: VodPlayerConfig;
  photostaff?: {
    baseMapUrl: string;
  };
  nasRoots: NasRootConfig[];
  backup?: BackupConfig;
  health?: {
    staleIndexWarningMs: number;
    staleIndexCriticalMs: number;
    stalledRunMs: number;
    consecutiveFailureThreshold: number;
    backupStaleMs: number;
  };
  monitoring?: MonitoringConfig;
}

export interface MonitoringConfig {
  enabled: boolean;
  fastSampleIntervalMs: number;
  standardSampleIntervalMs: number;
  temperatureSampleIntervalMs: number;
  rawRetentionMs: number;
  minuteRetentionMs: number;
  hourRetentionMs: number;
  maxDatabaseBytes: number;
}

export interface VmConfig {
  enabled: boolean;
  libvirtUri: string;
  storagePath: string;
  networkName: string;
  isoRoots: string[];
  operationTimeoutMs: number;
  consoleMode: "serial";
}

export const MODEL_PROVIDER_NAMES = ["openai", "anthropic"] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

export type ModelProviderKind = ModelProviderName;

export interface ModelProviderSettingsRecord {
  providerName: ModelProviderName;
  baseUrl: string | null;
  model: string;
  apiKey: string | null;
  updatedAt: string;
}

export interface PublicModelProviderSettings {
  providerName: ModelProviderName;
  baseUrl: string | null;
  model: string;
  apiKeyConfigured: boolean;
  updatedAt: string;
}

export function isModelProviderName(value: unknown): value is ModelProviderName {
  return (
    typeof value === "string" &&
    (MODEL_PROVIDER_NAMES as readonly string[]).includes(value.trim() as ModelProviderName)
  );
}

export type BuildSource = "release" | "ci" | "local" | "unknown";

export interface PublicBuildInfo {
  version: string;
  commitSha: string | null;
  commitShortSha: string | null;
  tag: string | null;
  branch: string | null;
  builtAt: string | null;
  source: BuildSource;
  dirty: boolean | null;
}

export interface PublicSystemInfo {
  collectedAt: string;
  identity: {
    hostname: string;
    adminDisplayName: string;
    authMode: "local-only";
    timezone: string;
  };
  operatingSystem: {
    type: string;
    platform: NodeJS.Platform;
    release: string;
    version: string;
    arch: string;
    machine: string;
    endianness: "BE" | "LE";
    uptimeSeconds: number;
    loadAverage: number[];
    availableParallelism: number;
  };
  hardware: {
    cpuModel: string | null;
    cpuSpeedMHz: number | null;
    cpuThreads: number;
    cpus: PublicSystemInfoCpu[];
    memory: PublicSystemInfoMemory;
  };
  storage: {
    volumes: PublicSystemInfoStorageVolume[];
  };
  network: {
    interfaces: PublicSystemInfoNetworkAddress[];
  };
  runtime: {
    nodeVersion: string;
    versions: Record<string, string>;
    pid: number;
    uptimeSeconds: number;
    cwd: string;
    execPath: string;
    memory: PublicSystemInfoProcessMemory;
  };
  zos: {
    rootDir: string;
    stateDir: string;
    dataRoot: string;
    appsRoot: string;
    isoRoot: string;
    vmRoot: string;
    backupRoot: string;
    dataDir: string;
    databasePath: string;
    apiHost: string;
    apiPort: number;
    allowedOriginCount: number;
    workerPollMs: number;
    modelProvider: "pi" | "cloud" | "local";
    localEndpointConfigured: boolean;
    dockerEnabled: boolean;
    photostaff: {
      dataDir: string;
      maxFileSizeBytes: number;
      thumbnailSizePx: number;
      previewMaxEdgePx: number;
      supportedExtensions: string[];
    };
    nasRoots: NasRootConfig[];
  };
}

export interface PublicSystemInfoCpu {
  model: string;
  speedMHz: number;
  times: {
    userMs: number;
    niceMs: number;
    systemMs: number;
    idleMs: number;
    irqMs: number;
  };
}

export interface PublicSystemInfoMemory {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface PublicSystemInfoProcessMemory {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface PublicSystemInfoStorageVolume {
  id: string;
  label: string;
  kind: "data" | "database" | "nas-root";
  path: string;
  status: "ready" | "error";
  blockSizeBytes: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
  availableBytes: number | null;
  usedBytes: number | null;
  usedPercent: number | null;
  rootId: string | null;
  error: string | null;
}

export interface PublicSystemInfoNetworkAddress {
  name: string;
  address: string;
  family: string;
  mac: string;
  internal: boolean;
  cidr: string | null;
  netmask: string;
  scopeId: number | null;
}

export type SystemPowerAction = "reboot" | "shutdown";

export interface SystemPowerResult {
  action: SystemPowerAction;
  accepted: true;
}

export type SystemCollectionStatus = "ready" | "partial" | "unavailable";

export interface SystemCollectionIssue {
  source: string;
  message: string;
}

export type SystemNetworkInterfaceKind =
  | "ethernet"
  | "wireless"
  | "loopback"
  | "bridge"
  | "bond"
  | "vlan"
  | "virtual"
  | "unknown";

export type SystemNetworkInterfaceState = "connected" | "up" | "down" | "unknown";

export interface SystemNetworkAddress {
  family: "inet" | "inet6" | "unknown";
  address: string;
  prefixLength: number | null;
  cidr: string | null;
  scope: string | null;
  label: string | null;
}

export interface SystemNetworkInterface {
  id: string;
  index: number | null;
  name: string;
  kind: SystemNetworkInterfaceKind;
  state: SystemNetworkInterfaceState;
  operState: string | null;
  flags: string[];
  mac: string | null;
  mtu: number | null;
  speedMbps: number | null;
  addresses: SystemNetworkAddress[];
  hasDefaultRoute: boolean;
}

export interface SystemNetworkRoute {
  family: "inet" | "inet6" | "unknown";
  destination: string;
  gateway: string | null;
  device: string | null;
  preferredSource: string | null;
  protocol: string | null;
  scope: string | null;
}

export type SystemNetworkBackend = "NetworkManager" | "systemd-networkd" | "unknown";
export type SystemWifiBand = "auto" | "2.4" | "5";
export type SystemWifiSecurity = "open" | "wpa2" | "wpa3" | "unsupported";
export type SystemWifiDeviceState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "hotspot"
  | "unavailable";

export interface SystemWifiDevice {
  id: string;
  name: string;
  mac: string | null;
  driver: string | null;
  state: SystemWifiDeviceState;
  mode: "client" | "hotspot" | "idle";
  activeConnectionId: string | null;
  activeConnectionName: string | null;
  ssid: string | null;
  signal: number | null;
  frequencyMHz: number | null;
  channel: number | null;
  managementPath: boolean;
  capabilities: {
    accessPoint: boolean;
    bands: Array<Exclude<SystemWifiBand, "auto">>;
    channels: number[];
  };
}

export interface SystemWifiAccessPoint {
  ssid: string;
  bssid: string;
  signal: number;
  frequencyMHz: number;
  channel: number;
  band: Exclude<SystemWifiBand, "auto">;
  security: SystemWifiSecurity;
  active: boolean;
  savedProfileId: string | null;
}

export interface SystemWifiProfile {
  id: string;
  name: string;
  ssid: string;
  device: string | null;
  security: SystemWifiSecurity;
  autoconnect: boolean;
  active: boolean;
  managed: boolean;
  credentialConfigured: boolean;
  revision: string | null;
}

export interface SystemWifiHotspot {
  device: string;
  profileId: string;
  ssid: string;
  band: SystemWifiBand;
  channel: number | null;
  autostart: boolean;
  active: boolean;
  credentialConfigured: boolean;
  revision: string;
  restoreProfileId: string | null;
}

export interface SystemWifiStatus {
  collectedAt: string;
  backend: SystemNetworkBackend;
  radioEnabled: boolean | null;
  hostdReady: boolean;
  devices: SystemWifiDevice[];
  hotspots: SystemWifiHotspot[];
}

export interface SystemWifiSummary extends SystemWifiStatus {
  profiles: SystemWifiProfile[];
}

export interface SystemWifiScanInput {
  device: string;
}

export interface SystemWifiScanResult {
  device: string;
  scannedAt: string;
  accessPoints: SystemWifiAccessPoint[];
}

export interface SystemWifiConnectInput {
  device: string;
  profileId?: string;
  ssid?: string;
  bssid?: string;
  security?: Exclude<SystemWifiSecurity, "unsupported">;
  password?: string;
  autoconnect?: boolean;
  confirmed: boolean;
}

export interface SystemWifiDisconnectInput {
  device: string;
  confirmed: boolean;
}

export interface SystemWifiRadioInput {
  enabled: boolean;
  confirmed: boolean;
}

export interface SystemWifiProfileUpdateInput {
  ssid?: string;
  security?: Exclude<SystemWifiSecurity, "unsupported">;
  password?: string;
  autoconnect?: boolean;
  expectedRevision: string;
  confirmed: boolean;
}

export interface SystemWifiHotspotUpdateInput {
  device: string;
  ssid: string;
  password?: string;
  band: SystemWifiBand;
  channel: number | null;
  autostart: boolean;
  expectedRevision?: string;
  confirmed: boolean;
}

export interface SystemWifiHotspotActionInput {
  device: string;
  confirmed: boolean;
}

export type SystemWifiRollbackResult = "not_required" | "succeeded" | "failed";

export interface SystemWifiOperationResult {
  status: SystemWifiStatus;
  rollback: SystemWifiRollbackResult;
  message: string | null;
}

export type SystemEthernetIPv4Mode = "disabled" | "dhcp" | "static";
export type SystemEthernetIPv6Mode = "disabled" | "automatic" | "static";
export type SystemEthernetDnsMode = "automatic" | "manual";
export type SystemEthernetManagementState = "managed" | "pending" | "external" | "external_unsupported";
export type SystemEthernetLinkState = "connected" | "up" | "down" | "disabled" | "unavailable";

export interface SystemEthernetIPv4Config {
  mode: SystemEthernetIPv4Mode;
  address: string | null;
  prefixLength: number | null;
  gateway: string | null;
  dnsMode: SystemEthernetDnsMode;
  dns: string[];
  useDefaultRoute: boolean;
  routeMetric: number;
}

export interface SystemEthernetIPv6Config {
  mode: SystemEthernetIPv6Mode;
  address: string | null;
  prefixLength: number | null;
  gateway: string | null;
  dnsMode: SystemEthernetDnsMode;
  dns: string[];
  useDefaultRoute: boolean;
  routeMetric: number;
}

export interface SystemEthernetConfig {
  enabled: boolean;
  ipv4: SystemEthernetIPv4Config;
  ipv6: SystemEthernetIPv6Config;
}

export interface SystemEthernetDevice {
  id: string;
  name: string;
  permanentMac: string;
  mac: string;
  driver: string | null;
  speedMbps: number | null;
  carrier: boolean;
  state: SystemEthernetLinkState;
  addresses: SystemNetworkAddress[];
  ipv4Gateway: string | null;
  ipv6Gateway: string | null;
  activeProfileId: string | null;
  activeProfileName: string | null;
  managementState: SystemEthernetManagementState;
  activeConfig: SystemEthernetConfig | null;
  desiredConfig: SystemEthernetConfig | null;
  revision: string;
  needsApply: boolean;
  warnings: string[];
}

export type SystemEthernetApplyStatus =
  | "applying"
  | "awaiting_confirmation"
  | "confirmed"
  | "rolling_back"
  | "rolled_back"
  | "failed";

export interface SystemEthernetApplyTransaction {
  id: string;
  status: SystemEthernetApplyStatus;
  deviceIds: string[];
  createdAt: string;
  deadlineAt: string | null;
  rollback: SystemWifiRollbackResult;
  error: string | null;
}

export interface SystemEthernetStatus {
  collectedAt: string;
  backend: SystemNetworkBackend;
  hostdReady: boolean;
  devices: SystemEthernetDevice[];
  transaction: SystemEthernetApplyTransaction | null;
  warnings: string[];
}

export interface SystemEthernetUpdateInput {
  config: SystemEthernetConfig;
  expectedRevision: string;
}

export interface SystemEthernetApplyInput {
  confirmed: boolean;
}

export interface SystemNetworkSummary {
  collectedAt: string;
  status: SystemCollectionStatus;
  capabilities: {
    backend: SystemNetworkBackend;
    canApplyConfiguration: boolean;
    canConfigureBridge: false;
    canConfigureBond: false;
    canConfigureVlan: false;
    canManageEthernet: boolean;
    canManageWifi: boolean;
    canManageHotspot: boolean;
    hostdReady: boolean;
  };
  metrics: {
    interfaces: number;
    connected: number;
    addresses: number;
    defaultRoutes: number;
  };
  interfaces: SystemNetworkInterface[];
  routes: SystemNetworkRoute[];
  ethernet: SystemEthernetStatus;
  wifi: SystemWifiSummary;
  issues: SystemCollectionIssue[];
}

export interface SystemNetworkTrafficInterface {
  id: string;
  name: string;
  rxBytes: number;
  txBytes: number;
}

export interface SystemNetworkTrafficSummary {
  collectedAt: string;
  interfaces: SystemNetworkTrafficInterface[];
}

export type SystemSmartHealth = "passed" | "failed" | "unknown" | "error";

export interface SystemSmartAttribute {
  id: number | null;
  name: string;
  current: number | null;
  worst: number | null;
  threshold: number | null;
  raw: string | null;
  flags: string | null;
  whenFailed: string | null;
}

export interface SystemSmartSelfTest {
  number: number | null;
  type: string | null;
  status: string | null;
  remainingPercent: number | null;
  lifetimeHours: number | null;
  firstErrorLba: number | null;
}

export interface SystemSmartSummary {
  health: SystemSmartHealth;
  available: boolean | null;
  enabled: boolean | null;
  protocol: string | null;
  firmwareVersion: string | null;
  temperatureCelsius: number | null;
  temperatureMinCelsius: number | null;
  temperatureMaxCelsius: number | null;
  powerOnHours: number | null;
  powerCycleCount: number | null;
  errorCount: number | null;
  selfTestStatus: string | null;
  percentageUsed: number | null;
  availableSparePercent: number | null;
  availableSpareThresholdPercent: number | null;
  unsafeShutdowns: number | null;
  criticalWarning: number | null;
  dataUnitsRead: number | null;
  dataUnitsWritten: number | null;
  hostReadCommands: number | null;
  hostWriteCommands: number | null;
  controllerBusyMinutes: number | null;
  warningTemperatureTimeMinutes: number | null;
  criticalTemperatureTimeMinutes: number | null;
  errorLogEntries: number | null;
  attributes: SystemSmartAttribute[];
  selfTests: SystemSmartSelfTest[];
  message: string | null;
}

export interface SystemStorageMount {
  id: string;
  source: string;
  target: string;
  filesystem: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
}

export interface SystemStoragePartition {
  id: string;
  name: string;
  path: string;
  parent: string | null;
  filesystem: string | null;
  label: string | null;
  uuid: string | null;
  sizeBytes: number | null;
  mountpoints: string[];
}

export interface SystemStorageDisk {
  id: string;
  name: string;
  path: string;
  model: string | null;
  serial: string | null;
  transport: string | null;
  rotational: boolean | null;
  sizeBytes: number | null;
  mountpoints: string[];
  partitions: SystemStoragePartition[];
  smart: SystemSmartSummary;
}

export interface SystemRaidArray {
  id: string;
  name: string;
  path: string;
  level: string | null;
  state: string | null;
  uuid: string | null;
  sizeBytes: number | null;
  activeDevices: number | null;
  totalDevices: number | null;
  failedDevices: number | null;
  spareDevices: number | null;
  memberDevices: string[];
}

export interface SystemStoragePool {
  id: string;
  name: string;
  raidPath: string;
  raidLevel: string | null;
  status: "ready" | "warning" | "offline" | "unknown";
  mountpoint: string | null;
  filesystem: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
  memberDevices: string[];
}

export interface SystemStorageSummary {
  collectedAt: string;
  status: SystemCollectionStatus;
  capabilities: {
    backend: "mdadm";
    canCreatePool: true;
    canDeletePool: boolean;
    canApplyConfiguration: false;
  };
  metrics: {
    pools: number;
    arrays: number;
    disks: number;
    totalBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
    smartPassed: number;
    smartFailed: number;
    smartUnknown: number;
  };
  pools: SystemStoragePool[];
  arrays: SystemRaidArray[];
  disks: SystemStorageDisk[];
  mounts: SystemStorageMount[];
  issues: SystemCollectionIssue[];
}

export interface PiToolPolicySettingsRecord {
  read: PiToolPolicyMode;
  grep: PiToolPolicyMode;
  find: PiToolPolicyMode;
  ls: PiToolPolicyMode;
  bash: PiDangerousToolPolicyMode;
  edit: PiDangerousToolPolicyMode;
  write: PiDangerousToolPolicyMode;
  updatedAt: string;
}

export type PublicPiToolPolicySettings = PiToolPolicySettingsRecord;

export interface AgentSessionRecord {
  id: string;
  rootId: string;
  currentPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProviderSessionRecord {
  sessionId: string;
  providerSessionId: string;
  sessionFile: string | null;
  providerName: ModelProviderName;
  model: string;
  settingsSnapshot: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

export interface JobRecord {
  id: string;
  sessionId: string;
  messageId: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export type FileBatchOperation = "move" | "trash";
export type FileBatchItemStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface FileBatchFailure {
  sourcePath: string;
  error: string;
}

export interface FileBatchRecord {
  id: string;
  jobId: string;
  sessionId: string;
  rootId: string;
  storagePoolId: string;
  operation: FileBatchOperation;
  targetDirectory: string | null;
  status: Extract<JobStatus, "queued" | "running" | "completed" | "failed" | "cancelled">;
  totalCount: number;
  completedCount: number;
  successCount: number;
  failedCount: number;
  cancelledCount: number;
  currentSourcePath: string | null;
  error: string | null;
  failures: FileBatchFailure[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AgentEventRecord<TPayload = unknown> {
  id: number;
  sessionId: string;
  jobId: string | null;
  type: AgentEventType;
  audience: AgentEventAudience;
  transcriptSequence: number | null;
  payload: TPayload;
  createdAt: string;
}

export interface OperationNotificationRecord {
  id: string;
  jobId: string;
  sessionId: string;
  kind: OperationNotificationKind;
  status: OperationNotificationStatus;
  summary: string;
  error: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NasRootRecord {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  mountPolicy?: MountPolicy;
  expectedSource?: string | null;
  expectedUuid?: string | null;
  expectedFstype?: string | null;
}

export type IndexRunStatus = "running" | "completed" | "failed" | "never_run";

export interface IndexFailure {
  path: string;
  reason: string;
}

export interface IndexRootRunSummary {
  rootId: string;
  status: IndexRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  scanned: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  failed: number;
  failures: IndexFailure[];
  progress?: IndexerProgress;
  metrics?: IndexerMetrics;
  history?: IndexRootRunSummary[];
  readiness?: RootReadiness;
  alerts?: IndexerAlert[];
}

export type IndexRootStatus = IndexRootRunSummary;

export interface ToolResult<T = unknown> {
  success: boolean;
  output: string;
  data?: T;
  shouldContinue: boolean;
}

export interface FileOperationProposal {
  operation: FileMutationOperation;
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
  toolName: PiToolName;
  args: Record<string, unknown>;
  cwd: string;
  risk: "low" | "medium" | "high";
  summary: string;
}

export type DockerContainerState = "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead" | "unknown";

export type DockerEngineStatus = "disabled" | "ready" | "unavailable";

export type DockerDaemonState =
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "failed"
  | "not_installed"
  | "reconnecting";

export interface DockerDaemonStatus {
  state: DockerDaemonState;
  loadState: string | null;
  activeState: string | null;
  subState: string | null;
  result: string | null;
  collectedAt: string;
}

export interface DockerDaemonConfigSnapshot {
  path: "/etc/docker/daemon.json";
  content: string;
  revision: string;
  exists: boolean;
  restartPending: boolean;
}

export interface DockerDaemonConfigUpdateInput {
  content: string;
  expectedRevision: string;
  restart: boolean;
  confirmed: boolean;
}

export type DockerDaemonRollbackStatus = "not_required" | "succeeded" | "failed";

export interface DockerDaemonConfigUpdateResult {
  snapshot: DockerDaemonConfigSnapshot;
  restarted: boolean;
  rollback: DockerDaemonRollbackStatus;
  error: string | null;
}

export type DockerOperationTargetType = "container" | "compose_project" | "console" | "volume" | "network";

export type DockerOperationAction =
  | "create"
  | "start"
  | "stop"
  | "restart"
  | "remove"
  | "compose_up"
  | "compose_down"
  | "compose_pull"
  | "compose_restart"
  | "console";

export type DockerOperationStatus = "proposed" | "approved" | "applied" | "failed";

export interface DockerResourceCapabilities {
  memoryLimit: boolean | null;
  swapLimit: boolean | null;
  cpuQuota: boolean | null;
  cpuShares: boolean | null;
  cpuset: boolean | null;
  pidsLimit: boolean | null;
}

export interface DockerEngineSummary {
  status: DockerEngineStatus;
  version: string | null;
  apiVersion: string | null;
  negotiatedApiVersion: string | null;
  operatingSystem: string | null;
  architecture: string | null;
  dockerRootDir: string | null;
  resourceCapabilities?: DockerResourceCapabilities;
  error: string | null;
}

export interface DockerImageSummary {
  id: string;
  shortId: string;
  tags: string[];
  digests: string[];
  createdAt: string | null;
  sizeBytes: number;
  sharedSizeBytes: number | null;
  architecture: string | null;
  containerCount: number | null;
}

export interface DockerRegistryCredentialSummary {
  id: string;
  name: string;
  serverAddress: string;
  username: string;
  credentialConfigured: boolean;
  updatedAt: string;
}

export interface DockerRegistryCredentialCreateInput {
  name: string;
  serverAddress: string;
  username: string;
  password: string;
}

export interface DockerRegistryCredentialUpdateInput {
  name?: string;
  serverAddress?: string;
  username?: string;
  password?: string;
}

export interface DockerImagePullInput {
  reference: string;
}

export interface DockerImagePullResult {
  reference: string;
}

export interface DockerImageRemoveInput {
  reference: string;
  confirmed: boolean;
}

export interface DockerImageRemoveResult {
  reference: string;
  deleted: string[];
  untagged: string[];
}

export interface DockerContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageId?: string | null;
  state: DockerContainerState;
  status: string;
  ports: string[];
  composeProject: string | null;
  composeService: string | null;
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
  createdAt: string | null;
}

export interface DockerContainerDetails extends DockerContainerSummary {
  command: string | null;
  entrypoint: string[];
  environment: string[];
  mounts: Array<{
    source: string;
    destination: string;
    mode: string;
    type: string;
  }>;
  networks: string[];
  restartPolicy: string | null;
  hostname: string | null;
  workingDir: string | null;
  labels: Record<string, string>;
}

export interface DockerNetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
  containerCount: number;
}

export interface DockerNetworkContainerDetails {
  id: string;
  name: string;
  endpointId: string | null;
  macAddress: string | null;
  ipv4Address: string | null;
  ipv6Address: string | null;
}

export interface DockerNetworkDetails extends DockerNetworkSummary {
  createdAt: string | null;
  enableIPv4: boolean | null;
  enableIPv6: boolean | null;
  internal: boolean | null;
  attachable: boolean | null;
  ingress: boolean | null;
  ipam: {
    driver: string | null;
    configs: Array<{
      subnet: string | null;
      ipRange: string | null;
      gateway: string | null;
      auxiliaryAddresses: Record<string, string>;
    }>;
  };
  options: Record<string, string>;
  labels: Record<string, string>;
  containers: DockerNetworkContainerDetails[];
}

export interface DockerVolumeSummary {
  name: string;
  driver: string;
  scope: string;
  mountpoint: string;
}

export interface DockerVolumeDetails extends DockerVolumeSummary {
  createdAt: string | null;
  labels: Record<string, string>;
  options: Record<string, string>;
  status: Record<string, string>;
  sizeBytes: number | null;
  referenceCount: number | null;
}

export type DockerComposeAppRisk = "medium" | "high";

export type DockerHostAccessCapabilityId =
  | "host_os_identity"
  | "host_processes"
  | "host_sys"
  | "nas_capacity"
  | "account_map"
  | "docker_metadata"
  | "systemd_status";

export type DockerHostAccessRisk = "low" | "medium" | "high";
export type DockerHostAccessAvailabilityStatus = "available" | "degraded" | "unavailable";
export type DockerHostAccessReasonCode =
  | "host_access_daemon_unavailable"
  | "docker_proxy_unverified"
  | "systemd_proxy_unverified"
  | "not_linux"
  | "rootless_docker"
  | "user_namespace_enabled"
  | "no_ready_nas_root"
  | "nas_root_not_ready"
  | "resource_identity_changed"
  | "runtime_dependency_unavailable";

export type DockerHostAccessCoverageId =
  | "host_identity"
  | "host_time"
  | "host_processes"
  | "host_cpu"
  | "host_memory"
  | "physical_network"
  | "cgroup"
  | "nas_capacity"
  | "account_map"
  | "docker_containers"
  | "docker_networks"
  | "systemd_units"
  | "journald"
  | "smart_nvme"
  | "rootfs_capacity"
  | "low_level_kernel";

export interface DockerHostAccessAvailability {
  status: DockerHostAccessAvailabilityStatus;
  reasonCodes: DockerHostAccessReasonCode[];
}

export interface DockerHostAccessCapability {
  id: DockerHostAccessCapabilityId;
  risk: DockerHostAccessRisk;
  transport: "bind" | "docker_proxy" | "systemd_proxy";
  defaultTarget: string | null;
  provides: string[];
  requires: DockerHostAccessCapabilityId[];
  recommends: DockerHostAccessCapabilityId[];
  coverage: DockerHostAccessCoverageId[];
  availability: DockerHostAccessAvailability;
}

export type DockerHostAccessGrant =
  | {
      capability: "nas_capacity";
      rootId: string;
      target?: string;
    }
  | {
      capability: Exclude<DockerHostAccessCapabilityId, "nas_capacity">;
      target?: string;
    };

export interface DockerComposeServiceHostAccess {
  service: string;
  grants: DockerHostAccessGrant[];
}

export interface DockerHostAccessNasRoot {
  rootId: string;
  name: string;
  availability: DockerHostAccessAvailability;
}

export interface DockerHostAccessCatalog {
  policyVersion: string;
  capabilities: DockerHostAccessCapability[];
  nasRoots: DockerHostAccessNasRoot[];
}

export type DockerHostAccessCoverageState =
  | "requested"
  | "configured"
  | "runtime"
  | "degraded"
  | "unavailable"
  | "unsupported";

export interface DockerHostAccessCoverageItem {
  coverage: DockerHostAccessCoverageId;
  state: DockerHostAccessCoverageState;
  capabilities: DockerHostAccessCapabilityId[];
  reasonCodes: DockerHostAccessReasonCode[];
}

export interface DockerHostAccessCoverageReport {
  policyVersion: string;
  items: DockerHostAccessCoverageItem[];
}

export interface DockerHostAccessValidationIssue {
  code:
    | "invalid_target"
    | "duplicate_target"
    | "unknown_service"
    | "duplicate_capability"
    | "missing_root"
    | "root_unavailable"
    | "capability_unavailable"
    | "conflicting_compose_field"
    | "managed_mount_conflict"
    | "missing_dependency";
  severity: "error" | "warning";
  service?: string;
  capability?: DockerHostAccessCapabilityId;
  field?: string;
  reasonCodes?: DockerHostAccessReasonCode[];
}

export type DockerHostAccessRuntimeState = "pending_apply" | "active" | "needs_repair";

export interface DockerComposeEnvironmentSummary {
  key: string;
  valueConfigured: boolean;
}

export interface DockerComposeEnvironmentCreateInput {
  key: string;
  value: string;
}

export interface DockerComposeEnvironmentUpdateInput {
  key: string;
  value?: string;
}

export interface DockerComposeAppSummary {
  id: string;
  name: string;
  projectKey: string;
  managedPath: string;
  services: string[];
  warnings: string[];
  risk: DockerComposeAppRisk;
  revision: string;
  deployedRevision: string | null;
  needsDeploy: boolean;
  containerCount: number | null;
  runningCount: number | null;
  status: "configured" | "running" | "partial" | "stopped";
  hostAccessState?: DockerHostAccessRuntimeState;
  createdAt: string;
  updatedAt: string;
}

export type DockerComposeProjectSummary = DockerComposeAppSummary;

export interface DockerComposeAppDetail extends DockerComposeAppSummary {
  composeContent: string;
  environment: DockerComposeEnvironmentSummary[];
  hostAccess?: DockerComposeServiceHostAccess[];
  hostAccessCoverage?: DockerHostAccessCoverageReport;
}

export interface DockerComposeAppValidateInput {
  appId?: string;
  expectedRevision?: string;
  projectKey: string;
  composeContent: string;
  environment: DockerComposeEnvironmentUpdateInput[];
  hostAccess?: DockerComposeServiceHostAccess[];
}

export interface DockerComposeAppValidationResult {
  services: string[];
  warnings: string[];
  risk: DockerComposeAppRisk;
  hostAccess?: DockerComposeServiceHostAccess[];
  hostAccessCoverage?: DockerHostAccessCoverageReport;
  issues?: DockerHostAccessValidationIssue[];
}

export interface DockerComposeAppCreateInput {
  name: string;
  projectKey: string;
  composeContent: string;
  environment: DockerComposeEnvironmentCreateInput[];
  hostAccess?: DockerComposeServiceHostAccess[];
}

export interface DockerComposeAppUpdateInput {
  name: string;
  composeContent: string;
  environment: DockerComposeEnvironmentUpdateInput[];
  expectedRevision: string;
  hostAccess?: DockerComposeServiceHostAccess[];
}

export interface DockerComposeAppDeleteInput {
  expectedRevision: string;
  confirmed: boolean;
}

export interface DockerSummary {
  collectedAt: string;
  enabled: boolean;
  daemon: DockerDaemonStatus;
  engine: DockerEngineSummary;
  metrics: {
    containers: {
      total: number;
      running: number;
      paused: number;
      stopped: number;
    };
    images: number;
    networks: number;
    volumes: number;
    cpuPercent: number | null;
    memoryUsageBytes: number | null;
    memoryLimitBytes: number | null;
    memoryPercent: number | null;
  };
  images: DockerImageSummary[];
  networks: DockerNetworkSummary[];
  volumes: DockerVolumeSummary[];
  containers: DockerContainerSummary[];
  composeProjects: DockerComposeProjectSummary[];
}

export type DockerPullPolicy = "missing" | "always" | "never";
export type DockerPortProtocol = "tcp" | "udp" | "sctp";
export type DockerRestartPolicy = "no" | "always" | "unless-stopped" | "on-failure";

export type DockerContainerMount =
  | {
      type: "bind";
      rootId: string;
      sourcePath: string;
      target: string;
      readOnly?: boolean;
    }
  | {
      type: "volume";
      source: string;
      target: string;
      readOnly?: boolean;
      noCopy?: boolean;
    }
  | {
      type: "tmpfs";
      target: string;
      readOnly?: boolean;
      sizeBytes?: number;
      mode?: number;
    };

export interface DockerContainerNetwork {
  mode: "bridge" | "host" | "none" | "custom";
  networkName?: string;
  aliases?: string[];
  ipv4Address?: string;
  ipv6Address?: string;
  macAddress?: string;
}

export interface DockerPortBinding {
  containerPort: number;
  protocol?: DockerPortProtocol;
  hostIp?: string;
  hostPort?: number;
}

export interface DockerExtraHost {
  hostname: string;
  address: string;
}

export interface DockerContainerCreateInput {
  name: string;
  image: string;
  platform?: string;
  pullPolicy?: DockerPullPolicy;
  start?: boolean;
  hostname?: string;
  user?: string;
  workingDir?: string;
  entrypoint?: string[];
  command?: string[];
  environment?: Record<string, string>;
  labels?: Record<string, string>;
  tty?: boolean;
  openStdin?: boolean;
  init?: boolean;
  stopSignal?: string;
  stopTimeoutSeconds?: number;
  cpuLimit?: number;
  cpuShares?: number;
  cpusetCpus?: string;
  memoryLimitBytes?: number;
  memoryReservationBytes?: number;
  memorySwapBytes?: number;
  pidsLimit?: number;
  shmSizeBytes?: number;
  readonlyRootfs?: boolean;
  privileged?: boolean;
  privilegedAcknowledged?: boolean;
  mounts?: DockerContainerMount[];
  network?: DockerContainerNetwork;
  ports?: DockerPortBinding[];
  publishAllPorts?: boolean;
  dns?: string[];
  dnsSearch?: string[];
  extraHosts?: DockerExtraHost[];
  restartPolicy?: DockerRestartPolicy;
  restartMaxRetries?: number;
  autoRemove?: boolean;
  hostAccess?: DockerHostAccessGrant[];
}

export interface DockerVolumeCreateInput {
  name: string;
  labels?: Record<string, string>;
}

export interface DockerNetworkIpamConfig {
  subnet?: string;
  ipRange?: string;
  gateway?: string;
  auxAddresses?: Record<string, string>;
}

interface DockerNetworkCreateBase {
  name: string;
  internal?: boolean;
  enableIpv4?: boolean;
  enableIpv6?: boolean;
  ipam?: DockerNetworkIpamConfig[];
  labels?: Record<string, string>;
}

export type DockerNetworkCreateInput =
  | (DockerNetworkCreateBase & {
      driver: "bridge";
    })
  | (DockerNetworkCreateBase & {
      driver: "macvlan";
      parent?: string;
      mode?: "bridge" | "private" | "vepa" | "passthru";
    })
  | (DockerNetworkCreateBase & {
      driver: "ipvlan";
      parent?: string;
      mode?: "l2" | "l3" | "l3s";
    });

export type DockerCreateInput =
  | ({ targetType: "container" } & DockerContainerCreateInput)
  | ({ targetType: "volume" } & DockerVolumeCreateInput)
  | ({ targetType: "network" } & DockerNetworkCreateInput);

export interface DockerCreateResult {
  kind: "container" | "volume" | "network";
  id: string;
  name: string;
  created: boolean;
  pulled?: boolean;
  started?: boolean;
  warnings: string[];
  partialSuccess: boolean;
  phase?: "pull" | "create" | "start";
  error?: string;
}

export interface DockerOperationProposal {
  action: DockerOperationAction;
  targetType: DockerOperationTargetType;
  containerId?: string;
  containerName?: string;
  volumeName?: string;
  networkName?: string;
  composeProjectId?: string;
  composeProjectName?: string;
  composeRevision?: string;
  service?: string;
  shell?: string;
  risk: "low" | "medium" | "high";
  summary: string;
  hostAccess?: {
    policyVersion: string;
    added: Array<{
      service?: string;
      capability: DockerHostAccessCapabilityId;
      rootId?: string;
      risk: DockerHostAccessRisk;
    }>;
    removed: Array<{
      service?: string;
      capability: DockerHostAccessCapabilityId;
      rootId?: string;
      risk: DockerHostAccessRisk;
    }>;
    imageDigests: Array<{ service?: string; digest: string }>;
  };
}

export interface DockerOperationRecord {
  id: string;
  approvalId: string | null;
  action: DockerOperationAction;
  targetType: DockerOperationTargetType;
  targetId: string;
  status: DockerOperationStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type VmHostStatus = "disabled" | "ready" | "degraded" | "unavailable";
export type VmState = "running" | "paused" | "shutoff" | "crashed" | "unknown";
export type VmOperationAction =
  | "create"
  | "start"
  | "shutdown"
  | "stop"
  | "restart"
  | "pause"
  | "resume"
  | "reset"
  | "snapshot"
  | "delete"
  | "console";
export type VmOperationStatus = "proposed" | "approved" | "applied" | "failed";
export type VmFirmware = "bios" | "uefi";
export type VmCpuMode = "host-model" | "host-passthrough" | "custom";
export type VmMemoryBacking = "default" | "hugepages";
export type VmDiskBus = "virtio" | "scsi" | "sata" | "ide";
export type VmDiskCache = "none" | "writeback" | "writethrough" | "directsync" | "unsafe";
export type VmDiskDiscard = "ignore" | "unmap";
export type VmNetworkModel = "virtio" | "e1000" | "rtl8139";
export type VmGraphics = "none" | "spice" | "vnc";
export type VmVideoModel = "none" | "virtio" | "qxl" | "vga";

export interface VmHostSummary {
  status: VmHostStatus;
  libvirtUri: string;
  libvirtVersion: string | null;
  qemuVersion: string | null;
  architecture: string;
  kvmAvailable: boolean;
  cpuCount: number | null;
  memoryTotalBytes: number | null;
  memoryFreeBytes: number | null;
  storagePath: string;
  storageTotalBytes: number | null;
  storageFreeBytes: number | null;
  networkName: string;
  error: string | null;
  issues: string[];
}

export interface VmInstanceSummary {
  id: string;
  name: string;
  state: VmState;
  uuid: string | null;
  vcpu: number | null;
  memoryBytes: number | null;
  maxMemoryBytes: number | null;
  os: string | null;
  disks: Array<{ source: string; capacityBytes: number | null }>;
  networks: Array<{ name: string; mac: string | null; source: string | null }>;
}

export interface VmStoragePoolSummary {
  name: string;
  path: string;
  state: string;
  capacityBytes: number | null;
  allocationBytes: number | null;
  availableBytes: number | null;
}

export interface VmNetworkSummary {
  name: string;
  state: string;
  mode: "nat" | "bridge" | "isolated" | "unknown";
}

export interface VmSummary {
  collectedAt: string;
  enabled: boolean;
  host: VmHostSummary;
  metrics: { total: number; running: number; paused: number; vcpu: number; memoryBytes: number; diskBytes: number };
  instances: VmInstanceSummary[];
  storagePools: VmStoragePoolSummary[];
  networks: VmNetworkSummary[];
}

export interface VmOperationProposal {
  action: VmOperationAction;
  domainName?: string;
  domainUuid?: string;
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
  isoSourcePath?: string;
  diskPath?: string;
  networkName?: string;
  networkModel?: VmNetworkModel;
  macAddress?: string;
  graphics?: VmGraphics;
  videoModel?: VmVideoModel;
  bootMenu?: boolean;
  autostart?: boolean;
  risk: "medium" | "high";
  summary: string;
}

export interface VmOperationRecord {
  id: string;
  approvalId: string | null;
  action: VmOperationAction;
  targetId: string;
  status: VmOperationStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface VmConsoleAuthorizationRecord {
  id: string;
  operationId: string;
  approvalId: string | null;
  domainName: string;
  status: "active" | "used" | "expired" | "failed";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface ShareProtocolService {
  name: string;
  status: ShareProtocolServiceStatus;
  error: string | null;
}

export interface ShareProtocolSummary {
  protocol: ShareProtocol;
  enabledShares: number;
  services: ShareProtocolService[];
}

export interface ShareSummaryItem {
  id: string;
  name: string;
  rootId: string;
  path: string;
  enabledProtocols: ShareProtocol[];
}

export interface ShareSummary {
  collectedAt: string;
  enabled: boolean;
  settingsUpdatedAt: string;
  metrics: {
    shares: number;
    enabledProtocols: number;
    authenticatedProtocols: number;
  };
  protocols: Record<ShareProtocol, ShareProtocolSummary>;
  shares: ShareSummaryItem[];
  issues: SystemCollectionIssue[];
}

export interface ShareApplyRequest {
  settings: ShareSettingsRecord;
  roots: NasRootConfig[];
}

export interface ShareApplyResult {
  appliedAt: string;
  files: string[];
  services: string[];
}

export interface ShareOperationProposal {
  action: ShareOperationAction;
  risk: "high";
  summary: string;
  settings: PublicShareSettings;
}

export interface ShareOperationRecord {
  id: string;
  approvalId: string | null;
  action: ShareOperationAction;
  targetId: string;
  status: ShareOperationStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type StorageRaidLevel = "0" | "1" | "5" | "6" | "10";
export type StorageFilesystem = "ext4" | "btrfs";
export type StorageOperationStatus = "proposed" | "approved" | "applied" | "failed";
export type StorageOperationAction = "create_pool" | "delete_pool";

interface StorageOperationBase {
  name: string;
  mountpoint: string;
  risk: "high";
  summary: string;
}

export interface StoragePoolCreateProposal extends StorageOperationBase {
  action: "create_pool";
  raidLevel: StorageRaidLevel;
  devices: string[];
  filesystem: StorageFilesystem;
}

export interface StoragePoolDeleteProposal extends StorageOperationBase {
  action: "delete_pool";
  mdDevice: string;
  devices: string[];
}

export type StorageOperationProposal = StoragePoolCreateProposal | StoragePoolDeleteProposal;

export interface StorageOperationRecord {
  id: string;
  approvalId: string | null;
  action: StorageOperationAction;
  targetId: string;
  status: StorageOperationStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DockerConsoleAuthorizationRecord {
  id: string;
  operationId: string;
  approvalId: string;
  containerId: string;
  shell: string;
  status: "active" | "used" | "expired" | "failed";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export type PendingApprovalProposal =
  | FileOperationProposal
  | PiToolCallApproval
  | DockerOperationProposal
  | VmOperationProposal
  | ShareOperationProposal
  | StorageOperationProposal;

export interface PendingApprovalRecord {
  id: string;
  jobId: string;
  sessionId: string;
  kind: PendingApprovalKind;
  status: ApprovalStatus;
  proposal: PendingApprovalProposal[];
  createdAt: string;
  updatedAt: string;
}

export interface FileOperationRecord {
  id: string;
  approvalId: string | null;
  operation: FileMutationOperation;
  sourcePath: string | null;
  targetPath: string | null;
  status: FileOperationStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TrashEntryRecord {
  id: string;
  rootId: string;
  originalPath: string;
  trashPath: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  restoredAt: string | null;
}
