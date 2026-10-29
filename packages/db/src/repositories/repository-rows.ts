import type {
  AgentEventType,
  AgentMessageRecord,
  BackupRunKind,
  BackupRunStatus,
  BluetoothTransferControlRequest,
  BluetoothTransferDirection,
  BluetoothTransferStatus,
  DownloadTaskStatus,
  DownloadTaskPhase,
  DownloadMode,
  DownloadSourceKind,
  DownloadControlRequest,
  DownloadErrorCode,
  DockerConsoleAuthorizationRecord,
  DockerOperationAction,
  DockerOperationStatus,
  DockerOperationTargetType,
  FileMutationOperation,
  FileOperationStatus,
  HealthAlertSeverity,
  HealthAlertStatus,
  IndexRunStatus,
  JobStatus,
  JobKind,
  OperationNotificationKind,
  OperationNotificationStatus,
  OpsRunStatus,
  OpsTask,
  StoragePoolReadinessStatus,
  PhotosAssetStatus,
  PhotosErrorCode,
  PhotosJobKind,
  PhotosJobPhase,
  PhotosJobStatus,
  PhotosTakenAtSource,
  ShareOperationAction,
  ShareOperationStatus,
  StorageOperationStatus
  , VmOperationAction
  , VmOperationStatus
} from "@cyberos/shared";

export type DbSessionRow = {
  id: string;
  current_path: string;
  pi_resources_trusted?: 0 | 1;
  created_at: string;
  updated_at: string;
};

export type DbMessageRow = {
  id: string;
  session_id: string;
  role: AgentMessageRecord["role"];
  content: string;
  created_at: string;
};

export type DbJobRow = {
  id: string;
  session_id: string;
  message_id: string;
  kind: JobKind;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  error: string | null;
  error_code: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  working_path: string;
};

export type DbEventRow = {
  id: number;
  session_id: string;
  job_id: string | null;
  type: AgentEventType;
  payload_json: string;
  created_at: string;
  source: string;
  source_id: string | null;
  run_id: string;
  sequence: number;
  message_role?: AgentMessageRecord["role"] | null;
  transcript_sequence?: number | null;
  transcript_turn_sequence?: number | null;
};

