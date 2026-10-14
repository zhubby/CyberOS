import { FormEvent, KeyboardEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CircleAlert, CircleCheck, MessageSquare, PanelRight, X } from "lucide-react";
import {
  applyFileMutation,
  approveRequest,
  cancelJob,
  createFileBatch,
  createSession,
  deleteSession,
  extractFile,
  getApprovals,
  getBuildInfo,
  getDockerOperations,
  getVmOperations,
  getDockerSettings,
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
  getRoots,
  getSessions,
  getSystemInfo,
  getSystemStorage,
  getTextPreview,
  getTranscript,
  getModelProviderSettings,
  getNotifications,
  getPiToolPolicySettings,
  getPhotoLibrarySettings,
  getPhotoProcessingSettings,
  getPhotoStatus,
  rejectRequest,
  requestSystemPower,
  markAllNotificationsRead,
  markNotificationRead,
  rollbackOperation,
  requestReindex,
  saveDockerSettings,
  saveModelProviderSettings,
  savePiToolPolicySettings,
  searchIndex,
  sendMessage,
  sendVodPlayerCommand,
  updateSessionPath,
  updateDownloadSettings,
  updateIndexerSettings,
  updatePhotoProcessingSettings,
  uploadFile,
  type AgentEvent,
  type BuildInfo,
  type FileEntry,
  type FileBatch,
  type FileMeta,
  type FileOperation,
  type DockerOperation,
  type VmOperation,
  type DockerSettings,
  type DownloadSettings,
  type IndexerOverview,
  type IndexerSettings,
  type IndexSearchRequest,
  type IndexSearchResult,
  type SaveEditableTextResult,
  type FileListing,
  type ModelProviderSettings,
  type NasRoot,
  type OperationNotification,
  type PendingApproval,
  type PhotoLibrarySettings,
  type PhotoLibraryStatus,
  type PhotoProcessingSettings,
  type PhotoWorkerHealth,
  type PiToolPolicySettings,
  type Session,
  type SessionSummary,
  type SystemInfo,
  type SystemPowerAction,
  type StorageSummary,
  type TextPreview,
  type TranscriptMessage,
  type VodPlayerCommand,
  type VodPlayerStatus
} from "./api.js";
import { ChatPane, composeAgentMessage } from "./components/chat/ChatPane.js";
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
  modelSettingsToForm,
  type DockerSettingsFormState,
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
import { clampSplitWidth, readStoredSplitWidth, writeStoredSplitWidth } from "./lib/layout.js";
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
import {
  readStoredThemePreference,
  readSystemTheme,
  resolveThemePreference,
  writeStoredThemePreference,
  type ResolvedTheme,
  type ThemePreference
} from "./lib/theme-settings.js";
import { loadFileListingForView, syncSessionPath } from "./lib/session.js";
import { readStoredStoragePoolId, writeStoredStoragePoolId } from "./lib/storage-pool-settings.js";
import { scheduleToastDismissal } from "./lib/toast.js";
import { acceptVodPlayerStatus } from "./lib/vod-player-status.js";

type MobileView = "chat" | "workspace";
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

