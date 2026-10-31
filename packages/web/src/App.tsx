import { getMusicPlayer } from "./lib/music-api.js";
import { MusicTakeoverDialog, MusicProvider } from "./components/music/MusicProvider.js";
import { PlaybackBar } from "./components/playback/PlaybackBar.js";
import { PlaybackRestoreButton } from "./components/playback/PlaybackRestoreButton.js";
import { PlaybackProvider, usePlayback } from "./components/playback/PlaybackProvider.js";
import { BrowserPlayer } from "./components/playback/BrowserPlayer.js";
import { FormEvent, KeyboardEvent, PointerEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CircleAlert, CircleCheck, MessageSquare, PanelRight, X } from "lucide-react";
import {
  applyFileMutation,
  cancelJob,
  decideCapabilityApproval,
  cancelFileBatch as cancelFileBatchRequest,
  createFileBatch,
  createSession,
  deleteSession,
  extractFile,
  getApprovals,
  getBuildInfo,
  getDockerOperations,
  getVmOperations,
  getDockerSettings,
  getVmSettings,
  getDownloadSettings,
  getIndexerOverview,
  getIndexerSettings,
  getFileBlobUrl,
  getFileVideoUrl,
  getVodPlayerStatus,
  getFileMeta,
  getFileBatches,
  getFiles,
  getOperations,
  getSessions,
  getSystemInfo,
  getSystemNetwork,
  getSystemBluetooth,
  getSystemStorage,
  getTextPreview,
  getTranscript,
  getModelProviderSettings,
  getMonitoringAlertIncidents,
  getNotifications,
  getNotificationsSummary,
  getAgentCapabilityPolicySettings,
  getPhotoLibrarySettings,
  getPhotoProcessingSettings,
  getPhotoStatus,
  requestSystemPower,
  markAllNotificationsRead,
  markAllBluetoothTransfersRead,
  markBluetoothTransferRead,
  markNotificationRead,
  acknowledgeMonitoringAlertIncident,
  readAllMonitoringAlertIncidents,
  readMonitoringAlertIncident,
  rollbackOperation,
  requestReindex,
  saveDockerSettings,
  saveVmSettings,
  savePhotoLibrarySettings,
  saveModelProviderSettings,
  saveAgentCapabilityPolicySettings,
  searchIndex,
  retryAgentJob,
  sendAgentSessionCommand,
  sendMessage,
  sendVodPlayerCommand,
  updateSessionPath,
  updateDownloadSettings,
  updateIndexerSettings,
  updatePhotoProcessingSettings,
  uploadFile,
  type AgentEvent,
  type AgentToolActivity,
  type BuildInfo,
  type FileEntry,
  type FileBatch,
  type FileMeta,
  type FileOperation,
  type DockerOperation,
  type VmOperation,
  type DockerSettings,
  type VmSettings,
  type DownloadSettings,
  type IndexerOverview,
  type IndexerSettings,
  type IndexSearchRequest,
  type IndexSearchResult,
  type SaveEditableTextResult,
  type FileListing,
  type ModelProviderSettings,
  type MonitoringAlertIncident,
  type StoragePool,
  type OperationNotification,
  type CapabilityApproval,
  type PhotoLibrarySettings,
  type PhotoLibraryStatus,
  type PhotoProcessingSettings,
  type Session,
  type SessionSummary,
  type SystemInfo,
  type NetworkSummary,
  type WifiStatus,
  type BluetoothStatus,
  type BluetoothTransfer,
  type SystemPowerAction,
  type StorageSummary,
  type TextPreview,
  type VodPlayerCommand,
  type VodPlayerStatus
} from "./api.js";
import {
  ChatPane,
  composeAgentMessage,
  hasActiveAgentTurn,
  type AgentDeliveryMode
} from "./components/chat/ChatPane.js";
import { NotificationCenter } from "./components/notifications/NotificationCenter.js";
import { FileEditorModal } from "./components/editor/FileEditorModal.js";
import { SettingsModal } from "./components/settings/SettingsModal.js";
import {
  WorkspacePane,
  defaultWorkspaceSearchOptions,
  hasWorkspaceSearchFilters,
  type WorkspaceSearchOptions
} from "./components/workspace/WorkspacePane.js";
import {
  defaultToolPolicyForm,
  dockerSettingsToForm,
  vmSettingsToForm,
  modelSettingsToForm,
  type DockerSettingsFormState,
  type VmSettingsFormState,
  type ModelProviderFormState,
  type SettingsSectionId,
  type ToolPolicyFormState
} from "./config/settings.js";
import type { AppStatus } from "./config/status.js";
import {
  readStoredLanguagePreference,
  resolveBrowserLocale,
  resolveSupportedLocale,
  writeStoredLanguagePreference,
  type LanguagePreference
} from "./i18n/locale.js";
import { eventToTranscriptMessage, getEventJobId } from "./lib/events.js";
import {
  EMPTY_ACTIVE_AGENT_JOB,
  markActiveAgentJobRunning,
  markActiveAgentJobWaitingApproval,
  settleActiveAgentJob,
  targetsActiveAgentJob,
  type ActiveAgentJobState
} from "./lib/agent-job-state.js";
import { initialTranscriptState, transcriptReducer } from "./lib/transcript.js";
import { workspaceAbsolutePath, workspaceParentPath } from "./lib/chat-paths.js";
import {
  codeFontFamilyValue,
  normalizeCodeFontSettings,
  readStoredCodeFontSettings,
  writeStoredCodeFontSettings,
  type CodeFontSettings
} from "./lib/editor-settings.js";
import { i18n } from "./i18n/index.js";
import { toErrorMessage } from "./lib/format.js";
import { MIN_CHAT_WIDTH, clampSplitWidth, readStoredSplitWidth, writeStoredSplitWidth } from "./lib/layout.js";
import {
  createUploadBatch,
  joinNasPath,
  pruneUploadBatchHistory,
  updateUploadBatch,
  updateUploadBatchItem,
  type UploadBatchState,
  type UploadSource
} from "./lib/uploads.js";
import {
  clampPreviewFileSizeLimitBytes,
  isPreviewOverFileSizeLimit,
  readStoredPreviewFileSizeLimitBytes,
  writeStoredPreviewFileSizeLimitBytes
} from "./lib/preview-settings.js";
import { loadFileListingForView } from "./lib/session.js";
import { readStoredStoragePoolId, writeStoredStoragePoolId } from "./lib/storage-pool-settings.js";
import { scheduleToastDismissal } from "./lib/toast.js";
import { createTrailingSingleFlight } from "./lib/trailing-single-flight.js";
import { acceptVodPlayerStatus } from "./lib/vod-player-status.js";

type MobileView = "chat" | "workspace";

const WORK_QUEUE_NOTIFICATION_DEBOUNCE_MS = 1_000;
const MAX_UPLOAD_BATCHES = 8;
const VOD_PLAYER_ERROR_CODES = new Set([
  "VOD_PLAYER_DISABLED",
  "VOD_PLAYER_UNAVAILABLE",
  "MPV_UNAVAILABLE",
  "DRM_UNAVAILABLE",
  "AUDIO_UNAVAILABLE",
  "PERMISSION_DENIED",
  "STORAGE_UNAVAILABLE",
  "SOURCE_CHANGED",
  "UNSUPPORTED_MEDIA",
  "PLAYBACK_FAILED",
  "COMMAND_TIMEOUT",
  "SESSION_CONFLICT",
  "INVALID_COMMAND",
  "INVALID_PATH",
  "PROTOCOL_ERROR",
  "INTERNAL"
]);

function vodPlayerErrorCode(error: unknown): NonNullable<VodPlayerStatus["errorCode"]> {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return typeof candidate === "string" && VOD_PLAYER_ERROR_CODES.has(candidate)
    ? candidate as NonNullable<VodPlayerStatus["errorCode"]>
    : "INTERNAL";
}

function upsertToolActivity(
  activities: AgentToolActivity[],
  next: AgentToolActivity
): AgentToolActivity[] {
  const existingIndex = activities.findIndex(
    (activity) => activity.id === next.id && activity.runId === next.runId
  );
  if (existingIndex === -1) return [...activities, next];
  return activities.map((activity, index) => index === existingIndex ? next : activity);
}

export function App() {
  return <PlaybackProvider><MusicProvider><AppContent /></MusicProvider></PlaybackProvider>;
}