export type DbOperationNotificationRow = {
  id: string;
  job_id: string | null;
  session_id: string | null;
  operation_id: string | null;
  kind: OperationNotificationKind;
  status: OperationNotificationStatus;
  summary: string;
  error: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbIndexedFileRow = {
  id: string;
  storage_pool_id: string;
  path: string;
  name: string;
  mime_type: string | null;
  size_bytes: number;
  mtime_ms: number;
  hash: string | null;
  indexed_at: string;
};

export type DbIndexRunRow = {
  id: string;
  storage_pool_id: string;
  status: Exclude<IndexRunStatus, "never_run">;
  started_at: string;
  finished_at: string | null;
  scanned: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  failed: number;
  error: string | null;
  duration_ms: number | null;
  bytes: number;
  file_count: number;
  text_file_count: number;
  phase: string | null;
  current_path: string | null;
  last_progress_at: string | null;
};

export type DbIndexHistoryRow = DbIndexRunRow & { failures_json: string };

export type DbIndexFailureRow = {
  path: string;
  reason: string;
};

export type DbBackupRunRow = {
  id: string;
  kind: BackupRunKind;
  status: Exclude<BackupRunStatus, "never_run">;
  started_at: string;
  finished_at: string | null;
  snapshot_ids_json: string;
  files: number;
  bytes: number;
  verified: 0 | 1;
  error: string | null;
};

export type DbBackupFailureRow = {
  storage_pool_id: string | null;
  path: string | null;
  code: string | null;
  reason: string;
};

export type DbStoragePoolReadinessRow = {
  storage_pool_id: string;
  status: StoragePoolReadinessStatus;
  checked_at: string;
  reason: string | null;
  source: string | null;
  uuid: string | null;
  fstype: string | null;
};

export type DbAlertRow = {
  id: string;
  code: string;
  scope: string;
  storage_pool_id: string | null;
  severity: HealthAlertSeverity;
  status: HealthAlertStatus;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  details: string | null;
};

export type DbOpsRunRow = {
  id: string;
  task: OpsTask;
  status: OpsRunStatus;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  summary_json: string | null;
  error: string | null;
};

export type DbProviderSessionRow = {
  session_id: string;
  provider_session_id: string;
  session_file: string | null;
  provider_name: string;
  model: string;
  settings_snapshot_json: string;
  runtime_generation: number;
  runtime_provider: string | null;
  runtime_model: string | null;
  projection_cursor: string | null;
  created_at: string;
  updated_at: string;
};

export type DbOperationRow = {
  id: string;
  operation: FileMutationOperation;
  source_path: string | null;
  target_path: string | null;
  status: FileOperationStatus;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type DbDownloadTaskRow = {
  id: string;
  url: string;
  storage_pool_id: string;
  target_directory: string;
  target_file_name: string;
  target_path: string;
  partial_path: string;
  status: DownloadTaskStatus;
  received_bytes: number;
  total_bytes: number | null;
  speed_bytes_per_second: number;
  etag: string | null;
  last_modified: string | null;
  error: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_progress_at: string | null;
  file_operation_id: string | null;
  phase: DownloadTaskPhase | null;
  download_mode: DownloadMode | null;
  expected_sha256: string | null;
  actual_sha256: string | null;
  error_code: DownloadErrorCode | null;
  error_retryable: 0 | 1;
  retry_count: number;
  next_retry_at: string | null;
  control_requested: DownloadControlRequest | null;
  segment_count: number;
  source_kind: DownloadSourceKind;
  torrent_info_hash: string | null;
  torrent_name: string | null;
  selected_file_count: number;
  uploaded_bytes: number;
  upload_speed_bytes_per_second: number;
  peer_count: number;
  seed_ratio_limit: number;
  seed_time_limit_seconds: number;
  content_completed_at: string | null;
  seed_started_at: string | null;
};

export type DbBluetoothTransferRow = {
  id: string;
  direction: BluetoothTransferDirection;
  adapter_id: string | null;
  device_address: string;
  storage_pool_id: string;
  relative_path: string;
  display_name: string;
  finalization_relative_path: string | null;
  status: BluetoothTransferStatus;
  transferred_bytes: number;
  total_bytes: number | null;
  error: string | null;
  obex_transfer_path: string | null;
  control_requested: BluetoothTransferControlRequest | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_progress_at: string | null;
};

export type DbPhotosAssetRow = {
  id: string;
  storage_pool_id: string;
  path: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  mtime_ms: number;
  content_hash: string | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  taken_at: string;
  taken_at_source: PhotosTakenAtSource;
  thumbnail_key: string | null;
  preview_key: string | null;
  status: PhotosAssetStatus;
  error: string | null;
  error_code: PhotosErrorCode | null;
  error_retryable: 0 | 1;
  derivative_schema_version: number;
  library_updated_at: string;
  indexed_at: string;
};

export type DbPhotosJobRow = {
  id: string;
  kind: PhotosJobKind;
  status: PhotosJobStatus;
  storage_pool_id: string;
  path: string;
  library_updated_at: string;
  scanned: number;
  processed: number;
  failed: number;
  current_path: string | null;
  phase: PhotosJobPhase | null;
  error: string | null;
  error_code: PhotosErrorCode | null;
  error_retryable: 0 | 1;
  retry_count: number;
  next_retry_at: string | null;
  scan_generation: string;
  worker_id: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type DbDockerOperationRow = {
  id: string;
  action: DockerOperationAction;
  target_type: DockerOperationTargetType;
  target_id: string;
  status: DockerOperationStatus;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type DbShareOperationRow = {
  id: string;
  action: ShareOperationAction;
  target_id: string;
  status: ShareOperationStatus;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type DbStorageOperationRow = {
  id: string;
  action: "create_pool" | "delete_pool";
  target_id: string;
  status: StorageOperationStatus;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type DbVmOperationRow = {
  id: string;
  action: VmOperationAction;
  target_id: string;
  status: VmOperationStatus;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type DbVmConsoleAuthorizationRow = {
  id: string;
  operation_id: string;
  domain_name: string;
  status: "active" | "used" | "expired" | "failed";
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

export type DbDockerConsoleAuthorizationRow = {
  id: string;
  operation_id: string;
  container_id: string;
  shell: string;
  status: DockerConsoleAuthorizationRecord["status"];
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

export type DbTrashEntryRow = {
  id: string;
  storage_pool_id: string;
  original_path: string;
  trash_path: string;
  metadata_json: string;
  created_at: string;
  restored_at: string | null;
};

export type DbSystemSettingRow = {
  key: string;
  value_json: string;
  updated_at: string;
};