export function App() {
  const { t } = useTranslation();
  const [roots, setRoots] = useState<NasRoot[]>([]);
  const [selectedRootId, setSelectedRootId] = useState("");
  const [selectedStoragePoolId, setSelectedStoragePoolId] = useState("");
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null);
  const [storageSummaryLoading, setStorageSummaryLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [operations, setOperations] = useState<FileOperation[]>([]);
  const [fileBatches, setFileBatches] = useState<FileBatch[]>([]);
  const [dockerOperations, setDockerOperations] = useState<DockerOperation[]>([]);
  const [vmOperations, setVmOperations] = useState<VmOperation[]>([]);
  const [operationsReady, setOperationsReady] = useState(false);
  const [uploadBatches, setUploadBatches] = useState<UploadBatchState[]>([]);
  const [currentPath, setCurrentPath] = useState(".");
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
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOptions, setSearchOptions] = useState<WorkspaceSearchOptions>(() => defaultWorkspaceSearchOptions());
  const [searchResults, setSearchResults] = useState<IndexSearchResult[] | null>(null);
  const [searchNextCursor, setSearchNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [warningNotice, setWarningNotice] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<OperationNotification[]>([]);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
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
  const [toolPolicySettings, setToolPolicySettings] = useState<PiToolPolicySettings | null>(null);
  const [dockerSettings, setDockerSettings] = useState<DockerSettings | null>(null);
  const [downloadSettings, setDownloadSettings] = useState<DownloadSettings | null>(null);
  const [indexerSettings, setIndexerSettings] = useState<IndexerSettings | null>(null);
  const [indexerStatus, setIndexerStatus] = useState<IndexerOverview | null>(null);
  const [photoSettings, setPhotoSettings] = useState<PhotoLibrarySettings | null>(null);
  const [photoStatus, setPhotoStatus] = useState<PhotoLibraryStatus | null>(null);
  const [photoProcessingSettings, setPhotoProcessingSettings] = useState<PhotoProcessingSettings | null>(null);
  const [photoWorkerHealth, setPhotoWorkerHealth] = useState<PhotoWorkerHealth | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemInfoError, setSystemInfoError] = useState<string | null>(null);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [buildInfoError, setBuildInfoError] = useState<string | null>(null);
  const [modelSettingsForm, setModelSettingsForm] = useState<ModelProviderFormState>(() =>
    modelSettingsToForm(null)
  );
  const [toolPolicyForm, setToolPolicyForm] = useState<ToolPolicyFormState>(() => defaultToolPolicyForm());
  const [dockerSettingsForm, setDockerSettingsForm] = useState<DockerSettingsFormState>(() =>
    dockerSettingsToForm(null)
  );
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(() => readStoredLanguagePreference());
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readStoredThemePreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemTheme());
  const [previewFileSizeLimitBytes, setPreviewFileSizeLimitBytes] = useState(() =>
    readStoredPreviewFileSizeLimitBytes()
  );
  const [codeFontSettings, setCodeFontSettings] = useState<CodeFontSettings>(() => readStoredCodeFontSettings());
  const seenEvents = useRef(new Set<number>());
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileListingRequestId = useRef(0);
  const sessionViewRequestId = useRef(0);
  const activeSearchQueryRef = useRef("");
  const currentPathRef = useRef(currentPath);
  const selectedRootIdRef = useRef(selectedRootId);
  const selectedStoragePoolIdRef = useRef(selectedStoragePoolId);
  const uploadBatchSequenceRef = useRef(0);
  const uploadAbortControllersRef = useRef(new Map<string, Set<AbortController>>());
  const cancelledUploadBatchesRef = useRef(new Set<string>());
  const preferredStoragePoolIdRef = useRef(readStoredStoragePoolId());
  const pendingDownloadedDirectoryRef = useRef<{
    rootId: string;
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

  const selectedRoot = roots.find((root) => root.id === selectedRootId);
  const storagePoolOptions = useMemo(() => {
    const options = new Map<string, {
      id: string;
      rootId: string;
      name: string;
      path: string;
      filesystem: string | null;
      status: "ready" | "warning" | "offline" | "unknown";
    }>();
    for (const root of roots) {
      for (const pool of storageSummary?.pools ?? []) {
        if (pool.status === "offline" || options.has(pool.id)) {
          continue;
        }
        const poolPath = relativeStoragePoolPath(root.path, pool.mountpoint);
        if (!poolPath) {
          continue;
        }
        options.set(pool.id, {
          id: pool.id,
          rootId: root.id,
          name: pool.mountpoint?.split("/").filter(Boolean).at(-1) ?? pool.name,
          path: poolPath,
          filesystem: pool.filesystem,
          status: pool.status
        });
      }
    }
    return [...options.values()];
  }, [roots, storageSummary]);
  const selectedStoragePool = useMemo(
    () => storagePoolOptions.find((pool) => pool.id === selectedStoragePoolId),
    [selectedStoragePoolId, storagePoolOptions]
  );
  const activeSessionSummary = sessions.find((item) => item.id === activeSessionId);
  const activeApprovals = approvals.filter((approval) => {
    if (!session || approval.sessionId !== session.id) {
      return false;
    }
    return approval.proposal.every((proposal) => {
      if (!("storagePoolId" in proposal)) {
        return true;
      }
      return proposal.storagePoolId === selectedStoragePoolId;
    });
  });
  const visibleUploadBatches = useMemo(
    () => uploadBatches.filter((batch) => batch.storagePoolId === selectedStoragePoolId),
    [selectedStoragePoolId, uploadBatches]
  );
  const blobUrl = selectedRootId && selectedStoragePoolId && selectedFilePath
    ? getFileBlobUrl(selectedRootId, selectedFilePath, selectedStoragePoolId)
    : "";
  const videoUrl = selectedRootId && selectedStoragePoolId && selectedFilePath
    ? getFileVideoUrl(selectedRootId, selectedFilePath, selectedStoragePoolId)
    : "";
  const resolvedLocale = resolveSupportedLocale(i18n.resolvedLanguage ?? i18n.language);
  const resolvedTheme = resolveThemePreference(themePreference, systemTheme);
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
    Promise.allSettled([getRoots(), getSystemStorage()]).then(([rootsResult, storageResult]) => {
      if (!active) {
        return;
      }
      if (rootsResult.status === "fulfilled") {
        setRoots(rootsResult.value);
        setSelectedRootId(rootsResult.value[0]?.id ?? "");
      } else {
        setError(toErrorMessage(rootsResult.reason));
        setStatus("offline");
      }
      if (storageResult.status === "fulfilled") {
        setStorageSummary(storageResult.value);
      } else {
        setError(toErrorMessage(storageResult.reason));
      }
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
    if (!selectedRootId) {
      return;
    }

    let active = true;
    const rootId = selectedRootId;
    const sessionRequestId = beginSessionViewRequest();
    async function loadRootWorkspace() {
      setStatus("loading");
      setError(null);
      const nextSessions = await getSessions(rootId);
      let nextSession: Session | SessionSummary | null = nextSessions[0] ?? null;
      let nextSessionList = nextSessions;

      if (!nextSession) {
        nextSession = await createSession(rootId, ".");
        nextSessionList = await getSessions(rootId);
      }

      const nextTranscript = await getTranscript(nextSession.id);

      if (!active || !isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }

      seenEvents.current.clear();
      setSessions(nextSessionList);
      setSession(nextSession);
      setActiveSessionId(nextSession.id);
      setTranscript(nextTranscript);
      setComposerPath(null);
      setStatus("ready");
      void refreshWorkQueues();
    }

    loadRootWorkspace().catch((nextError: unknown) => {
      if (!active) {
        return;
      }
      setError(toErrorMessage(nextError));
      setStatus("error");
    });

    return () => {
      active = false;
    };
  }, [selectedRootId]);

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
    const fileRequestId = beginFileListingRequest();
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

    getFiles(pool.rootId, pool.path, pool.id)
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

    const source = new EventSource(`/api/sessions/${session.id}/events`);
    const handleEvent = (raw: MessageEvent<string>) => {
      const parsed = JSON.parse(raw.data) as AgentEvent;
      if (seenEvents.current.has(parsed.id)) {
        return;
      }
      seenEvents.current.add(parsed.id);

      if (parsed.audience === "notification") {
        if (notificationRefreshTimerRef.current) clearTimeout(notificationRefreshTimerRef.current);
        notificationRefreshTimerRef.current = setTimeout(() => {
          notificationRefreshTimerRef.current = null;
          const fileBatchId = typeof parsed.payload.fileBatchId === "string" ? parsed.payload.fileBatchId : null;
          if (fileBatchId) {
            void refreshFileBatches();
            if (
              (parsed.type === "job.completed" || parsed.type === "job.failed" || parsed.type === "job.cancelled")
              && parsed.payload.rootId === selectedRootIdRef.current
              && parsed.payload.storagePoolId === selectedStoragePoolIdRef.current
            ) {
              void Promise.all([refreshWorkQueues(), refreshCurrentFileListing()]);
            }
          } else {
            void refreshWorkQueues();
          }
        }, 100);
        return;
      }

      const transcriptMessage = eventToTranscriptMessage(parsed);
      if (transcriptMessage) {
        setTranscript((current) =>
          current.some((item) => item.id === transcriptMessage.id) ? current : [...current, transcriptMessage]
        );
      }

      if (parsed.type === "job.running") {
        setStatus("agent-running");
      }
      const eventJobId = getEventJobId(parsed);
      if (parsed.type === "job.completed") {
        setStatus("ready");
        setActiveJobId((current) => (!eventJobId || current === eventJobId ? null : current));
        void refreshWorkQueues();
        void reloadSessions();
      }
      if (parsed.type === "job.failed") {
        setStatus("error");
        setActiveJobId((current) => (!eventJobId || current === eventJobId ? null : current));
      }
      if (parsed.type === "job.cancelled") {
        setStatus("cancelled");
        setActiveJobId((current) => (!eventJobId || current === eventJobId ? null : current));
      }
      if (parsed.type === "approval.pending") {
        void refreshWorkQueues();
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
      "approval.pending",
      "job.running",
      "job.completed",
      "job.failed",
      "job.cancelled"
    ];
    for (const eventType of eventTypes) {
      source.addEventListener(eventType, handleEvent);
    }
    source.onerror = () => {
      setStatus("reconnecting");
    };

    return () => {
      source.close();
      if (notificationRefreshTimerRef.current) {
        clearTimeout(notificationRefreshTimerRef.current);
        notificationRefreshTimerRef.current = null;
      }
    };
  }, [session]);

  useEffect(() => {
    void refreshWorkQueues();
  }, [selectedStoragePoolId, session?.id]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [activeApprovals.length, transcript.length]);

  useEffect(() => {
    if (!selectedRootId || !selectedStoragePoolId || !selectedFilePath) {
      setPreviewMeta(null);
      setTextPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    let active = true;
    const rootId = selectedRootId;
    const storagePoolId = selectedStoragePoolId;
    const filePath = selectedFilePath;
    async function loadPreview() {
      setPreviewLoading(true);
      setPreviewError(null);
      setTextPreview(null);
      const meta = await getFileMeta(rootId, filePath, storagePoolId);
      const withinPreviewLimit = !isPreviewOverFileSizeLimit(meta, previewFileSizeLimitBytes);
      const nextTextPreview =
        meta.previewKind === "text" && withinPreviewLimit
          ? await getTextPreview(rootId, filePath, storagePoolId)
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
  }, [previewFileSizeLimitBytes, selectedRootId, selectedStoragePoolId, selectedFilePath]);

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
    selectedRootIdRef.current = selectedRootId;
  }, [selectedRootId]);

  useEffect(() => {
    selectedStoragePoolIdRef.current = selectedStoragePoolId;
  }, [selectedStoragePoolId]);

  useEffect(() => {
    const pending = pendingDownloadedDirectoryRef.current;
    if (!pending || pending.rootId !== selectedRootId || pending.storagePoolId !== selectedStoragePoolId) {
      return;
    }
    pendingDownloadedDirectoryRef.current = null;
    void openDirectory(pending.path);
  }, [selectedRootId, selectedStoragePoolId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function" || themePreference !== "system") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const syncSystemTheme = () => setSystemTheme(media.matches ? "light" : "dark");
    syncSystemTheme();
    media.addEventListener("change", syncSystemTheme);
    return () => media.removeEventListener("change", syncSystemTheme);
  }, [themePreference]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themePreference = themePreference;
    return () => {
      delete document.documentElement.dataset.theme;
      delete document.documentElement.dataset.themePreference;
    };
  }, [resolvedTheme, themePreference]);

  useEffect(() => {
    return () => {
      uploadAbortControllersRef.current.forEach((controllers) => {
        controllers.forEach((controller) => controller.abort());
      });
      uploadAbortControllersRef.current.clear();
      cancelledUploadBatchesRef.current.clear();
    };
  }, []);

  async function reloadSessions(expectedRootId = selectedRootIdRef.current): Promise<boolean> {
    if (!expectedRootId || selectedRootIdRef.current !== expectedRootId) {
      return false;
    }
    const nextSessions = await getSessions(expectedRootId);
    if (selectedRootIdRef.current !== expectedRootId) {
      return false;
    }
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
      const result = await getNotifications();
      setNotifications(result.notifications);
      setNotificationUnreadCount(result.unreadCount);
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
      setNotificationUnreadCount(result.unreadCount);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
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

  function openNotificationCenter() {
    setNotificationCenterOpen(true);
    void refreshNotifications(true);
  }

  async function openSettings() {
    setSettingsOpen(true);
    setActiveSettingsSection("overview");
    setSettingsLoading(true);
    setError(null);
    setSystemInfoError(null);
    setBuildInfoError(null);
    try {
      const [
        settingsResult,
        toolPolicyResult,
        dockerSettingsResult,
        downloadSettingsResult,
        indexerSettingsResult,
        indexerStatusResult,
        photoSettingsResult,
        photoProcessingSettingsResult,
        photoStatusResult,
        systemInfoResult,
        buildInfoResult
      ] = await Promise.allSettled([
        getModelProviderSettings(),
        getPiToolPolicySettings(),
        getDockerSettings(),
        getDownloadSettings(),
        getIndexerSettings(),
        getIndexerOverview(),
        getPhotoLibrarySettings(),
        getPhotoProcessingSettings(),
        getPhotoStatus(),
        getSystemInfo(),
        getBuildInfo()
      ]);

      const errors: string[] = [];
      if (settingsResult.status === "fulfilled") {
        setModelSettings(settingsResult.value);
        setModelSettingsForm(modelSettingsToForm(settingsResult.value));
      } else {
        errors.push(toErrorMessage(settingsResult.reason));
      }

      if (toolPolicyResult.status === "fulfilled") {
        setToolPolicySettings(toolPolicyResult.value);
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
        setPhotoWorkerHealth(photoStatusResult.value.workerHealth);
      } else {
        setPhotoStatus(null);
        setPhotoWorkerHealth(null);
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
      const [settings, toolPolicy, nextDockerSettings] = await Promise.all([
        saveModelProviderSettings({
          providerName: modelSettingsForm.providerName,
          baseUrl: modelSettingsForm.baseUrl || null,
          model: modelSettingsForm.model,
          ...(modelSettingsForm.apiKey ? { apiKey: modelSettingsForm.apiKey } : {}),
          clearApiKey: modelSettingsForm.clearApiKey
        }),
        savePiToolPolicySettings(toolPolicyForm),
        saveDockerSettings({
          enabled: dockerSettingsForm.enabled,
          socketPath: dockerSettingsForm.socketPath,
          composeCommand: dockerSettingsForm.composeCommand,
          operationTimeoutMs: Number(dockerSettingsForm.operationTimeoutMs),
          consoleShells: parseDockerShells(dockerSettingsForm.consoleShells)
        })
      ]);
      setModelSettings(settings);
      setToolPolicySettings(toolPolicy);
      setDockerSettings(nextDockerSettings);
      setModelSettingsForm(modelSettingsToForm(settings));
      setToolPolicyForm(toolPolicy);
      setDockerSettingsForm(dockerSettingsToForm(nextDockerSettings));
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

  async function changeIndexerSettings(patch: Partial<Omit<IndexerSettings, "updatedAt">>) {
    setError(null);
    try {
      setIndexerSettings(await updateIndexerSettings(patch));
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      throw nextError;
    }
  }

  async function reindexRoot(rootId: string) {
    setError(null);
    try {
      await requestReindex({ rootId, path: ".", recursive: true });
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

  async function selectSession(nextSession: SessionSummary) {
    if (nextSession.id === activeSessionId) {
      return;
    }

    const sessionRequestId = beginSessionViewRequest();
    try {
      setStatus("loading");
      setError(null);
      seenEvents.current.clear();
      setSession(nextSession);
      setActiveSessionId(nextSession.id);
      setComposerPath(null);
      const nextTranscript = await getTranscript(nextSession.id);
      if (!isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }
      setTranscript(nextTranscript);
      setStatus("ready");
    } catch (nextError) {
      if (!isCurrentSessionViewRequest(sessionRequestId)) {
        return;
      }
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }

  async function createAgent() {
    if (!selectedRootId) {
      return;
    }
    const sessionRequestId = beginSessionViewRequest();
    setStatus("creating-agent");
    setError(null);
    const nextSession = await createSession(selectedRootId, currentPath);
    const [nextSessions, nextTranscript] = await Promise.all([
      getSessions(selectedRootId),
      getTranscript(nextSession.id)
    ]);
    if (!isCurrentSessionViewRequest(sessionRequestId)) {
      return;
    }
    setSessions(nextSessions);
    seenEvents.current.clear();
    setSession(nextSession);
    setActiveSessionId(nextSession.id);
    setComposerPath(null);
    setTranscript(nextTranscript);
    setStatus("ready");
    setMobileView("chat");
  }

  async function loadSessionIntoView(nextSession: Session | SessionSummary): Promise<void> {
    const sessionRequestId = beginSessionViewRequest();
    seenEvents.current.clear();
    setSession(nextSession);
    setActiveSessionId(nextSession.id);
    const nextTranscript = await getTranscript(nextSession.id);
    if (!isCurrentSessionViewRequest(sessionRequestId)) {
      return;
    }
    setTranscript(nextTranscript);
    setComposerPath(null);
  }

  async function deleteActiveSession() {
    if (!activeSessionId || !selectedRootId) {
      return;
    }

    setStatus("loading");
    setError(null);
    try {
      await deleteSession(activeSessionId);
      const remainingSessions = await getSessions(selectedRootId);
      const nextSession = remainingSessions[0] ?? (await createSession(selectedRootId, "."));
      const nextSessions = remainingSessions.length ? remainingSessions : await getSessions(selectedRootId);
      setSessions(nextSessions);
      setActiveJobId(null);
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

  async function refreshFiles() {
    if (!selectedRootId || !selectedStoragePoolId) {
      return;
    }
    const requestRootId = selectedRootId;
    const requestStoragePoolId = selectedStoragePoolId;
    setStatus(activeSearchQueryRef.current ? "searching" : "loading");
    try {
      const committed = await refreshCurrentFileListing();
      if (committed && selectedRootIdRef.current === requestRootId && selectedStoragePoolIdRef.current === requestStoragePoolId) {
        setStatus("ready");
      }
    } catch (nextError) {
      if (selectedRootIdRef.current !== requestRootId || selectedStoragePoolIdRef.current !== requestStoragePoolId) {
        return;
      }
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }

  async function refreshCurrentFileListing(query = activeSearchQueryRef.current): Promise<boolean> {
    if (!selectedRootId || !selectedStoragePoolId) {
      return false;
    }
    if (query) {
      return executeAdvancedSearch(undefined, null, false);
    }
    const fileRequestId = beginFileListingRequest();
    const listing = await loadFileListingForView(selectedRootId, currentPath, query, selectedStoragePoolId);
    return commitFileListing(fileRequestId, listing);
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await executeAdvancedSearch();
  }

  async function executeAdvancedSearch(
    options = searchOptions,
    cursor: string | null = null,
    append = false
  ): Promise<boolean> {
    const query = searchQuery.trim();
    const hasFilters = hasWorkspaceSearchFilters(options);
    if (!selectedRootId || !selectedStoragePoolId) return false;
    if (!query && !hasFilters) {
      activeSearchQueryRef.current = "";
      setSearchResults(null);
      setSearchNextCursor(null);
      await refreshFiles();
      return true;
    }

    setStatus("searching");
    activeSearchQueryRef.current = query || "__filters__";
    const fileRequestId = beginFileListingRequest();
    try {
      const request: IndexSearchRequest = {
        rootId: selectedRootId,
        storagePoolId: selectedStoragePoolId,
        path: currentPath,
        sort: options.sort,
        cursor,
        limit: 50,
        ...(query ? { query } : {}),
        ...(options.categories.length ? { categories: options.categories } : {}),
        ...(options.extractionSources.length ? { extractionSources: options.extractionSources } : {}),
        ...(options.extractionStatuses.length ? { extractionStatuses: options.extractionStatuses } : {}),
        ...optionalProperty("mimeTypes", splitSearchValues(options.mimeTypes)),
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
    if (!selectedRootId || !selectedStoragePool) {
      return;
    }
    const requestRootId = selectedRootId;
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
    const fileRequestId = beginFileListingRequest();
    try {
      const nextListing = await getFiles(selectedRootId, pathname, selectedStoragePool.id);
      if (
        !isCurrentFileListingRequest(fileRequestId) ||
        selectedRootIdRef.current !== requestRootId ||
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      commitFileListing(fileRequestId, nextListing);
      setCurrentPath(pathname);
      const updatedSession =
        session && session.rootId === requestRootId ? await updateSessionPath(session.id, pathname) : null;
      if (
        !isCurrentFileListingRequest(fileRequestId) ||
        selectedRootIdRef.current !== requestRootId ||
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      if (updatedSession) {
        setSession((current) => (current?.id === updatedSession.id ? updatedSession : current));
      }
      if (!(await reloadSessions(requestRootId))) {
        return;
      }
      setStatus("ready");
    } catch (nextError) {
      if (
        !isCurrentFileListingRequest(fileRequestId) ||
        selectedRootIdRef.current !== requestRootId ||
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      setError(toErrorMessage(nextError));
      setStatus("error");
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typedContent = message.trim();
    const attachedPath = composerPath;
    const content = composeAgentMessage(typedContent, attachedPath);
    if (!session || !content || messageSubmitting) {
      return;
    }

    const now = new Date().toISOString();
    const optimisticMessage = {
      id: `local:${now}`,
      role: "user" as const,
      content,
      createdAt: now
    };

    setMessageSubmitting(true);
    setMessage("");
    setComposerPath(null);
    setError(null);
    setTranscript((current) => [...current, optimisticMessage]);
    setStatus("queued");
    try {
      const syncedSession = await syncSessionPath(session, currentPath);
      setSession((current) => (current?.id === syncedSession.id ? syncedSession : current));
      const job = await sendMessage(syncedSession.id, content);
      setActiveJobId(job.id);
      void reloadSessions();
    } catch (nextError) {
      setTranscript((current) => current.filter((item) => item.id !== optimisticMessage.id));
      setMessage((current) => (current.length > 0 ? current : typedContent));
      setComposerPath((current) => current ?? attachedPath);
      setError(toErrorMessage(nextError));
      setStatus("error");
    } finally {
      setMessageSubmitting(false);
    }
  }

  async function cancelActiveJob() {
    if (!activeJobId) {
      return;
    }

    await cancelJob(activeJobId);
    setStatus("cancelling");
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
    const rootId = selectedRootIdRef.current;
    const storagePoolId = selectedStoragePoolIdRef.current;
    if (!rootId || !storagePoolId || !sources.length || !selectedStoragePool) {
      return;
    }

    const batchId = nextUploadBatchId();
    const uploadBatch = createUploadBatch({
      id: batchId,
      rootId,
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
            rootId,
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
        if (selectedRootIdRef.current === rootId && currentPathRef.current === uploadBatch.targetPath && !activeSearchQueryRef.current) {
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

  async function refreshWorkQueues() {
    const queueSessionId = session?.id ?? null;
    const queueStoragePoolId = selectedStoragePoolIdRef.current;
    try {
      const [nextApprovals, nextOperations, nextFileBatches, nextDockerOperations, nextVmOperations, nextNotifications] = await Promise.all([
        getApprovals(),
        getOperations(),
        getFileBatches({ sessionId: queueSessionId, rootId: selectedRootIdRef.current, storagePoolId: queueStoragePoolId }),
        getDockerOperations(queueSessionId),
        getVmOperations(queueSessionId),
        getNotifications()
      ]);
      if (queueSessionId !== (session?.id ?? null) || queueStoragePoolId !== selectedStoragePoolIdRef.current) {
        return;
      }
      setApprovals(nextApprovals);
      setOperations(
        queueStoragePoolId
          ? nextOperations.filter((operation) => operation.metadata.storagePoolId === queueStoragePoolId)
          : []
      );
      setFileBatches(nextFileBatches);
      setDockerOperations(nextDockerOperations);
      setVmOperations(nextVmOperations);
      setNotifications(nextNotifications.notifications);
      setNotificationUnreadCount(nextNotifications.unreadCount);
      setNotificationsLoading(false);
      setOperationsReady(true);
    } catch (nextError) {
      if (queueSessionId !== (session?.id ?? null) || queueStoragePoolId !== selectedStoragePoolIdRef.current) {
        return;
      }
      setError(toErrorMessage(nextError));
    }
  }

  async function refreshFileBatches() {
    const queueSessionId = session?.id ?? null;
    const queueRootId = selectedRootIdRef.current;
    const queueStoragePoolId = selectedStoragePoolIdRef.current;
    if (!queueSessionId || !queueRootId || !queueStoragePoolId) {
      setFileBatches([]);
      return;
    }
    try {
      const batches = await getFileBatches({
        sessionId: queueSessionId,
        rootId: queueRootId,
        storagePoolId: queueStoragePoolId
      });
      if (
        queueSessionId === (session?.id ?? null)
        && queueRootId === selectedRootIdRef.current
        && queueStoragePoolId === selectedStoragePoolIdRef.current
      ) {
        setFileBatches(batches);
      }
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function handleApprove(approvalId: string) {
    const approval = approvals.find((item) => item.id === approvalId);
    const requestRootId = selectedRootIdRef.current;
    const requestStoragePoolId = selectedStoragePoolIdRef.current;
    setStatus("applying");
    try {
      await approveRequest(approvalId);
      if (
        selectedRootIdRef.current !== requestRootId ||
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
      applyApprovedSelectionChange(approval);
      await Promise.all([refreshWorkQueues(), refreshFiles()]);
      setSuccessNotice(t("notifications.operationSucceeded"));
      setStatus("ready");
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      await refreshWorkQueues();
      setStatus("error");
    }
  }

  async function handleReject(approvalId: string) {
    setStatus("rejecting");
    try {
      await rejectRequest(approvalId);
      await refreshWorkQueues();
      setWarningNotice(t("notifications.operationRejected"));
      setStatus("ready");
    } catch (nextError) {
      setError(toErrorMessage(nextError));
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

  function changeThemePreference(preference: ThemePreference) {
    writeStoredThemePreference(preference);
    setSystemTheme(readSystemTheme());
    setThemePreference(preference);
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
      result.operation.metadata.rootId &&
      result.operation.metadata.rootId !== selectedRootIdRef.current
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
    if (!session || !selectedRootId || !selectedStoragePoolId) {
      throw new Error(t("workspace.actions.noSession"));
    }

    const requestRootId = selectedRootId;
    const requestStoragePoolId = selectedStoragePoolId;
    setStatus("applying");
    setError(null);
    try {
      const result = await applyFileMutation({
        sessionId: session.id,
        rootId: requestRootId,
        storagePoolId: requestStoragePoolId,
        operation: "rename",
        sourcePath: entry.path,
        targetName
      });
      if (
        selectedRootIdRef.current !== requestRootId ||
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
    if (!session || !selectedRootId || !selectedStoragePool) {
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

    const requestRootId = selectedRootId;
    const requestStoragePoolId = selectedStoragePool.id;
    setStatus("applying");
    setError(null);
    try {
      const result = await applyFileMutation({
        sessionId: session.id,
        rootId: requestRootId,
        storagePoolId: requestStoragePoolId,
        operation: "copy",
        sourcePath: entry.path,
        targetPath: joinNasPath(selectedStoragePool.path, targetPath)
      });
      if (
        selectedRootIdRef.current !== requestRootId ||
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
    if (!session || !selectedRootId || !selectedStoragePoolId) {
      throw new Error(t("workspace.actions.noSession"));
    }
    setStatus("queued");
    setError(null);
    try {
      await createFileBatch({
        sessionId: session.id,
        rootId: selectedRootId,
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

  async function cancelFileBatch(jobId: string) {
    try {
      await cancelJob(jobId);
      await refreshWorkQueues();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function requestFileExtract(meta: FileMeta) {
    if (!selectedRootId || !selectedStoragePoolId) {
      throw new Error(t("workspace.actions.noSession"));
    }
    const requestRootId = selectedRootId;
    const requestStoragePoolId = selectedStoragePoolId;

    setStatus("applying");
    setError(null);
    try {
      const result = await extractFile({
        rootId: selectedRootId,
        storagePoolId: selectedStoragePoolId,
        path: meta.path
      });
      if (
        selectedRootIdRef.current !== requestRootId ||
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
        selectedRootIdRef.current !== requestRootId ||
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
    rootId: string;
    storagePoolId: string;
    parentPath: string;
    name: string;
  }) {
    if (!session) {
      throw new Error(t("workspace.actions.noSession"));
    }

    setStatus("applying");
    setError(null);
    try {
      const result = await applyFileMutation({
        sessionId: session.id,
        rootId: input.rootId,
        storagePoolId: input.storagePoolId,
        operation: "mkdir",
        targetPath: joinNasPath(input.parentPath, input.name)
      });
      const refreshes: Promise<unknown>[] = [refreshWorkQueues()];
      if (
        selectedRootIdRef.current === input.rootId &&
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
    if (!session || !selectedRootId || !selectedStoragePool) {
      throw new Error(t("workspace.actions.noSession"));
    }

    await requestFolderCreateAt({
        rootId: selectedRootId,
        storagePoolId: selectedStoragePool.id,
        parentPath: currentPath,
        name: folderName
      });
  }

  function applyApprovedSelectionChange(approval: PendingApproval | undefined) {
    if (!approval || !selectedFilePath) {
      return;
    }

    for (const proposal of approval.proposal) {
      if (!("operation" in proposal)) {
        continue;
      }
      if (proposal.operation === "trash" && proposal.sourcePath && pathContains(proposal.sourcePath, selectedFilePath)) {
        setSelectedFilePath(null);
        setPreviewMeta(null);
        setTextPreview(null);
        setPreviewError(null);
        return;
      }
      if (proposal.operation === "rename" && proposal.sourcePath && proposal.targetPath) {
        const renamedSelection = renamedPath(selectedFilePath, proposal.sourcePath, proposal.targetPath);
        if (renamedSelection) {
          setSelectedFilePath(renamedSelection);
          return;
        }
      }
    }
  }

  function selectStoragePool(poolId: string) {
    const pool = storagePoolOptions.find((item) => item.id === poolId);
    if (!pool) {
      return;
    }

    preferredStoragePoolIdRef.current = pool.id;
    writeStoredStoragePoolId(pool.id);

    beginFileListingRequest();
    selectedRootIdRef.current = pool.rootId;
    selectedStoragePoolIdRef.current = pool.id;
    currentPathRef.current = pool.path;
    if (pool.rootId !== selectedRootId) {
      beginSessionViewRequest();
      seenEvents.current.clear();
      setSessions([]);
      setSession(null);
      setActiveSessionId("");
      setTranscript([]);
      setActiveJobId(null);
    }
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
    setSelectedRootId(pool.rootId);
    setCurrentPath(pool.path);
  }

  function openDownloadedDirectory(rootId: string, storagePoolId: string, pathname: string) {
    setMobileView("workspace");
    if (selectedRootIdRef.current !== rootId || selectedStoragePoolIdRef.current !== storagePoolId) {
      pendingDownloadedDirectoryRef.current = { rootId, storagePoolId, path: pathname };
      selectStoragePool(storagePoolId);
      return;
    }
    void openDirectory(pathname);
  }

  function beginFileListingRequest(): number {
    fileListingRequestId.current += 1;
    return fileListingRequestId.current;
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

  async function playSelectedOnVodPlayer() {
    if (!selectedRootId || !selectedStoragePoolId || !selectedFilePath || previewMeta?.previewKind !== "video") {
      return;
    }
    setVodPlayerBusy(true);
    try {
      const next = await sendVodPlayerCommand({
          type: "play",
          rootId: selectedRootId,
          storagePoolId: selectedStoragePoolId,
          path: selectedFilePath
        });
      setVodPlayerStatus((current) => acceptVodPlayerStatus(current, next));
    } catch (nextError) {
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
      rootId: selectedRootId || current?.rootId || null,
      storagePoolId: selectedStoragePoolId || current?.storagePoolId || null,
      relativePath: selectedFilePath || current?.relativePath || null,
      fileName: previewMeta?.name || current?.fileName || selectedFilePath?.split("/").pop() || null,
      positionSeconds: current?.positionSeconds ?? 0,
      durationSeconds: current?.durationSeconds ?? null,
      volume: current?.volume ?? 100,
      retryCount: current?.retryCount ?? 0,
      nextRetryAt: null,
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
    if (!selectedRoot) {
      return;
    }
    setComposerPath(workspaceAbsolutePath(selectedRoot.path, relativePath));
    setMobileView("chat");
  }

  async function openWorkspacePath(pathname: string) {
    if (!selectedRootId || !selectedStoragePool) {
      setWarningNotice(t("workspace.selectStoragePoolBody"));
      return;
    }

    setMobileView("workspace");
    setFilesPanelActivationId((current) => current + 1);
    setStatus("loading");
    setError(null);
    setPreviewError(null);
    const requestRootId = selectedRootId;
    const requestStoragePoolId = selectedStoragePool.id;
    const hadActiveSearch = Boolean(activeSearchQueryRef.current);
    try {
      const linkedMeta = await getFileMeta(selectedRootId, pathname, selectedStoragePool.id);
      if (
        selectedRootIdRef.current !== requestRootId ||
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
          selectedRootIdRef.current !== requestRootId ||
          selectedStoragePoolIdRef.current !== requestStoragePoolId
        ) {
          return;
        }
      }
      setSelectedFilePath(linkedMeta.path);
      setStatus("ready");
    } catch (nextError) {
      if (
        selectedRootIdRef.current !== requestRootId ||
        selectedStoragePoolIdRef.current !== requestStoragePoolId
      ) {
        return;
      }
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
      className={`app-shell${resizing ? " is-resizing" : ""}`}
      data-theme={resolvedTheme}
      data-theme-preference={themePreference}
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
      </div>

      <ChatPane
        active={mobileView === "chat"}
        selectedRoot={selectedRoot}
        activeSessionSummary={activeSessionSummary}
        sessions={sessions}
        activeSessionId={activeSessionId}
        transcript={transcript}
        activeApprovals={activeApprovals}
        message={message}
        composerPath={composerPath}
        status={status}
        locale={resolvedLocale}
        modelSettings={modelSettings}
        activeJobId={activeJobId}
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
        onApprove={(approvalId) => void handleApprove(approvalId)}
        onReject={(approvalId) => void handleReject(approvalId)}
        onSubmitMessage={(event) => void submitMessage(event)}
        onMessageChange={setMessage}
        onClearComposerPath={() => setComposerPath(null)}
        onCancelActiveJob={() => void cancelActiveJob()}
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
        onPointerDown={startResize}
        onKeyDown={resizeWithKeyboard}
      />

      <WorkspacePane
        active={mobileView === "workspace"}
        roots={roots}
        selectedRoot={selectedRoot}
        selectedRootId={selectedRootId}
        storagePools={storagePoolOptions}
        storageSummaryLoading={storageSummaryLoading}
        selectedStoragePoolId={selectedStoragePoolId}
        currentPath={currentPath}
        breadcrumbs={breadcrumbs}
        entries={entries}
        fileListingLoading={
          storageSummaryLoading || status === "starting" || status === "loading" || status === "searching"
        }
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
        sessionId={session?.id ?? null}
        pendingApprovals={activeApprovals}
        locale={resolvedLocale}
        codeFontSettings={codeFontSettings}
        resolvedTheme={resolvedTheme}
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
        onCancelFileBatch={(jobId) => void cancelFileBatch(jobId)}
        onWorkQueuesChanged={() => {
          void refreshWorkQueues();
          void refreshStorageSummary();
        }}
        onNotifyError={setError}
        onNotifySuccess={setSuccessNotice}
        onNotifyWarning={setWarningNotice}
        onClosePreview={() => setSelectedFilePath(null)}
        onRollback={(operation) => void handleRollback(operation)}
      />

      <NotificationCenter
        open={notificationCenterOpen}
        loading={notificationsLoading}
        notifications={notifications}
        unreadCount={notificationUnreadCount}
        locale={resolvedLocale}
        onClose={closeNotificationCenter}
        onRead={(id) => void readNotification(id)}
        onReadAll={() => void readAllNotifications()}
      />

      {editorMeta ? (
        <FileEditorModal
          rootId={selectedRootId}
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
          form={modelSettingsForm}
          loading={settingsLoading}
          saving={settingsSaving}
          settings={modelSettings}
          dockerSettings={dockerSettings}
          downloadSettings={downloadSettings}
          indexerSettings={indexerSettings}
          indexerStatus={indexerStatus}
          roots={roots}
          photoSettings={photoSettings}
          photoStatus={photoStatus}
          photoProcessingSettings={photoProcessingSettings}
          photoWorkerHealth={photoWorkerHealth}
          dockerForm={dockerSettingsForm}
          systemInfo={systemInfo}
          systemInfoError={systemInfoError}
          buildInfo={buildInfo}
          buildInfoError={buildInfoError}
          pendingApprovals={approvals}
          operations={operations}
          operationsReady={operationsReady}
          toolPolicySettings={toolPolicySettings}
          toolPolicyForm={toolPolicyForm}
          languagePreference={languagePreference}
          themePreference={themePreference}
          resolvedTheme={resolvedTheme}
          previewFileSizeLimitBytes={previewFileSizeLimitBytes}
          codeFontSettings={codeFontSettings}
          splitWidth={splitWidth}
          resolvedLocale={resolvedLocale}
          onClose={() => setSettingsOpen(false)}
          onFormChange={setModelSettingsForm}
          onDockerFormChange={setDockerSettingsForm}
          onDownloadSettingsChange={changeDownloadSettings}
          onIndexerSettingsChange={changeIndexerSettings}
          onIndexerReindex={reindexRoot}
          onPhotoProcessingSettingsChange={changePhotoProcessingSettings}
          onToolPolicyFormChange={setToolPolicyForm}
          onLanguagePreferenceChange={changeLanguagePreference}
          onThemePreferenceChange={changeThemePreference}
          onPreviewFileSizeLimitChange={changePreviewFileSizeLimit}
          onCodeFontSettingsChange={changeCodeFontSettings}
          onSectionChange={setActiveSettingsSection}
          onSubmit={(event) => void saveSettings(event)}
        />
      ) : null}
    </main>
  );
}

function parseDockerShells(input: string): string[] {
  return input
    .split(/[\n,]/gu)
    .map((shell) => shell.trim())
    .filter(Boolean);
}

function splitSearchValues(input: string): string[] | undefined {
  const values = [...new Set(input.split(",").map((value) => value.trim()).filter(Boolean))];
  return values.length ? values : undefined;
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

function pathContains(containerPath: string, candidatePath: string): boolean {
  return candidatePath === containerPath || candidatePath.startsWith(`${containerPath}/`);
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

function relativeStoragePoolPath(rootPath: string, mountpoint: string | null): string | null {
  if (!mountpoint) {
    return null;
  }

  const normalize = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+/gu, "/").replace(/\/$/u, "");
    return normalized || "/";
  };
  const normalizedRoot = normalize(rootPath);
  const normalizedMountpoint = normalize(mountpoint);
  if (normalizedMountpoint === normalizedRoot) {
    return ".";
  }

  const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  if (!normalizedMountpoint.startsWith(prefix)) {
    return null;
  }

  const relativePath = normalizedMountpoint.slice(prefix.length).replace(/^\/+|\/+$/gu, "");
  if (!relativePath || relativePath.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return relativePath;
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