function AppContent() {
  const playback = usePlayback();
  const [videoTakeover, setVideoTakeover] = useState<string | null>(null);
  const { t } = useTranslation();
  const [selectedStoragePoolId, setSelectedStoragePoolId] = useState("");
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null);
  const [storageSummaryLoading, setStorageSummaryLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [transcriptState, dispatchTranscript] = useReducer(transcriptReducer, initialTranscriptState);
  const transcript = transcriptState.messages;
  const [capabilityApprovals, setCapabilityApprovals] = useState<CapabilityApproval[]>([]);
  const [operations, setOperations] = useState<FileOperation[]>([]);
  const [fileBatches, setFileBatches] = useState<FileBatch[]>([]);
  const activeFileBatchIdsRef = useRef<Set<string>>(new Set());
  const [dockerOperations, setDockerOperations] = useState<DockerOperation[]>([]);
  const [vmOperations, setVmOperations] = useState<VmOperation[]>([]);
  const [operationsReady, setOperationsReady] = useState(false);
  const [uploadBatches, setUploadBatches] = useState<UploadBatchState[]>([]);
  const [currentPath, setCurrentPath] = useState(".");
  const [fileListingLoading, setFileListingLoading] = useState(false);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [gitStatus, setGitStatus] = useState<FileListing["git"]>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<FileMeta | null>(null);
  const [textPreview, setTextPreview] = useState<TextPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [vodPlayerStatus, setVodPlayerStatus] = useState<VodPlayerStatus | null>(null);
  const [vodPlayerBusy, setVodPlayerBusy] = useState(false);
  const [editorMeta, setEditorMeta] = useState<FileMeta | null>(null);
  const [message, setMessage] = useState("");
  const [composerPath, setComposerPath] = useState<string | null>(null);
  const [messageSubmitting, setMessageSubmitting] = useState(false);
  const [activeAgentJob, setActiveAgentJob] = useState<ActiveAgentJobState>(EMPTY_ACTIVE_AGENT_JOB);
  const activeAgentJobRef = useRef<ActiveAgentJobState>(EMPTY_ACTIVE_AGENT_JOB);
  const commitActiveAgentJob = useCallback((next: ActiveAgentJobState) => {
    activeAgentJobRef.current = next;
    setActiveAgentJob(next);
  }, []);
  const transitionActiveAgentJob = useCallback((transition: (current: ActiveAgentJobState) => ActiveAgentJobState) => {
    commitActiveAgentJob(transition(activeAgentJobRef.current));
  }, [commitActiveAgentJob]);
  const activeJobId = activeAgentJob.id;
  const activeJobStatus = activeAgentJob.status;
  const [retryJobId, setRetryJobId] = useState<string | null>(null);
  const [agentToolActivities, setAgentToolActivities] = useState<AgentToolActivity[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOptions, setSearchOptions] = useState<WorkspaceSearchOptions>(() => defaultWorkspaceSearchOptions());
  const [searchResults, setSearchResults] = useState<IndexSearchResult[] | null>(null);
  const [searchNextCursor, setSearchNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [warningNotice, setWarningNotice] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<OperationNotification[]>([]);
  const [bluetoothTransfers, setBluetoothTransfers] = useState<BluetoothTransfer[]>([]);
  const [alertIncidents, setAlertIncidents] = useState<MonitoringAlertIncident[]>([]);
  const [operationUnreadCount, setOperationUnreadCount] = useState(0);
  const [bluetoothUnreadCount, setBluetoothUnreadCount] = useState(0);
  const [alertUnreadCount, setAlertUnreadCount] = useState(0);
  const notificationUnreadCount = operationUnreadCount + bluetoothUnreadCount + alertUnreadCount;
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const closeNotificationCenter = useCallback(() => setNotificationCenterOpen(false), []);
  const [mobileView, setMobileView] = useState<MobileView>("chat");
  const [filesPanelActivationId, setFilesPanelActivationId] = useState(0);
  const [splitWidth, setSplitWidth] = useState(() => readStoredSplitWidth());
  const [resizing, setResizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId>("model-providers");
  const [modelSettings, setModelSettings] = useState<ModelProviderSettings | null>(null);
  const [dockerSettings, setDockerSettings] = useState<DockerSettings | null>(null);
  const [vmSettings, setVmSettings] = useState<VmSettings | null>(null);
  const [downloadSettings, setDownloadSettings] = useState<DownloadSettings | null>(null);
  const [indexerSettings, setIndexerSettings] = useState<IndexerSettings | null>(null);
  const [indexerStatus, setIndexerStatus] = useState<IndexerOverview | null>(null);
  const [photoSettings, setPhotoSettings] = useState<PhotoLibrarySettings | null>(null);
  const [photoStatus, setPhotoStatus] = useState<PhotoLibraryStatus | null>(null);
  const [photoProcessingSettings, setPhotoProcessingSettings] = useState<PhotoProcessingSettings | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [, setSystemInfoError] = useState<string | null>(null);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [buildInfoError, setBuildInfoError] = useState<string | null>(null);
  const [modelSettingsForm, setModelSettingsForm] = useState<ModelProviderFormState>(() =>
    modelSettingsToForm(null)
  );
  const [toolPolicyForm, setToolPolicyForm] = useState<ToolPolicyFormState>(() => defaultToolPolicyForm());
  const [dockerSettingsForm, setDockerSettingsForm] = useState<DockerSettingsFormState>(() =>
    dockerSettingsToForm(null)
  );
  const [vmSettingsForm, setVmSettingsForm] = useState<VmSettingsFormState>(() =>
    vmSettingsToForm(null)
  );
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNetwork, setSettingsNetwork] = useState<NetworkSummary | null>(null);
  const [settingsBluetooth, setSettingsBluetooth] = useState<BluetoothStatus | null>(null);
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(() => readStoredLanguagePreference());
  const [previewFileSizeLimitBytes, setPreviewFileSizeLimitBytes] = useState(() =>
    readStoredPreviewFileSizeLimitBytes()
  );
  const [codeFontSettings, setCodeFontSettings] = useState<CodeFontSettings>(() => readStoredCodeFontSettings());
  const seenEvents = useRef(new Set<number>());
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileListingRequestId = useRef(0);
  const sessionViewRequestId = useRef(0);
  const activeSessionIdRef = useRef(activeSessionId);
  const activeSearchQueryRef = useRef("");
  const currentPathRef = useRef(currentPath);
  const selectedStoragePoolIdRef = useRef(selectedStoragePoolId);
  const uploadBatchSequenceRef = useRef(0);
  const uploadAbortControllersRef = useRef(new Map<string, Set<AbortController>>());
  const cancelledUploadBatchesRef = useRef(new Set<string>());
  const preferredStoragePoolIdRef = useRef(readStoredStoragePoolId());
  const pendingDownloadedDirectoryRef = useRef<{
    storagePoolId: string;
    path: string;
  } | null>(null);

  useEffect(
    () => scheduleToastDismissal(error, (notice) => {
      setError((current) => current === notice ? null : current);
    }),
    [error]
  );

  useEffect(
    () => scheduleToastDismissal(successNotice, (notice) => {
      setSuccessNotice((current) => current === notice ? null : current);
    }),
    [successNotice]
  );

  useEffect(
    () => scheduleToastDismissal(warningNotice, (notice) => {
      setWarningNotice((current) => current === notice ? null : current);
    }),
    [warningNotice]
  );
  const notificationRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notificationFileListingRefreshRef = useRef(false);
  const workQueueRefreshRef = useRef<ReturnType<typeof createTrailingSingleFlight> | null>(null);

  const storagePoolOptions = useMemo(() => {
    return (storageSummary?.pools ?? [])
      .filter((pool) => pool.status !== "offline")
      .map((pool): StoragePool => ({
        id: pool.id,
        name: pool.id,
        mountpoint: pool.mountpoint,
        path: ".",
        filesystem: pool.filesystem,
        status: pool.status
      }));
  }, [storageSummary]);
  const selectedStoragePool = useMemo(
    () => storagePoolOptions.find((pool) => pool.id === selectedStoragePoolId),
    [selectedStoragePoolId, storagePoolOptions]
  );
  const activeSessionSummary = sessions.find((item) => item.id === activeSessionId);
  const visibleUploadBatches = useMemo(
    () => uploadBatches.filter((batch) => batch.storagePoolId === selectedStoragePoolId),
    [selectedStoragePoolId, uploadBatches]
  );
  const blobUrl = selectedStoragePoolId && selectedFilePath
    ? getFileBlobUrl(selectedStoragePoolId, selectedFilePath)
    : "";
  const videoUrl = selectedStoragePoolId && selectedFilePath
    ? getFileVideoUrl(selectedStoragePoolId, selectedFilePath)
    : "";
  const resolvedLocale = resolveSupportedLocale(i18n.resolvedLanguage ?? i18n.language);
  const breadcrumbs = useMemo(() => (currentPath === "." ? [] : currentPath.split("/").filter(Boolean)), [currentPath]);
  const appStyle = useMemo(
    () =>
      ({
        "--chat-pane-width": `${splitWidth}px`,
        "--code-font-family": codeFontFamilyValue(codeFontSettings.familyId),
        "--code-font-size": `${codeFontSettings.fontSizePx}px`
      }) as CSSProperties,
    [codeFontSettings.familyId, codeFontSettings.fontSizePx, splitWidth]
  );

  useEffect(() => {
    let active = true;
    getSystemStorage().then((storage) => {
      if (!active) {
        return;
      }
      setStorageSummary(storage);
      setStorageSummaryLoading(false);
    }).catch((nextError: unknown) => {
      if (!active) return;
      setError(toErrorMessage(nextError));
      setStatus("offline");
      setStorageSummaryLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void refreshNotifications();
    const timer = window.setInterval(() => void refreshNotifications(), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    getModelProviderSettings()
      .then((settings) => {
        if (!active) {
          return;
        }
        setModelSettings(settings);
        setModelSettingsForm(modelSettingsToForm(settings));
      })
      .catch(() => {
        // Opening settings retries the request and exposes any error details.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const sessionRequestId = beginSessionViewRequest();
    let transcriptSessionId: string | null = null;
    dispatchTranscript({ type: "prepare" });
    async function loadRootWorkspace() {
      setStatus("loading");
      setError(null);
      const nextSessions = await getSessions();
      let nextSession: Session | SessionSummary | null = nextSessions[0] ?? null;
      let nextSessionList = nextSessions;

      if (!nextSession) {
        nextSession = await createSession(".");
        nextSessionList = await getSessions();
      }

      if (!active || !isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }

      transcriptSessionId = nextSession.id;
      seenEvents.current.clear();
      setSessions(nextSessionList);
      activeSessionIdRef.current = nextSession.id;
      setSession(nextSession);
      setActiveSessionId(nextSession.id);
      setComposerPath(null);
      dispatchTranscript({ type: "begin", sessionId: nextSession.id });
      const nextTranscript = await getTranscript(nextSession.id);

      if (!active || !isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }

      dispatchTranscript({ type: "snapshot", sessionId: nextSession.id, messages: nextTranscript });
      restoreSessionJob(nextSession);
      void refreshWorkQueues();
    }

    loadRootWorkspace().catch((nextError: unknown) => {
      if (!active || !isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }
      dispatchTranscript({ type: "failed", sessionId: transcriptSessionId });
      setError(toErrorMessage(nextError));
      setStatus("error");
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (storageSummaryLoading || selectedStoragePoolId || storagePoolOptions.length === 0) {
      return;
    }

    const preferredPool = storagePoolOptions.find((pool) => pool.id === preferredStoragePoolIdRef.current);
    selectStoragePool(preferredPool?.id ?? storagePoolOptions[0]!.id);
  }, [selectedStoragePoolId, storagePoolOptions, storageSummaryLoading]);

  useEffect(() => {
    if (!selectedStoragePoolId || selectedStoragePool) {
      return;
    }

    beginFileListingRequest();
    setSelectedStoragePoolId("");
    setCurrentPath(".");
    setEntries([]);
    setGitStatus(null);
    setSelectedFilePath(null);
    setPreviewMeta(null);
    setTextPreview(null);
    setPreviewError(null);
    setEditorMeta(null);
    setWarningNotice(t("workspace.storagePoolUnavailable"));
  }, [selectedStoragePool, selectedStoragePoolId, t]);

  useEffect(() => {
    if (!selectedStoragePool) {
      return;
    }

    let active = true;
    const pool = selectedStoragePool;
    const fileRequestId = beginFileListingRequest(true);
    setStatus("loading");
    setError(null);
    setSearchQuery("");
    activeSearchQueryRef.current = "";
    setSearchResults(null);
    setSearchNextCursor(null);
    setSelectedFilePath(null);
    setPreviewMeta(null);
    setTextPreview(null);
    setPreviewError(null);
    setEditorMeta(null);

    getFiles(pool.id, pool.path)
      .then((listing) => {
        if (!active || !isCurrentFileListingRequest(fileRequestId)) {
          return;
        }
        setCurrentPath(pool.path);
        commitFileListing(fileRequestId, listing);
        setStatus("ready");
      })
      .catch((nextError: unknown) => {
        if (!active || !isCurrentFileListingRequest(fileRequestId)) {
          return;
        }
        finishFileListingRequest(fileRequestId);
        setError(toErrorMessage(nextError));
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [selectedStoragePool]);

  useEffect(() => {
    if (!session) {
      return;
    }

    setAgentToolActivities([]);
    setRetryJobId(null);

    const source = new EventSource(`/api/sessions/${session.id}/events`);
    let connectionRevision = 0;
    let eventRevision = 0;
    let reconnectPending = false;
    let statusBeforeReconnect: AppStatus | null = null;
    let disposed = false;
    const handleEvent = (raw: MessageEvent<string>) => {
      const parsed = JSON.parse(raw.data) as AgentEvent;
      const eventRunId = parsed.runId;
      if (seenEvents.current.has(parsed.id)) {
        return;
      }
      seenEvents.current.add(parsed.id);
      eventRevision += 1;

      if (parsed.audience === "notification") {
        const fileBatchId = typeof parsed.payload.fileBatchId === "string" ? parsed.payload.fileBatchId : null;
        if (
          fileBatchId
          && (parsed.type === "job.completed" || parsed.type === "job.failed" || parsed.type === "job.cancelled")
          && parsed.payload.storagePoolId === selectedStoragePoolIdRef.current
        ) {
          notificationFileListingRefreshRef.current = true;
        }
        if (notificationRefreshTimerRef.current) clearTimeout(notificationRefreshTimerRef.current);
        notificationRefreshTimerRef.current = setTimeout(() => {
          notificationRefreshTimerRef.current = null;
          const refreshFileListing = notificationFileListingRefreshRef.current;
          notificationFileListingRefreshRef.current = false;
          void Promise.all([
            refreshWorkQueues(),
            ...(refreshFileListing ? [refreshCurrentFileListing()] : [])
          ]);
        }, WORK_QUEUE_NOTIFICATION_DEBOUNCE_MS);
        return;
      }

      const transcriptMessage = eventToTranscriptMessage(parsed);
      if (transcriptMessage) {
        dispatchTranscript({
          type: "event",
          sessionId: session.id,
          message: transcriptMessage,
          runId: eventRunId
        });
      } else if (
        parsed.type === "message_start"
        || parsed.type === "message_update"
        || parsed.type === "message_end"
      ) {
        dispatchTranscript({ type: "stream", sessionId: session.id, event: parsed });
      }

      if (parsed.type === "tool_execution_start" || parsed.type === "tool_execution_update") {
        const toolId = typeof parsed.payload.id === "string" ? parsed.payload.id : null;
        const toolName = typeof parsed.payload.name === "string" ? parsed.payload.name : null;
        if (toolId && toolName) {
          setAgentToolActivities((current) => upsertToolActivity(current, {
            id: toolId,
            runId: eventRunId,
            name: toolName,
            status: "running"
          }));
        }
      }
      if (parsed.type === "tool_execution_end") {
        const toolId = typeof parsed.payload.id === "string" ? parsed.payload.id : null;
        const toolName = typeof parsed.payload.name === "string" ? parsed.payload.name : null;
        if (toolId && toolName) {
          setAgentToolActivities((current) => upsertToolActivity(current, {
            id: toolId,
            runId: eventRunId,
            name: toolName,
            status: parsed.payload.isError === true ? "failed" : "completed"
          }));
        }
      }

      const eventJobId = getEventJobId(parsed);
      if (parsed.type === "job.running") {
        setStatus("agent-running");
        transitionActiveAgentJob((current) => markActiveAgentJobRunning(current, eventJobId));
        setRetryJobId(null);
      }
      const targetsCurrentJob = targetsActiveAgentJob(activeAgentJobRef.current, eventJobId);
      if (parsed.type === "job.completed" && targetsCurrentJob) {
        setStatus("ready");
        transitionActiveAgentJob((current) => settleActiveAgentJob(current, eventJobId));
        void refreshWorkQueues();
        void reloadSessions();
        setAgentToolActivities([]);
      }
      if (parsed.type === "job.failed" && targetsCurrentJob) {
        setStatus("error");
        transitionActiveAgentJob((current) => settleActiveAgentJob(current, eventJobId));
        setAgentToolActivities([]);
        if (eventJobId && parsed.payload.retryable === true) setRetryJobId(eventJobId);
      }
      if (parsed.type === "job.cancelled" && targetsCurrentJob) {
        setStatus("cancelled");
        transitionActiveAgentJob((current) => settleActiveAgentJob(current, eventJobId));
        setAgentToolActivities([]);
      }
      if (parsed.type === "approval.pending" || parsed.type === "approval.updated") {
        if (parsed.type === "approval.pending" && targetsCurrentJob) {
          transitionActiveAgentJob((current) => markActiveAgentJobWaitingApproval(current, eventJobId));
        }
        if (targetsCurrentJob) {
          setStatus("ready");
        }
        void Promise.all([refreshWorkQueues(), reloadSessions()]);
      }
    };

    const eventTypes = [
      "agent.started",
      "agent.message",
      "agent.completed",
      "agent.failed",
      "tool_call.started",
      "tool_call.completed",
      "tool_call.failed",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "turn_start",
      "turn_end",
      "agent_end",
      "compaction_start",
      "compaction_end",
      "model_change",
      "thinking_level_change",
      "resource_error",
      "command.queued",
      "command.running",
      "command.completed",
      "command.failed",
      "approval.pending",
      "approval.updated",
      "job.running",
      "job.completed",
      "job.failed",
      "job.cancelled"
    ];
    for (const eventType of eventTypes) {
      source.addEventListener(eventType, handleEvent);
    }
    source.onopen = () => {
      if (!reconnectPending) return;
      reconnectPending = false;
      setStatus((current) => current === "reconnecting"
        ? statusBeforeReconnect ?? "ready"
        : current);
      statusBeforeReconnect = null;
      const expectedConnectionRevision = connectionRevision;
      const expectedEventRevision = eventRevision;
      const expectedSessionId = session.id;
      void getSessions().then((nextSessions) => {
        if (
          disposed
          || connectionRevision !== expectedConnectionRevision
          || eventRevision !== expectedEventRevision
          || activeSessionIdRef.current !== expectedSessionId
        ) {
          return;
        }
        setSessions(nextSessions);
        const hydratedSession = nextSessions.find((item) => item.id === expectedSessionId);
        if (hydratedSession) {
          setSession(hydratedSession);
          restoreSessionJob(hydratedSession);
        } else {
          setStatus("ready");
        }
      }).catch((nextError: unknown) => {
        if (
          disposed
          || connectionRevision !== expectedConnectionRevision
          || activeSessionIdRef.current !== expectedSessionId
        ) {
          return;
        }
        setError(toErrorMessage(nextError));
        setStatus("error");
      });
    };
    source.onerror = () => {
      reconnectPending = true;
      connectionRevision += 1;
      setStatus((current) => {
        if (current !== "reconnecting") statusBeforeReconnect = current;
        return "reconnecting";
      });
    };

    return () => {
      disposed = true;
      source.close();
      if (notificationRefreshTimerRef.current) {
        clearTimeout(notificationRefreshTimerRef.current);
        notificationRefreshTimerRef.current = null;
      }
      notificationFileListingRefreshRef.current = false;
    };
  }, [session]);

  useEffect(() => {
    void refreshWorkQueues();
  }, [selectedStoragePoolId, session?.id]);

  useEffect(() => {
    if (!fileBatches.some((batch) => batch.status === "queued" || batch.status === "running")) {
      return;
    }
    const timer = window.setTimeout(() => void refreshFileBatches(), 1_000);
    return () => window.clearTimeout(timer);
  }, [fileBatches]);

  useEffect(() => {
    const previousActiveIds = activeFileBatchIdsRef.current;
    const currentActiveIds = new Set(
      fileBatches
        .filter((batch) => batch.status === "queued" || batch.status === "running")
        .map((batch) => batch.id)
    );
    const reachedTerminalState = fileBatches.some(
      (batch) => previousActiveIds.has(batch.id) && !currentActiveIds.has(batch.id)
    );
    activeFileBatchIdsRef.current = currentActiveIds;
    if (reachedTerminalState) {
      void Promise.all([refreshCurrentFileListing(), refreshNotifications()]);
    }
  }, [fileBatches]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [capabilityApprovals.length, transcript.length]);

  useEffect(() => {
    if (!selectedStoragePoolId || !selectedFilePath) {
      setPreviewMeta(null);
      setTextPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    let active = true;
    const storagePoolId = selectedStoragePoolId;
    const filePath = selectedFilePath;
    async function loadPreview() {
      setPreviewLoading(true);
      setPreviewError(null);
      setTextPreview(null);
      const meta = await getFileMeta(storagePoolId, filePath);
      const withinPreviewLimit = !isPreviewOverFileSizeLimit(meta, previewFileSizeLimitBytes);
      const nextTextPreview =
        meta.previewKind === "text" && withinPreviewLimit
          ? await getTextPreview(storagePoolId, filePath)
          : null;
      if (!active) {
        return;
      }
      setPreviewMeta(meta);
      setTextPreview(nextTextPreview);
      setPreviewLoading(false);
    }

    loadPreview().catch((nextError: unknown) => {
      if (!active) {
        return;
      }
      setPreviewError(toErrorMessage(nextError));
      setPreviewLoading(false);
    });

    return () => {
      active = false;
    };
  }, [previewFileSizeLimitBytes, selectedStoragePoolId, selectedFilePath]);

  useEffect(() => {
    const vodPlayerAreaVisible = Boolean(
      selectedFilePath &&
        (typeof window === "undefined" || window.innerWidth > 860 || mobileView === "workspace")
    );
    if (!vodPlayerAreaVisible) {
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const nextStatus = await getVodPlayerStatus();
        if (!active) return;
        setVodPlayerStatus((current) => acceptVodPlayerStatus(current, nextStatus));
        const activeVodPlayback = nextStatus.state === "starting" || nextStatus.state === "playing" || nextStatus.state === "paused" || nextStatus.state === "recovering";
        timer = setTimeout(poll, activeVodPlayback ? 1000 : 5000);
      } catch {
        if (active) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [mobileView, selectedFilePath]);

  useEffect(() => {
    if (!resizing) {
      return;
    }

    function handlePointerMove(event: globalThis.PointerEvent) {
      setSplitWidth(clampSplitWidth(event.clientX));
    }

    function handlePointerUp() {
      setResizing(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [resizing]);

  useEffect(() => {
    writeStoredSplitWidth(splitWidth);
  }, [splitWidth]);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    selectedStoragePoolIdRef.current = selectedStoragePoolId;
  }, [selectedStoragePoolId]);

  useEffect(() => {
    const pending = pendingDownloadedDirectoryRef.current;
    if (!pending || pending.storagePoolId !== selectedStoragePoolId) {
      return;
    }
    pendingDownloadedDirectoryRef.current = null;
    void openDirectory(pending.path);
  }, [selectedStoragePoolId]);

  useEffect(() => {
    return () => {
      uploadAbortControllersRef.current.forEach((controllers) => {
        controllers.forEach((controller) => controller.abort());
      });
      uploadAbortControllersRef.current.clear();
      cancelledUploadBatchesRef.current.clear();
    };
  }, []);

  async function reloadSessions(): Promise<boolean> {
    const nextSessions = await getSessions();
    setSessions(nextSessions);
    return true;
  }

  async function refreshStorageSummary() {
    try {
      setStorageSummary(await getSystemStorage());
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function refreshNotifications(showError = false) {
    try {
      const [result, incidents, summary] = await Promise.all([
        getNotifications(),
        getMonitoringAlertIncidents(undefined, true),
        getNotificationsSummary()
      ]);
      setNotifications(result.notifications);
      setBluetoothTransfers(result.bluetoothTransfers);
      setAlertIncidents(incidents);
      setOperationUnreadCount(summary.operations);
      setBluetoothUnreadCount(summary.bluetoothTransfers);
      setAlertUnreadCount(summary.alerts);
    } catch (nextError) {
      if (showError) setError(toErrorMessage(nextError));
    } finally {
      setNotificationsLoading(false);
    }
  }

  async function readNotification(id: string) {
    try {
      const result = await markNotificationRead(id);
      setNotifications((current) => current.map((item) => item.id === id ? result.notification : item));
      setOperationUnreadCount(result.unreadCount);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function readAlertIncident(id: string) {
    try {
      const incident = await readMonitoringAlertIncident(id);
      setAlertIncidents((current) => current.map((item) => item.id === id ? incident : item));
      const summary = await getNotificationsSummary();
      setOperationUnreadCount(summary.operations);
      setBluetoothUnreadCount(summary.bluetoothTransfers);
      setAlertUnreadCount(summary.alerts);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function acknowledgeAlertIncident(id: string) {
    try {
      const incident = await acknowledgeMonitoringAlertIncident(id);
      setAlertIncidents((current) => current.map((item) => item.id === id ? incident : item));
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function readAllAlertIncidents() {
    try {
      await readAllMonitoringAlertIncidents();
      await refreshNotifications(true);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      void refreshNotifications();
    }
  }

  async function readAllNotifications() {
    try {
      await markAllNotificationsRead();
      await refreshNotifications(true);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function readBluetoothTransfer(id: string) {
    try {
      const result = await markBluetoothTransferRead(id);
      setBluetoothTransfers((current) => current.map((item) => item.id === id ? result.transfer : item));
      setBluetoothUnreadCount(result.unreadCount);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function readAllBluetoothTransfers() {
    try {
      await markAllBluetoothTransfersRead();
      await refreshNotifications(true);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  function openNotificationCenter() {
    setNotificationCenterOpen(true);
    void refreshNotifications(true);
  }

  async function openSettings(section: SettingsSectionId = "overview") {
    setSettingsOpen(true);
    setActiveSettingsSection(section);
    setSettingsLoading(true);
    setError(null);
    setSystemInfoError(null);
    setBuildInfoError(null);
    try {
      const [
        settingsResult,
        toolPolicyResult,
        dockerSettingsResult,
        vmSettingsResult,
        downloadSettingsResult,
        indexerSettingsResult,
        indexerStatusResult,
        photoSettingsResult,
        photoProcessingSettingsResult,
        photoStatusResult,
        systemInfoResult,
        buildInfoResult,
        networkResult,
        bluetoothResult
      ] = await Promise.allSettled([
        getModelProviderSettings(),
        getAgentCapabilityPolicySettings(),
        getDockerSettings(),
        getVmSettings(),
        getDownloadSettings(),
        getIndexerSettings(),
        getIndexerOverview(),
        getPhotoLibrarySettings(),
        getPhotoProcessingSettings(),
        getPhotoStatus(),
        getSystemInfo(),
        getBuildInfo(),
        getSystemNetwork(),
        getSystemBluetooth()
      ]);

      const errors: string[] = [];
      if (settingsResult.status === "fulfilled") {
        setModelSettings(settingsResult.value);
        setModelSettingsForm(modelSettingsToForm(settingsResult.value));
      } else {
        errors.push(toErrorMessage(settingsResult.reason));
      }

      if (toolPolicyResult.status === "fulfilled") {
        setToolPolicyForm(toolPolicyResult.value);
      } else {
        errors.push(toErrorMessage(toolPolicyResult.reason));
      }

      if (dockerSettingsResult.status === "fulfilled") {
        setDockerSettings(dockerSettingsResult.value);
        setDockerSettingsForm(dockerSettingsToForm(dockerSettingsResult.value));
      } else {
        errors.push(toErrorMessage(dockerSettingsResult.reason));
      }

      if (vmSettingsResult.status === "fulfilled") {
        setVmSettings(vmSettingsResult.value);
        setVmSettingsForm(vmSettingsToForm(vmSettingsResult.value));
      } else {
        errors.push(toErrorMessage(vmSettingsResult.reason));
      }

      if (downloadSettingsResult.status === "fulfilled") {
        setDownloadSettings(downloadSettingsResult.value);
      } else {
        setDownloadSettings(null);
        errors.push(toErrorMessage(downloadSettingsResult.reason));
      }

      if (indexerSettingsResult.status === "fulfilled") {
        setIndexerSettings(indexerSettingsResult.value);
      } else {
        setIndexerSettings(null);
        errors.push(toErrorMessage(indexerSettingsResult.reason));
      }

      if (indexerStatusResult.status === "fulfilled") {
        setIndexerStatus(indexerStatusResult.value);
      } else {
        setIndexerStatus(null);
        errors.push(toErrorMessage(indexerStatusResult.reason));
      }

      if (photoSettingsResult.status === "fulfilled") {
        setPhotoSettings(photoSettingsResult.value);
      } else {
        setPhotoSettings(null);
        errors.push(toErrorMessage(photoSettingsResult.reason));
      }

      if (photoProcessingSettingsResult.status === "fulfilled") {
        setPhotoProcessingSettings(photoProcessingSettingsResult.value);
      } else {
        setPhotoProcessingSettings(null);
        errors.push(toErrorMessage(photoProcessingSettingsResult.reason));
      }

      if (photoStatusResult.status === "fulfilled") {
        setPhotoStatus(photoStatusResult.value.status);
      } else {
        setPhotoStatus(null);
        errors.push(toErrorMessage(photoStatusResult.reason));
      }

      if (systemInfoResult.status === "fulfilled") {
        setSystemInfo(systemInfoResult.value);
        const volumeErrors = systemInfoResult.value.storage.volumes
          .filter((volume) => volume.status === "error" && volume.error)
          .map((volume) => `${volume.label}: ${volume.error}`);
        errors.push(...volumeErrors);
      } else {
        setSystemInfo(null);
        const message = toErrorMessage(systemInfoResult.reason);
        setSystemInfoError(message);
        errors.push(message);
      }

      if (buildInfoResult.status === "fulfilled") {
        setBuildInfo(buildInfoResult.value);
      } else {
        setBuildInfo(null);
        setBuildInfoError(toErrorMessage(buildInfoResult.reason));
      }

      if (networkResult.status === "fulfilled") {
        setSettingsNetwork(networkResult.value);
      } else {
        setSettingsNetwork(null);
        errors.push(toErrorMessage(networkResult.reason));
      }

      if (bluetoothResult.status === "fulfilled") {
        setSettingsBluetooth(bluetoothResult.value);
      } else {
        setSettingsBluetooth(null);
        errors.push(toErrorMessage(bluetoothResult.reason));
      }

      if (errors.length > 0) {
        setError(errors.join("\n"));
      }
    } finally {
      setSettingsLoading(false);
    }
  }

  async function handleSystemPower(action: SystemPowerAction): Promise<boolean> {
    setError(null);
    setSuccessNotice(null);
    try {
      await requestSystemPower(action);
      setSuccessNotice(t(`power.accepted.${action}`));
      return true;
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      return false;
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSettingsSaving(true);
    setError(null);
    try {
      const [settings, toolPolicy, nextDockerSettings, nextVmSettings] = await Promise.all([
        saveModelProviderSettings({
          providerName: modelSettingsForm.providerName,
          baseUrl: modelSettingsForm.baseUrl || null,
          model: modelSettingsForm.model,
          ...(modelSettingsForm.apiKey ? { apiKey: modelSettingsForm.apiKey } : {}),
          clearApiKey: modelSettingsForm.clearApiKey
        }),
        saveAgentCapabilityPolicySettings({ policies: toolPolicyForm.policies }),
        saveDockerSettings({
          enabled: dockerSettingsForm.enabled
        }),
        saveVmSettings({ enabled: vmSettingsForm.enabled })
      ]);
      setModelSettings(settings);
      setDockerSettings(nextDockerSettings);
      setVmSettings(nextVmSettings);
      setModelSettingsForm(modelSettingsToForm(settings));
      setToolPolicyForm(toolPolicy);
      setDockerSettingsForm(dockerSettingsToForm(nextDockerSettings));
      setVmSettingsForm(vmSettingsToForm(nextVmSettings));
      try {
        const refreshedSystemInfo = await getSystemInfo();
        setSystemInfo(refreshedSystemInfo);
        setSystemInfoError(null);
      } catch (refreshError) {
        const message = toErrorMessage(refreshError);
        setSystemInfoError(message);
        setError(message);
      }
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function changeDownloadSettings(patch: Partial<Omit<DownloadSettings, "updatedAt">>) {
    setError(null);
    try {
      setDownloadSettings(await updateDownloadSettings(patch));
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  const handleSettingsWifiStatus = useCallback((wifi: WifiStatus) => {
    setSettingsNetwork((current) => current ? {
      ...current,
      capabilities: {
        ...current.capabilities,
        backend: wifi.backend === "NetworkManager" || current.ethernet.backend === "NetworkManager" ? "NetworkManager" : wifi.backend,
        hostdReady: wifi.hostdReady || current.ethernet.hostdReady,
        canApplyConfiguration: (wifi.backend === "NetworkManager" && wifi.hostdReady) || (current.ethernet.backend === "NetworkManager" && current.ethernet.hostdReady),
        canManageWifi: wifi.backend === "NetworkManager" && wifi.hostdReady && wifi.devices.length > 0,
        canManageHotspot: wifi.backend === "NetworkManager" && wifi.hostdReady && wifi.devices.some((device) => device.capabilities.accessPoint)
      },
      wifi: { ...wifi, profiles: current.wifi.profiles }
    } : current);
  }, []);

  async function refreshSettingsNetwork() {
    setSettingsNetwork(await getSystemNetwork());
  }

  async function changeIndexerSettings(patch: Partial<Omit<IndexerSettings, "updatedAt">>) {
    setError(null);
    try {
      setIndexerSettings(await updateIndexerSettings(patch));
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function reindexRoot(storagePoolId: string) {
    setError(null);
    try {
      await requestReindex({ storagePoolId, path: ".", recursive: true });
      setIndexerStatus(await getIndexerOverview());
      setSuccessNotice(String(t("settings.indexer.reindexQueued")));
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function changePhotoProcessingSettings(
    patch: Partial<Omit<PhotoProcessingSettings, "updatedAt">>
  ) {
    setError(null);
    try {
      setPhotoProcessingSettings(await updatePhotoProcessingSettings(patch));
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function changePhotoLibrarySettings(input: {
    storagePoolId: string;
    path: string;
  }): Promise<PhotoLibrarySettings> {
    setError(null);
    try {
      const result = await savePhotoLibrarySettings(input);
      setPhotoSettings(result.settings);
      void getPhotoStatus()
        .then((snapshot) => setPhotoStatus(snapshot.status))
        .catch((nextError: unknown) => setError(toErrorMessage(nextError)));
      void refreshWorkQueues();
      return result.settings;
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function selectSession(nextSession: SessionSummary) {
    if (nextSession.id === activeSessionId) {
      return;
    }

    const sessionRequestId = beginSessionViewRequest();
    try {
      setStatus("loading");
      setError(null);
      seenEvents.current.clear();
      activeSessionIdRef.current = nextSession.id;
      setCapabilityApprovals([]);
      commitActiveAgentJob(EMPTY_ACTIVE_AGENT_JOB);
      setSession(nextSession);
      setActiveSessionId(nextSession.id);
      setComposerPath(null);
      dispatchTranscript({ type: "begin", sessionId: nextSession.id });
      const nextTranscript = await getTranscript(nextSession.id);
      if (!isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }
      dispatchTranscript({ type: "snapshot", sessionId: nextSession.id, messages: nextTranscript });
      restoreSessionJob(nextSession);
    } catch (nextError) {
      if (!isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }
      dispatchTranscript({ type: "failed", sessionId: nextSession.id });
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }

  async function createAgent() {
    const sessionRequestId = beginSessionViewRequest();
    setStatus("creating-agent");
    setError(null);
    dispatchTranscript({ type: "prepare" });
    let nextSession: Session | null = null;
    try {
      nextSession = await createSession(sessionWorkspacePath(selectedStoragePoolId, currentPath));
      const createdSessionId = nextSession.id;
      seenEvents.current.clear();
      activeSessionIdRef.current = nextSession.id;
      setCapabilityApprovals([]);
      commitActiveAgentJob(EMPTY_ACTIVE_AGENT_JOB);
      setSession(nextSession);
      setActiveSessionId(nextSession.id);
      setComposerPath(null);
      dispatchTranscript({ type: "begin", sessionId: nextSession.id });
      const [nextSessions, nextTranscript] = await Promise.all([
        getSessions(),
        getTranscript(nextSession.id)
      ]);
      if (!isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }
      setSessions(nextSessions);
      dispatchTranscript({ type: "snapshot", sessionId: nextSession.id, messages: nextTranscript });
      restoreSessionJob(nextSessions.find((item) => item.id === createdSessionId) ?? nextSession);
      setMobileView("chat");
    } catch (nextError) {
      if (!isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }
      dispatchTranscript({ type: "failed", sessionId: nextSession?.id ?? null });
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }

  async function loadSessionIntoView(nextSession: Session | SessionSummary): Promise<void> {
    const sessionRequestId = beginSessionViewRequest();
    seenEvents.current.clear();
    activeSessionIdRef.current = nextSession.id;
    setCapabilityApprovals([]);
    commitActiveAgentJob(EMPTY_ACTIVE_AGENT_JOB);
    setSession(nextSession);
    setActiveSessionId(nextSession.id);
    dispatchTranscript({ type: "begin", sessionId: nextSession.id });
    try {
      const nextTranscript = await getTranscript(nextSession.id);
      if (!isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }
      dispatchTranscript({ type: "snapshot", sessionId: nextSession.id, messages: nextTranscript });
      setComposerPath(null);
      restoreSessionJob(nextSession);
    } catch (error) {
      if (isCurrentSessionViewRequest(sessionRequestId)) {
        dispatchTranscript({ type: "failed", sessionId: nextSession.id });
      }
      throw error;
    }
  }

  async function deleteActiveSession() {
    if (!activeSessionId) {
      return;
    }

    setStatus("loading");
    setError(null);
    try {
      await deleteSession(activeSessionId);
      const remainingSessions = await getSessions();
      const nextSession = remainingSessions[0] ?? (await createSession("."));
      const nextSessions = remainingSessions.length ? remainingSessions : await getSessions();
      setSessions(nextSessions);
      commitActiveAgentJob(EMPTY_ACTIVE_AGENT_JOB);
      setMessage("");
      setComposerPath(null);
      await loadSessionIntoView(nextSession);
      await refreshWorkQueues();
      setStatus("ready");
      setMobileView("chat");
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setStatus("error");
      void reloadSessions();
    }
  }

  function restoreSessionJob(nextSession: Session | SessionSummary): void {
    const activeJob = "activeJob" in nextSession ? nextSession.activeJob : null;
    commitActiveAgentJob({
      id: activeJob?.id ?? null,
      status: activeJob?.status ?? null
    });
    if (activeJob?.status === "running") {
      setStatus("agent-running");
    } else if (activeJob?.status === "queued") {
      setStatus("queued");
    } else {
      setStatus("ready");
    }
  }

  async function refreshFiles() {
    if (!selectedStoragePoolId) {
      return;
    }
    const requestStoragePoolId = selectedStoragePoolId;
    setStatus(activeSearchQueryRef.current ? "searching" : "loading");
    try {
      const committed = await refreshCurrentFileListing(activeSearchQueryRef.current, true);
      if (committed && selectedStoragePoolIdRef.current === requestStoragePoolId) {
        setStatus("ready");
      }
    } catch (nextError) {
      if (selectedStoragePoolIdRef.current !== requestStoragePoolId) {
        return;
      }
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }

  async function refreshCurrentFileListing(
    query = activeSearchQueryRef.current,
    visible = false
  ): Promise<boolean> {
    if (!selectedStoragePoolId) {
      return false;
    }
    if (query) {
      return executeAdvancedSearch(undefined, null, false, visible);
    }
    const fileRequestId = beginFileListingRequest(visible);
    try {
      const listing = await loadFileListingForView(selectedStoragePoolId, currentPath, query);
      return commitFileListing(fileRequestId, listing);
    } catch (error) {
      finishFileListingRequest(fileRequestId);
      throw error;
    }
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await executeAdvancedSearch();
  }

  async function executeAdvancedSearch(
    options = searchOptions,
    cursor: string | null = null,
    append = false,
    visible = true
  ): Promise<boolean> {
    const query = searchQuery.trim();
    const hasFilters = hasWorkspaceSearchFilters(options);
    if (!selectedStoragePoolId) return false;
    if (!query && !hasFilters) {
      activeSearchQueryRef.current = "";
      setSearchResults(null);
      setSearchNextCursor(null);
      await refreshFiles();
      return true;
    }

    setStatus("searching");
    activeSearchQueryRef.current = query || "__filters__";
    const fileRequestId = beginFileListingRequest(visible);
    try {
      const request: IndexSearchRequest = {
        storagePoolId: selectedStoragePoolId,
        path: currentPath,
        sort: options.sort,
        cursor,
        limit: 50,
        ...(query ? { query } : {}),
        ...(options.fileType ? { categories: [options.fileType] } : {}),
        ...optionalProperty("modifiedFrom", searchDateBoundary(options.modifiedFrom, false)),
        ...optionalProperty("modifiedTo", searchDateBoundary(options.modifiedTo, true)),
        ...optionalProperty("sizeMin", optionalSearchNumber(options.sizeMin)),
        ...optionalProperty("sizeMax", optionalSearchNumber(options.sizeMax))
      };
      const page = await searchIndex(request);
      const combined = append ? [...(searchResults ?? []), ...page.files] : page.files;
      const entries = combined.map(indexSearchResultToFileEntry);
      if (!commitFileListing(fileRequestId, { entries, git: null })) {
        return false;
      }
      setSearchResults(combined);
      setSearchNextCursor(page.nextCursor);
      setSelectedFilePath(null);
      setStatus("ready");
      return true;
    } catch (nextError) {
      if (!isCurrentFileListingRequest(fileRequestId)) {
        return false;
      }
      finishFileListingRequest(fileRequestId);
      setError(toErrorMessage(nextError));
      setStatus("error");
      return false;
    }
  }

  function applySearchFilters(options?: WorkspaceSearchOptions) {
    if (options) setSearchOptions(options);
    void executeAdvancedSearch(options ?? searchOptions);
  }

  function loadMoreSearchResults() {
    if (searchNextCursor) void executeAdvancedSearch(searchOptions, searchNextCursor, true);
  }

  async function openDirectory(pathname: string) {
    if (!selectedStoragePoolId || !selectedStoragePool) {
      return;
    }
    const requestStoragePoolId = selectedStoragePool.id;
    if (!isPathWithinStoragePool(pathname, selectedStoragePool.path)) {
      setError(String(t("workspace.pathOutsideStoragePool")));
      return;
    }
    setStatus("loading");
    setError(null);
    setSearchQuery("");
    activeSearchQueryRef.current = "";
    setSearchResults(null);
    setSearchNextCursor(null);
    setSelectedFilePath(null);
    setPreviewMeta(null);
    setTextPreview(null);
    const fileRequestId = beginFileListingRequest(true);
    try {
      const nextListing = await getFiles(selectedStoragePool.id, pathname);
      if (
        !isCurrentFileListingRequest(fileRequestId) ||
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      commitFileListing(fileRequestId, nextListing);
      setCurrentPath(pathname);
      const updatedSession = session
        ? await updateSessionPath(session.id, sessionWorkspacePath(requestStoragePoolId, pathname))
        : null;
      if (
        !isCurrentFileListingRequest(fileRequestId) ||
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      if (updatedSession) {
        setSession((current) => (current?.id === updatedSession.id ? updatedSession : current));
      }
      if (!(await reloadSessions())) {
        return;
      }
      setStatus("ready");
    } catch (nextError) {
      if (
        !isCurrentFileListingRequest(fileRequestId) ||
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      finishFileListingRequest(fileRequestId);
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>, deliveryMode: AgentDeliveryMode) {
    event.preventDefault();
    const typedContent = message.trim();
    const attachedPath = composerPath;
    const content = composeAgentMessage(typedContent, attachedPath);
    if (!session || !content || messageSubmitting || transcriptState.phase === "loading") {
      return;
    }

    const activeTurn = hasActiveAgentTurn(activeJobId, activeJobStatus);
    if (activeJobId && !activeTurn) return;
    const isQueuedInput = activeTurn && deliveryMode !== "prompt";
    const now = new Date().toISOString();
    const optimisticMessage = {
      id: `local:${now}`,
      role: "user" as const,
      content,
      createdAt: now,
      sequence: null,
      turnSequence: null
    };

    setMessageSubmitting(true);
    setMessage("");
    setComposerPath(null);
    setError(null);
    if (!isQueuedInput) {
      dispatchTranscript({ type: "optimistic", sessionId: session.id, message: optimisticMessage });
      setStatus("queued");
    }
    try {
      if (isQueuedInput) {
        await sendAgentSessionCommand(session.id, deliveryMode, { content });
        return;
      }
      const result = await sendMessage(session.id, content, currentPath);
      dispatchTranscript({
        type: "acknowledge",
        sessionId: session.id,
        optimisticId: optimisticMessage.id,
        message: result.transcriptMessage
      });
      transitionActiveAgentJob((current) => current.status === "running"
        ? current
        : { id: result.job.id, status: result.job.status });
      void reloadSessions();
    } catch (nextError) {
      if (!isQueuedInput) {
        dispatchTranscript({ type: "rollback", sessionId: session.id, optimisticId: optimisticMessage.id });
      }
      setMessage((current) => (current.length > 0 ? current : typedContent));
      setComposerPath((current) => current ?? attachedPath);
      setError(toErrorMessage(nextError));
      setStatus("error");
    } finally {
      setMessageSubmitting(false);
    }
  }

  async function cancelActiveJob() {
    if (!activeJobId || !session) {
      return;
    }
    try {
      if (hasActiveAgentTurn(activeJobId, activeJobStatus)) {
        await sendAgentSessionCommand(session.id, "abort");
      } else {
        await cancelJob(activeJobId);
      }
      setStatus("cancelling");
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }

  async function retryInterruptedJob() {
    if (!retryJobId) return;
    const result = await retryAgentJob(retryJobId);
    setRetryJobId(null);
    transitionActiveAgentJob((current) => current.status === "running"
      ? current
      : { id: result.job.id, status: result.job.status });
    dispatchTranscript({
      type: "event",
      sessionId: result.job.sessionId,
      message: result.transcriptMessage
    });
    setStatus("queued");
  }

  function nextUploadBatchId(): string {
    uploadBatchSequenceRef.current += 1;
    return `upload-${Date.now().toString(36)}-${uploadBatchSequenceRef.current}`;
  }

  function getNextQueuedUploadItemId(batch: UploadBatchState, currentItemId: string): string | null {
    return batch.items.find((item) => item.id !== currentItemId && item.status === "queued")?.id ?? null;
  }

  function setUploadBatch(batchId: string, updater: (batch: UploadBatchState) => UploadBatchState) {
    setUploadBatches((current) => updateUploadBatch(current, batchId, updater));
  }

  function settleUploadBatch(batchId: string, status: UploadBatchState["status"], error: string | null) {
    setUploadBatch(batchId, (batch) => ({
      ...batch,
      status,
      currentItemId: status === "uploading" ? batch.currentItemId : null,
      error
    }));
  }

  function markUploadBatchCancelled(batchId: string) {
    setUploadBatch(batchId, (batch) => ({
      ...batch,
      status: "cancelled",
      currentItemId: null,
      error: t("workspace.uploadCancelled"),
      items: batch.items.map((item) =>
        item.status === "completed"
          ? item
          : {
              ...item,
              status: "cancelled",
              error: item.error ?? t("workspace.uploadCancelled")
            }
      )
    }));
  }

  function markUploadItemUploading(batchId: string, itemId: string) {
    setUploadBatch(batchId, (batch) => ({
      ...updateUploadBatchItem(batch, itemId, (item) => ({
        ...item,
        status: "uploading",
        uploadedBytes: 0,
        error: null
      })),
      status: "uploading",
      currentItemId: itemId,
      error: batch.error
    }));
  }

  function markUploadItemProgress(batchId: string, itemId: string, uploadedBytes: number) {
    setUploadBatch(batchId, (batch) =>
      updateUploadBatchItem(batch, itemId, (item) => ({
        ...item,
        status: "uploading",
        uploadedBytes,
        error: null
      }))
    );
  }

  function markUploadItemCompleted(batchId: string, itemId: string) {
    setUploadBatch(batchId, (batch) => {
      const nextBatch = updateUploadBatchItem(batch, itemId, (item) => ({
        ...item,
        status: "completed",
        uploadedBytes: item.sizeBytes,
        error: null
      }));
      return {
        ...nextBatch,
        currentItemId: getNextQueuedUploadItemId(nextBatch, itemId)
      };
    });
  }

  function markUploadItemFailed(batchId: string, itemId: string, errorMessage: string) {
    setUploadBatch(batchId, (batch) => {
      const nextBatch = updateUploadBatchItem(batch, itemId, (item) => ({
        ...item,
        status: "failed",
        error: errorMessage
      }));
      return {
        ...nextBatch,
        currentItemId: getNextQueuedUploadItemId(nextBatch, itemId),
        error: batch.error ?? errorMessage
      };
    });
  }

  async function onUploadSources(sources: UploadSource[]) {
    const storagePoolId = selectedStoragePoolIdRef.current;
    if (!storagePoolId || !sources.length || !selectedStoragePool) {
      return;
    }

    const batchId = nextUploadBatchId();
    const uploadBatch = createUploadBatch({
      id: batchId,
      storagePoolId,
      currentPath: currentPathRef.current,
      sources
    });
    const batchControllers = new Set<AbortController>();
    uploadAbortControllersRef.current.set(batchId, batchControllers);
    setUploadBatches((current) => pruneUploadBatchHistory([uploadBatch, ...current], MAX_UPLOAD_BATCHES));

    let encounteredError: string | null = null;
    let cancelled = false;

    try {
      setUploadBatch(batchId, (batch) => ({
        ...batch,
        status: "uploading",
        currentItemId: batch.items[0]?.id ?? null
      }));

      for (const item of uploadBatch.items) {
        if (cancelledUploadBatchesRef.current.has(batchId)) {
          cancelled = true;
          break;
        }

        const controller = new AbortController();
        batchControllers.add(controller);
        markUploadItemUploading(batchId, item.id);

        try {
          const result = await uploadFile({
            storagePoolId,
            path: item.targetPath,
            file: item.file,
            signal: controller.signal,
            onProgress: (progress) => {
              if (cancelledUploadBatchesRef.current.has(batchId)) {
                return;
              }
              markUploadItemProgress(batchId, item.id, progress.loadedBytes);
            }
          });

          markUploadItemCompleted(batchId, item.id);
          if (selectedStoragePoolIdRef.current === storagePoolId) {
            setOperations((current) => [result.operation, ...current.filter((operation) => operation.id !== result.operation.id)].slice(0, 100));
          }
        } catch (error) {
          if (cancelledUploadBatchesRef.current.has(batchId) || (error instanceof DOMException && error.name === "AbortError")) {
            cancelled = true;
            markUploadBatchCancelled(batchId);
            break;
          }

          const errorMessage = toErrorMessage(error);
          encounteredError = encounteredError ?? errorMessage;
          markUploadItemFailed(batchId, item.id, errorMessage);
        } finally {
          batchControllers.delete(controller);
        }
      }

      if (cancelled) {
        markUploadBatchCancelled(batchId);
      } else if (encounteredError) {
        settleUploadBatch(batchId, "failed", encounteredError);
      } else {
        settleUploadBatch(batchId, "completed", null);
        if (selectedStoragePoolIdRef.current === storagePoolId && currentPathRef.current === uploadBatch.targetPath && !activeSearchQueryRef.current) {
          await refreshCurrentFileListing().catch((nextError: unknown) => {
            setError(toErrorMessage(nextError));
            setStatus("error");
          });
        }
      }
      await refreshWorkQueues();
    } finally {
      batchControllers.clear();
      uploadAbortControllersRef.current.delete(batchId);
      cancelledUploadBatchesRef.current.delete(batchId);
      setUploadBatches((current) => pruneUploadBatchHistory(current, MAX_UPLOAD_BATCHES));
    }
  }

  function onCancelUploadBatch(batchId: string) {
    const batch = uploadBatches.find((item) => item.id === batchId);
    if (!batch || (batch.status !== "queued" && batch.status !== "uploading")) {
      return;
    }
    cancelledUploadBatchesRef.current.add(batchId);
    uploadAbortControllersRef.current.get(batchId)?.forEach((controller) => controller.abort());
    markUploadBatchCancelled(batchId);
  }

  function refreshWorkQueues(): Promise<void> {
    workQueueRefreshRef.current ??= createTrailingSingleFlight(performWorkQueueRefresh);
    return workQueueRefreshRef.current.request();
  }

  async function performWorkQueueRefresh(): Promise<void> {
    const queueSessionId = activeSessionIdRef.current || null;
    const queueStoragePoolId = selectedStoragePoolIdRef.current;
    try {
      const [nextApprovals, nextOperations, nextFileBatches, nextDockerOperations, nextVmOperations, nextNotifications] = await Promise.all([
        queueSessionId ? getApprovals(queueSessionId) : Promise.resolve({ capabilityApprovals: [] }),
        getOperations(),
        getFileBatches({ storagePoolId: queueStoragePoolId }),
        getDockerOperations(),
        getVmOperations(),
        getNotifications()
      ]);
      if (queueSessionId !== (activeSessionIdRef.current || null) || queueStoragePoolId !== selectedStoragePoolIdRef.current) {
        return;
      }
      setCapabilityApprovals(nextApprovals.capabilityApprovals);
      setOperations(
        queueStoragePoolId
          ? nextOperations.filter((operation) => operation.metadata.storagePoolId === queueStoragePoolId)
          : []
      );
      setFileBatches(nextFileBatches);
      setDockerOperations(nextDockerOperations);
      setVmOperations(nextVmOperations);
      setNotifications(nextNotifications.notifications);
      setBluetoothTransfers(nextNotifications.bluetoothTransfers);
      setOperationUnreadCount(nextNotifications.unreadCount);
      setBluetoothUnreadCount(nextNotifications.bluetoothUnreadCount);
      setNotificationsLoading(false);
      setOperationsReady(true);
    } catch (nextError) {
      if (queueSessionId !== (activeSessionIdRef.current || null) || queueStoragePoolId !== selectedStoragePoolIdRef.current) {
        return;
      }
      setError(toErrorMessage(nextError));
    }
  }

  async function refreshFileBatches() {
    const queueStoragePoolId = selectedStoragePoolIdRef.current;
    if (!queueStoragePoolId) {
      setFileBatches([]);
      return;
    }
    try {
      const batches = await getFileBatches({
        storagePoolId: queueStoragePoolId
      });
      if (
        queueStoragePoolId === selectedStoragePoolIdRef.current
      ) {
        setFileBatches(batches);
      }
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function handleCapabilityDecision(
    approval: CapabilityApproval,
    decision: "approved" | "rejected",
    options: { confirmed?: boolean; secretInput?: Record<string, string> } = {}
  ) {
    setStatus(decision === "approved" ? "applying" : "rejecting");
    try {
      await decideCapabilityApproval(approval, decision, options);
      await Promise.all([refreshWorkQueues(), refreshFiles(), reloadSessions()]);
      if (decision === "approved") {
        setSuccessNotice(t("notifications.operationSucceeded"));
      } else {
        setWarningNotice(t("notifications.operationRejected"));
      }
      setStatus("ready");
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      await Promise.all([refreshWorkQueues(), reloadSessions()]);
      setStatus("error");
    }
  }

  async function handleRollback(operation: FileOperation) {
    setStatus(operation.operation === "trash" ? "restoring" : "rolling-back");
    await rollbackOperation(operation.id);
    await Promise.all([refreshWorkQueues(), refreshFiles()]);
    setStatus("ready");
  }

  function changeLanguagePreference(preference: LanguagePreference) {
    writeStoredLanguagePreference(preference);
    setLanguagePreference(preference);
    void i18n.changeLanguage(preference === "system" ? resolveBrowserLocale() : preference);
  }

  function changePreviewFileSizeLimit(bytes: number) {
    const nextLimit = clampPreviewFileSizeLimitBytes(bytes);
    writeStoredPreviewFileSizeLimitBytes(nextLimit);
    setPreviewFileSizeLimitBytes(nextLimit);
  }

  function changeCodeFontSettings(nextSettings: CodeFontSettings) {
    const normalized = normalizeCodeFontSettings(nextSettings);
    writeStoredCodeFontSettings(normalized);
    setCodeFontSettings(normalized);
  }

  function handleEditorSaved(result: SaveEditableTextResult) {
    if (
      result.operation.metadata.storagePoolId &&
      result.operation.metadata.storagePoolId !== selectedStoragePoolIdRef.current
    ) {
      return;
    }
    if (
      result.operation.metadata.storagePoolId &&
      result.operation.metadata.storagePoolId !== selectedStoragePoolIdRef.current
    ) {
      return;
    }
    if (result.meta.path === selectedFilePath) {
      setPreviewMeta(result.meta);
      setTextPreview(result.textPreview);
    }
    setEntries((current) =>
      current.map((entry) =>
        entry.path === result.meta.path
          ? {
              ...entry,
              sizeBytes: result.meta.sizeBytes,
              modifiedAt: result.meta.modifiedAt
            }
          : entry
      )
    );
    setOperations((current) => [result.operation, ...current.filter((operation) => operation.id !== result.operation.id)].slice(0, 100));
    void refreshCurrentFileListing().catch((nextError: unknown) => {
      setError(toErrorMessage(nextError));
    });
  }

  async function requestFileRename(entry: FileEntry, targetName: string) {
    if (!selectedStoragePoolId) {
      throw new Error(t("workspace.actions.noSession"));
    }

    const requestStoragePoolId = selectedStoragePoolId;
    setStatus("applying");
    setError(null);
    try {
      const result = await applyFileMutation({
        storagePoolId: requestStoragePoolId,
        operation: "rename",
        sourcePath: entry.path,
        targetName
      });
      if (
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      if (selectedFilePath && result.operation.sourcePath && result.operation.targetPath) {
        const nextSelectedPath = renamedPath(
          selectedFilePath,
          result.operation.sourcePath,
          result.operation.targetPath
        );
        if (nextSelectedPath) {
          setSelectedFilePath(nextSelectedPath);
        }
      }
      setOperations((current) => [
        result.operation,
        ...current.filter((operation) => operation.id !== result.operation.id)
      ].slice(0, 100));
      setSuccessNotice(t("notifications.operationSucceeded"));
      setStatus("ready");
      void Promise.all([refreshWorkQueues(), refreshCurrentFileListing()]).catch((nextError: unknown) => {
        setError(toErrorMessage(nextError));
      });
    } catch (nextError) {
      setStatus("error");
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function requestFileTrash(entry: FileEntry) {
    await requestFileBatch([entry], "trash");
  }

  async function requestFileTransfer(entry: FileEntry, operation: "move" | "copy", targetPath: string) {
    if (!selectedStoragePoolId || !selectedStoragePool) {
      throw new Error(t("workspace.actions.noSession"));
    }

    if (operation === "move") {
      await requestFileBatch(
        [entry],
        "move",
        workspaceParentPath(joinNasPath(selectedStoragePool.path, targetPath))
      );
      return;
    }

    const requestStoragePoolId = selectedStoragePool.id;
    setStatus("applying");
    setError(null);
    try {
      const result = await applyFileMutation({
        storagePoolId: requestStoragePoolId,
        operation: "copy",
        sourcePath: entry.path,
        targetPath: joinNasPath(selectedStoragePool.path, targetPath)
      });
      if (
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      setOperations((current) => [
        result.operation,
        ...current.filter((operation) => operation.id !== result.operation.id)
      ].slice(0, 100));
      setSuccessNotice(t("notifications.operationSucceeded"));
      setStatus("ready");
      void Promise.all([refreshWorkQueues(), refreshCurrentFileListing()]).catch((nextError: unknown) => {
        setError(toErrorMessage(nextError));
      });
    } catch (nextError) {
      setStatus("error");
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function requestFileBatch(
    batchEntries: FileEntry[],
    operation: "move" | "trash",
    targetDirectory?: string
  ) {
    if (!selectedStoragePoolId) {
      throw new Error(t("workspace.actions.noSession"));
    }
    setStatus("queued");
    setError(null);
    try {
      await createFileBatch({
        storagePoolId: selectedStoragePoolId,
        operation,
        sourcePaths: batchEntries.map((entry) => entry.path),
        ...(targetDirectory ? { targetDirectory } : {})
      });
      await refreshWorkQueues();
      setSuccessNotice(t("workspace.batch.queued"));
      setStatus("ready");
    } catch (nextError) {
      setStatus("error");
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function cancelFileBatch(batchId: string) {
    try {
      await cancelFileBatchRequest(batchId);
      await refreshWorkQueues();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function requestFileExtract(meta: FileMeta) {
    if (!selectedStoragePoolId) {
      throw new Error(t("workspace.actions.noSession"));
    }
    const requestStoragePoolId = selectedStoragePoolId;

    setStatus("applying");
    setError(null);
    try {
      const result = await extractFile({
        storagePoolId: selectedStoragePoolId,
        path: meta.path
      });
      if (
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      setOperations((current) => [
        result.operation,
        ...current.filter((operation) => operation.id !== result.operation.id)
      ].slice(0, 100));
      await refreshCurrentFileListing();
      setStatus("ready");
    } catch (nextError) {
      if (
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      setStatus("error");
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function requestFolderCreateAt(input: {
    storagePoolId: string;
    parentPath: string;
    name: string;
  }) {
    setStatus("applying");
    setError(null);
    try {
      const result = await applyFileMutation({
        storagePoolId: input.storagePoolId,
        operation: "mkdir",
        targetPath: joinNasPath(input.parentPath, input.name)
      });
      const refreshes: Promise<unknown>[] = [refreshWorkQueues()];
      if (
        selectedStoragePoolIdRef.current === input.storagePoolId
      ) {
        setOperations((current) => [
          result.operation,
          ...current.filter((operation) => operation.id !== result.operation.id)
        ].slice(0, 100));
        refreshes.push(refreshCurrentFileListing());
      }
      setSuccessNotice(t("notifications.operationSucceeded"));
      setStatus("ready");
      void Promise.all(refreshes).catch((nextError: unknown) => {
        setError(toErrorMessage(nextError));
      });
    } catch (nextError) {
      setStatus("error");
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function requestFolderCreate(folderName: string) {
    if (!selectedStoragePoolId || !selectedStoragePool) {
      throw new Error(t("workspace.actions.noSession"));
    }

    await requestFolderCreateAt({
      storagePoolId: selectedStoragePool.id,
      parentPath: currentPath,
      name: folderName
    });
  }

  function selectStoragePool(poolId: string) {
    const pool = storagePoolOptions.find((item) => item.id === poolId);
    if (!pool) {
      return;
    }

    preferredStoragePoolIdRef.current = pool.id;
    writeStoredStoragePoolId(pool.id);

    beginFileListingRequest(true);
    selectedStoragePoolIdRef.current = pool.id;
    currentPathRef.current = pool.path;
    activeSearchQueryRef.current = "";
    setSearchQuery("");
    setSearchResults(null);
    setSearchNextCursor(null);
    setComposerPath(null);
    setWarningNotice(null);
    setSelectedFilePath(null);
    setPreviewMeta(null);
    setTextPreview(null);
    setPreviewError(null);
    setEditorMeta(null);
    setEntries([]);
    setGitStatus(null);
    setSelectedStoragePoolId(pool.id);
    setCurrentPath(pool.path);
  }

  function openDownloadedDirectory(storagePoolId: string, pathname: string) {
    setMobileView("workspace");
    if (selectedStoragePoolIdRef.current !== storagePoolId) {
      pendingDownloadedDirectoryRef.current = { storagePoolId, path: pathname };
      selectStoragePool(storagePoolId);
      return;
    }
    void openDirectory(pathname);
  }

  function beginFileListingRequest(visible = false): number {
    fileListingRequestId.current += 1;
    setFileListingLoading(visible);
    return fileListingRequestId.current;
  }

  function finishFileListingRequest(requestId: number): boolean {
    if (!isCurrentFileListingRequest(requestId)) {
      return false;
    }
    setFileListingLoading(false);
    return true;
  }

  function beginSessionViewRequest(): number {
    sessionViewRequestId.current += 1;
    return sessionViewRequestId.current;
  }

  function isCurrentSessionViewRequest(requestId: number): boolean {
    return sessionViewRequestId.current === requestId;
  }

  function isCurrentFileListingRequest(requestId: number): boolean {
    return fileListingRequestId.current === requestId;
  }

  function commitFileListing(requestId: number, listing: FileListing): boolean {
    if (!isCurrentFileListingRequest(requestId)) {
      return false;
    }
    setEntries(listing.entries);
    setGitStatus(listing.git);
    setFileListingLoading(false);
    return true;
  }

  function openEntry(entry: FileEntry) {
    if (!entry.isSafe) {
      return;
    }
    if (entry.kind === "directory") {
      void openDirectory(entry.path);
      return;
    }
    if (entry.kind === "file") {
      setSelectedFilePath(entry.path);
      setMobileView("workspace");
    }
  }

  async function playSelectedOnVodPlayer(expectedSessionId?: string) {
    if (!selectedStoragePoolId || !selectedFilePath || previewMeta?.previewKind !== "video") {
      return;
    }
    setVodPlayerBusy(true);
    try {
      const next = await sendVodPlayerCommand({
          type: "play",
          storagePoolId: selectedStoragePoolId,
          path: selectedFilePath,
          ...(expectedSessionId ? { expectedSessionId } : {})
        });
      setVideoTakeover(null);
      setVodPlayerStatus((current) => acceptVodPlayerStatus(current, next));
    } catch (nextError) {
      if (typeof nextError === "object" && nextError !== null && "statusCode" in nextError && nextError.statusCode === 409) {
        const player = await getMusicPlayer().catch(() => null);
        if (player?.owner === "music" && player.sessionId) { setVideoTakeover(player.sessionId); return; }
      }
      setVideoTakeover(null);
      reportVodPlayerError(nextError);
    } finally {
      setVodPlayerBusy(false);
    }
  }

  function issueVodPlayerCommand(command: Exclude<VodPlayerCommand, { type: "play" }>) {
    setVodPlayerBusy(true);
    void sendVodPlayerCommand(command)
      .then((next) => setVodPlayerStatus((current) => acceptVodPlayerStatus(current, next)))
      .catch((nextError: unknown) => reportVodPlayerError(nextError))
      .finally(() => setVodPlayerBusy(false));
  }

  function retryVodPlayback() {
    if (vodPlayerStatus?.sessionId) {
      issueVodPlayerCommand({ type: "retry", sessionId: vodPlayerStatus.sessionId });
    } else {
      void playSelectedOnVodPlayer();
    }
  }

  function reportVodPlayerError(nextError: unknown) {
    const message = toErrorMessage(nextError);
    const errorCode = vodPlayerErrorCode(nextError);
    setVodPlayerStatus((current) => ({
      state: "error",
      sessionId: current?.sessionId ?? null,
      serviceInstanceId: "client-error",
      revision: 0,
      storagePoolId: selectedStoragePoolId || current?.storagePoolId || null,
      relativePath: selectedFilePath || current?.relativePath || null,
      fileName: previewMeta?.name || current?.fileName || selectedFilePath?.split("/").pop() || null,
      mediaFileId: current?.mediaFileId ?? null,
      videoOutput: current?.videoOutput ?? "drm",
      positionSeconds: current?.positionSeconds ?? 0,
      durationSeconds: current?.durationSeconds ?? null,
      volume: current?.volume ?? 100,
      retryCount: current?.retryCount ?? 0,
      nextRetryAt: null,
      audioDeviceId: current?.audioDeviceId ?? null,
      effectiveAudioDeviceId: current?.effectiveAudioDeviceId ?? null,
      audioFallbackReason: current?.audioFallbackReason ?? null,
      audioTracks: current?.audioTracks ?? [],
      subtitleTracks: current?.subtitleTracks ?? [],
      selectedAudioTrackId: current?.selectedAudioTrackId ?? null,
      selectedSubtitleTrackId: current?.selectedSubtitleTrackId ?? null,
      capabilities: current?.capabilities ?? {
        mpvAvailable: false,
        drmAvailable: false,
        audioAvailable: false,
        hardwareDecode: "unknown",
        error: message
      },
      error: message,
      errorCode,
      updatedAt: current?.updatedAt ?? new Date().toISOString()
    }));
    setError(message);
  }

  function insertWorkspacePathInComposer(relativePath: string) {
    if (!selectedStoragePool) {
      return;
    }
    setComposerPath(workspaceAbsolutePath(selectedStoragePool.mountpoint ?? "/cyberos/data", relativePath));
    setMobileView("chat");
  }

  async function openWorkspacePath(pathname: string) {
    if (!selectedStoragePoolId || !selectedStoragePool) {
      setWarningNotice(t("workspace.selectStoragePoolBody"));
      return;
    }

    setMobileView("workspace");
    setFilesPanelActivationId((current) => current + 1);
    setStatus("loading");
    setError(null);
    setPreviewError(null);
    const fileRequestId = beginFileListingRequest(true);
    const requestStoragePoolId = selectedStoragePool.id;
    const hadActiveSearch = Boolean(activeSearchQueryRef.current);
    try {
      const linkedMeta = await getFileMeta(selectedStoragePool.id, pathname);
      if (
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      if (linkedMeta.kind === "directory") {
        await openDirectory(linkedMeta.path);
        return;
      }

      activeSearchQueryRef.current = "";
      setSearchQuery("");
      setSearchResults(null);
      setSearchNextCursor(null);
      const parentPath = workspaceParentPath(linkedMeta.path);
      if (currentPathRef.current !== parentPath || hadActiveSearch) {
        await openDirectory(parentPath);
        if (
          selectedStoragePoolIdRef.current !== requestStoragePoolId
        ) {
          return;
        }
      }
      setSelectedFilePath(linkedMeta.path);
      finishFileListingRequest(fileRequestId);
      setStatus("ready");
    } catch (nextError) {
      if (
          selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      finishFileListingRequest(fileRequestId);
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }

  function goUp() {
    if (!selectedStoragePool || currentPath === selectedStoragePool.path) {
      return;
    }
    const nextPath = currentPath.split("/").slice(0, -1).join("/") || ".";
    void openDirectory(nextPath);
  }

  function goToBreadcrumb(index: number) {
    if (!selectedStoragePool) {
      return;
    }
    const nextPath = index < 0 ? selectedStoragePool.path : breadcrumbs.slice(0, index + 1).join("/");
    void openDirectory(nextPath || selectedStoragePool.path);
  }

  function goToStoragePool() {
    if (selectedStoragePool) {
      void openDirectory(selectedStoragePool.path);
    }
  }

  function startResize(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    setResizing(true);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSplitWidth((current) => clampSplitWidth(current - 24));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setSplitWidth((current) => clampSplitWidth(current + 24));
    }
  }

  return (
    <main
      className={`app-shell${resizing ? " is-resizing" : ""}${playback.barVisible ? " has-playback-dock" : ""}`}
      style={appStyle}
    >
      <div className="mobile-tabs">
        <div className="mobile-tab-buttons" role="group" aria-label={t("chat.primaryViews")}>
          <button
            type="button"
            className={mobileView === "chat" ? "is-active" : ""}
            aria-pressed={mobileView === "chat"}
            onClick={() => setMobileView("chat")}
          >
            <MessageSquare aria-hidden="true" size={16} />
            <span>{t("chat.mobileChat")}</span>
          </button>
          <button
            type="button"
            className={mobileView === "workspace" ? "is-active" : ""}
            aria-pressed={mobileView === "workspace"}
            onClick={() => setMobileView("workspace")}
          >
            <PanelRight aria-hidden="true" size={16} />
            <span>{t("chat.mobileWorkspace")}</span>
          </button>
        </div>
        <PlaybackRestoreButton className="playback-restore--mobile" />
      </div>

      <ChatPane
        active={mobileView === "chat"}
        selectedRoot={selectedStoragePool}
        activeSessionSummary={activeSessionSummary}
        sessions={sessions}
        activeSessionId={activeSessionId}
        transcript={transcript}
        transcriptPhase={transcriptState.phase}
        activeCapabilityApprovals={capabilityApprovals}
        agentToolActivities={agentToolActivities}
        message={message}
        composerPath={composerPath}
        status={status}
        locale={resolvedLocale}
        modelSettings={modelSettings}
        activeJobId={activeJobId}
        activeJobStatus={activeJobStatus}
        retryJobId={retryJobId}
        hasSession={Boolean(session)}
        messageSubmitting={messageSubmitting}
        transcriptRef={transcriptRef}
        onCreateAgent={() => void createAgent()}
        onDeleteSession={() => void deleteActiveSession()}
        onOpenSettings={() => void openSettings()}
        onOpenNotifications={openNotificationCenter}
        onRequestSystemPower={handleSystemPower}
        notificationUnreadCount={notificationUnreadCount}
        onSelectSession={(nextSession) => void selectSession(nextSession)}
        onApproveCapability={(approval, options) => void handleCapabilityDecision(approval, "approved", options)}
        onRejectCapability={(approval) => void handleCapabilityDecision(approval, "rejected")}
        onSubmitMessage={(event, deliveryMode) => void submitMessage(event, deliveryMode)}
        onMessageChange={setMessage}
        onClearComposerPath={() => setComposerPath(null)}
        onCancelActiveJob={() => void cancelActiveJob()}
        onRetryInterruptedJob={() => void retryInterruptedJob()}
        onOpenWorkspacePath={(path) => void openWorkspacePath(path)}
      />

      {error || successNotice || warningNotice ? (
        <div className="app-notification-region" aria-live="polite" aria-atomic="false">
          {error ? (
            <section key={`error:${error}`} className="app-notification" data-tone="error" role="alert">
              <AlertTriangle aria-hidden="true" size={18} />
              <div>
                <strong>{t("notifications.errorTitle")}</strong>
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label={t("common.actions.dismissNotification")}
                title={t("common.actions.dismissNotification")}
              >
                <X aria-hidden="true" size={15} />
              </button>
            </section>
          ) : null}
          {successNotice ? (
            <section key={`success:${successNotice}`} className="app-notification" data-tone="success" role="status">
              <CircleCheck aria-hidden="true" size={18} />
              <div>
                <strong>{t("notifications.successTitle")}</strong>
                <span>{successNotice}</span>
              </div>
              <button
                type="button"
                onClick={() => setSuccessNotice(null)}
                aria-label={t("common.actions.dismissNotification")}
                title={t("common.actions.dismissNotification")}
              >
                <X aria-hidden="true" size={15} />
              </button>
            </section>
          ) : null}
          {warningNotice ? (
            <section key={`warning:${warningNotice}`} className="app-notification" data-tone="warning" role="status">
              <CircleAlert aria-hidden="true" size={18} />
              <div>
                <strong>{t("notifications.warningTitle")}</strong>
                <span>{warningNotice}</span>
              </div>
              <button
                type="button"
                onClick={() => setWarningNotice(null)}
                aria-label={t("common.actions.dismissNotification")}
                title={t("common.actions.dismissNotification")}
              >
                <X aria-hidden="true" size={15} />
              </button>
            </section>
          ) : null}
        </div>
      ) : null}

      <button
        className="split-handle"
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("common.actions.resizePanes")}
        aria-valuemin={MIN_CHAT_WIDTH}
        aria-valuemax={clampSplitWidth(Number.POSITIVE_INFINITY)}
        aria-valuenow={splitWidth}
        onPointerDown={startResize}
        onKeyDown={resizeWithKeyboard}
      />

      <WorkspacePane
        active={mobileView === "workspace"}
        storagePools={storagePoolOptions}
        storageSummaryLoading={storageSummaryLoading}
        photoLibrarySettingsUpdatedAt={photoSettings?.updatedAt ?? null}
        selectedStoragePoolId={selectedStoragePoolId}
        currentPath={currentPath}
        breadcrumbs={breadcrumbs}
        entries={entries}
        fileListingLoading={storageSummaryLoading || fileListingLoading}
        gitStatus={gitStatus}
        selectedFilePath={selectedFilePath}
        previewMeta={previewMeta}
        previewLoading={previewLoading}
        previewError={previewError}
        textPreview={textPreview}
        blobUrl={blobUrl}
        videoUrl={videoUrl}
        vodPlayerStatus={vodPlayerStatus}
        vodPlayerBusy={vodPlayerBusy}
        previewFileSizeLimitBytes={previewFileSizeLimitBytes}
        searchQuery={searchQuery}
        searchOptions={searchOptions}
        searchResults={searchResults}
        searchNextCursor={searchNextCursor}
        operations={operations}
        fileBatches={fileBatches}
        uploadBatches={visibleUploadBatches}
        dockerOperations={dockerOperations}
        vmOperations={vmOperations}
        operationsReady={operationsReady}
        locale={resolvedLocale}
        codeFontSettings={codeFontSettings}
        filesPanelActivationId={filesPanelActivationId}
        onSelectStoragePool={selectStoragePool}
        onOpenDownloadedDirectory={openDownloadedDirectory}
        onGoUp={goUp}
        onRefreshFiles={() => void refreshFiles()}
        onSubmitSearch={(event) => void submitSearch(event)}
        onSearchQueryChange={setSearchQuery}
        onSearchOptionsChange={setSearchOptions}
        onApplySearchFilters={applySearchFilters}
        onLoadMoreSearchResults={loadMoreSearchResults}
        onGoToBreadcrumb={goToBreadcrumb}
        onGoToStoragePool={goToStoragePool}
        onOpenEntry={openEntry}
        onOpenWorkspacePath={(path) => void openWorkspacePath(path)}
        onInsertWorkspacePath={(path) => insertWorkspacePathInComposer(path)}
        onOpenEditor={setEditorMeta}
        onPlayToVodPlayer={() => void playSelectedOnVodPlayer()}
        onVodPlayerCommand={issueVodPlayerCommand}
        onRetryVodPlayer={retryVodPlayback}
        onRequestCreateFolder={(folderName) => requestFolderCreate(folderName)}
        onRequestCreateFolderAt={(input) => requestFolderCreateAt(input)}
        onRequestRename={(entry, targetName) => requestFileRename(entry, targetName)}
        onRequestTrash={(entry) => requestFileTrash(entry)}
        onRequestTransfer={(entry, operation, targetPath) => requestFileTransfer(entry, operation, targetPath)}
        onRequestBatch={(batchEntries, operation, targetDirectory) => requestFileBatch(batchEntries, operation, targetDirectory)}
        onRequestExtract={(meta) => requestFileExtract(meta)}
        onUploadSources={(sources) => onUploadSources(sources)}
        onCancelUploadBatch={(batchId) => onCancelUploadBatch(batchId)}
        onCancelFileBatch={(batchId) => void cancelFileBatch(batchId)}
        onWorkQueuesChanged={() => {
          void refreshWorkQueues();
          void refreshStorageSummary();
        }}
        onNotifyError={setError}
        onNotifySuccess={setSuccessNotice}
        onNotifyWarning={setWarningNotice}
        onOpenDeviceSettings={(section) => void openSettings(section)}
        onOpenPhotoSettings={() => void openSettings("photos")}
        onClosePreview={() => setSelectedFilePath(null)}
        onRollback={(operation) => void handleRollback(operation)}
      />

      <NotificationCenter
        open={notificationCenterOpen}
        loading={notificationsLoading}
        notifications={notifications}
        bluetoothTransfers={bluetoothTransfers}
        alertIncidents={alertIncidents}
        unreadCount={notificationUnreadCount}
        operationUnreadCount={operationUnreadCount}
        bluetoothUnreadCount={bluetoothUnreadCount}
        alertUnreadCount={alertUnreadCount}
        locale={resolvedLocale}
        onClose={closeNotificationCenter}
        onRead={(id) => void readNotification(id)}
        onReadAll={() => void readAllNotifications()}
        onReadBluetooth={(id) => void readBluetoothTransfer(id)}
        onReadAllBluetooth={() => void readAllBluetoothTransfers()}
        onReadAlert={(id) => void readAlertIncident(id)}
        onReadAllAlerts={() => void readAllAlertIncidents()}
        onAcknowledgeAlert={(id) => void acknowledgeAlertIncident(id)}
      />

      {editorMeta ? (
        <FileEditorModal
          storagePoolId={selectedStoragePoolId}
          meta={editorMeta}
          locale={resolvedLocale}
          onClose={() => setEditorMeta(null)}
          onSaved={handleEditorSaved}
          onNotifyError={setError}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsModal
          activeSection={activeSettingsSection}
          activeSessionId={activeSessionId}
          form={modelSettingsForm}
          loading={settingsLoading}
          saving={settingsSaving}
          settings={modelSettings}
          dockerSettings={dockerSettings}
          vmSettings={vmSettings}
          downloadSettings={downloadSettings}
          indexerSettings={indexerSettings}
          indexerStatus={indexerStatus}
          storagePools={storagePoolOptions}
          photoSettings={photoSettings}
          photoStatus={photoStatus}
          photoProcessingSettings={photoProcessingSettings}
          dockerForm={dockerSettingsForm}
          vmForm={vmSettingsForm}
          systemInfo={systemInfo}
          buildInfo={buildInfo}
          buildInfoError={buildInfoError}
          toolPolicyForm={toolPolicyForm}
          languagePreference={languagePreference}
          previewFileSizeLimitBytes={previewFileSizeLimitBytes}
          codeFontSettings={codeFontSettings}
          networkSummary={settingsNetwork}
          bluetoothStatus={settingsBluetooth}
          resolvedLocale={resolvedLocale}
          onClose={() => setSettingsOpen(false)}
          onFormChange={setModelSettingsForm}
          onDockerFormChange={setDockerSettingsForm}
          onVmFormChange={setVmSettingsForm}
          onDownloadSettingsChange={changeDownloadSettings}
          onIndexerSettingsChange={changeIndexerSettings}
          onIndexerReindex={reindexRoot}
          onPhotoLibrarySettingsChange={changePhotoLibrarySettings}
          onPhotoProcessingSettingsChange={changePhotoProcessingSettings}
          onRequestCreateFolder={requestFolderCreateAt}
          onToolPolicyFormChange={setToolPolicyForm}
          onLanguagePreferenceChange={changeLanguagePreference}
          onPreviewFileSizeLimitChange={changePreviewFileSizeLimit}
          onCodeFontSettingsChange={changeCodeFontSettings}
          onWifiStatus={handleSettingsWifiStatus}
          onBluetoothStatus={setSettingsBluetooth}
          onNetworkRefresh={refreshSettingsNetwork}
          onNotifySuccess={setSuccessNotice}
          onNotifyError={setError}
          onSectionChange={setActiveSettingsSection}
          onSubmit={(event) => void saveSettings(event)}
        />
      ) : null}
      {videoTakeover ? <MusicTakeoverDialog title={t("music.takeoverTitle")} body={t("music.takeoverMusic")} busy={vodPlayerBusy} onCancel={() => setVideoTakeover(null)} onConfirm={() => void playSelectedOnVodPlayer(videoTakeover)} /> : null}
      <PlaybackBar onOpenBluetoothSettings={() => void openSettings("bluetooth")} />
      <BrowserPlayer />
    </main>
  );
}

function searchDateBoundary(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  return `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
}

function optionalSearchNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function indexSearchResultToFileEntry(result: IndexSearchResult): FileEntry {
  return {
    name: result.name,
    path: result.path,
    kind: "file",
    sizeBytes: result.sizeBytes,
    modifiedAt: new Date(result.mtimeMs).toISOString(),
    isSafe: true,
    ...(result.mimeType ? { mimeType: result.mimeType } : {})
  };
}

function optionalProperty<Key extends string, Value>(key: Key, value: Value | undefined): { [Property in Key]?: Value } {
  return value === undefined ? {} : { [key]: value } as { [Property in Key]?: Value };
}

function renamedPath(candidatePath: string, sourcePath: string, targetPath: string): string | null {
  if (candidatePath === sourcePath) {
    return targetPath;
  }
  if (candidatePath.startsWith(`${sourcePath}/`)) {
    return `${targetPath}${candidatePath.slice(sourcePath.length)}`;
  }
  return null;
}

function sessionWorkspacePath(storagePoolId: string, relativePath: string): string {
  if (!storagePoolId) return ".";
  return joinNasPath(storagePoolId, relativePath);
}

export function isPathWithinStoragePool(pathname: string, poolPath: string): boolean {
  const normalizedPath = pathname.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (normalizedPath.split("/").some((segment) => segment === ".." || segment.length === 0)) {
    return false;
  }
  if (!normalizedPath || normalizedPath === ".") {
    return poolPath === ".";
  }
  if (normalizedPath.startsWith("/")) {
    return false;
  }

  const normalizedPoolPath = poolPath.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/u, "");
  if (!normalizedPoolPath || normalizedPoolPath === ".") {
    return true;
  }

  return normalizedPath === normalizedPoolPath || normalizedPath.startsWith(`${normalizedPoolPath}/`);
}
