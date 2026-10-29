import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  FileArchive,
  FileUp,
  FolderOpen,
  Link2,
  LoaderCircle,
  Magnet,
  Pause,
  Play,
  Plus,
  RotateCw,
  Square,
  Trash2,
  X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  actOnDownload,
  createDownload,
  createMagnetPreview,
  createTorrentDownload,
  deleteDownload,
  deleteTorrentPreview,
  getDownloads,
  getTorrentPreview,
  uploadTorrentPreview,
  type DownloadTask,
  type DownloadWorkerHealth,
  type TorrentPreview
} from "../../api.js";
import { formatBytes, formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { SkeletonBlock } from "./ManagementSkeleton.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";
import { StorageFilePickerDialog, type StorageFilePickerPool, type StorageFileSelection } from "./StorageFilePickerDialog.js";

export type HttpDownloaderPool = StorageFilePickerPool;

type DownloadFilter = "all" | "active" | "completed" | "failed";
type DownloadSourceMode = "link" | "torrent-file";

export function HttpDownloaderPanel({
  pools,
  storagePoolsLoading,
  selectedStoragePoolId,
  locale,
  onSelectStoragePool,
  onOpenDirectory,
  onOpenStorage,
  onRequestCreateFolder,
  onNotifyError,
  onNotifySuccess,
  onNotifyWarning
}: {
  pools: HttpDownloaderPool[];
  storagePoolsLoading: boolean;
  selectedStoragePoolId: string;
  locale: SupportedLocale;
  onSelectStoragePool: (poolId: string) => void;
  onOpenDirectory: (storagePoolId: string, path: string) => void;
  onOpenStorage: () => void;
  onRequestCreateFolder?: (input: {
    storagePoolId: string;
    parentPath: string;
    name: string;
  }) => Promise<void>;
  onNotifyError: (message: string | null) => void;
  onNotifySuccess: (message: string | null) => void;
  onNotifyWarning: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [filter, setFilter] = useState<DownloadFilter>("all");
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState<DownloadSourceMode>("link");
  const [url, setUrl] = useState("");
  const [torrentFileName, setTorrentFileName] = useState("");
  const [torrentPreview, setTorrentPreview] = useState<TorrentPreview | null>(null);
  const [selectedFileIndices, setSelectedFileIndices] = useState<number[]>([]);
  const [resolvingTorrent, setResolvingTorrent] = useState(false);
  const [fileName, setFileName] = useState("");
  const [sha256, setSha256] = useState("");
  const [fileNameEdited, setFileNameEdited] = useState(false);
  const [target, setTarget] = useState<StorageFileSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [workerHealth, setWorkerHealth] = useState<DownloadWorkerHealth | null>(null);
  const createDialogRef = useRef<HTMLFormElement | null>(null);
  const createUrlInputRef = useRef<HTMLInputElement | null>(null);
  const torrentFileInputRef = useRef<HTMLInputElement | null>(null);
  const torrentPreviewRequestRef = useRef(0);
  const selectedPool = pools.find((pool) => pool.id === (target?.storagePoolId ?? selectedStoragePoolId)) ?? null;
  const mountedPools = useMemo(() => pools.filter((pool) => pool.status !== "offline"), [pools]);
  const torrentSource = sourceMode === "torrent-file" || isMagnetLink(url);
  const torrentReady = torrentPreview?.status === "ready";
  const sourceReady = torrentSource
    ? torrentReady && selectedFileIndices.length > 0
    : sourceMode === "link" && Boolean(url.trim());
  useEffect(() => {
    let active = true;
    void getDownloads()
      .then((snapshot) => {
        if (!active) return;
        setTasks(snapshot.tasks);
        setWorkerHealth(snapshot.health);
      })
      .catch((error: unknown) => {
        if (!active) return;
        onNotifyError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onNotifyError]);

  useEffect(() => {
    const source = new EventSource("/api/downloads/events");
    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as {
          tasks?: DownloadTask[];
          health?: DownloadWorkerHealth;
        };
        if (Array.isArray(snapshot.tasks)) {
          setTasks(snapshot.tasks);
        }
        if (snapshot.health) {
          setWorkerHealth(snapshot.health);
        }
      } catch {
        // Keep the last valid task snapshot when an event cannot be decoded.
      }
    };
    source.addEventListener("snapshot", handleSnapshot);
    return () => {
      source.removeEventListener("snapshot", handleSnapshot);
      source.close();
    };
  }, []);

  useEffect(() => () => {
    torrentPreviewRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (!createOpen) return;
    const pool = pools.find((candidate) => candidate.id === selectedStoragePoolId) ?? mountedPools[0] ?? null;
    if (!target && pool) {
      setTarget({
        storagePoolId: pool.id,
        path: pool.path,
        name: pool.name
      });
    }
  }, [createOpen, mountedPools, pools, selectedStoragePoolId, target]);

  useEffect(() => {
    if (!createOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => createUrlInputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previouslyFocused?.isConnected) {
        window.requestAnimationFrame(() => previouslyFocused.focus());
      }
    };
  }, [createOpen]);

  const visibleTasks = useMemo(() => tasks.filter((task) => {
    if (filter === "active") return task.status === "queued" || task.status === "running" || task.status === "paused" || task.status === "seeding";
    if (filter === "completed") return task.status === "completed";
    if (filter === "failed") return task.status === "failed" || task.status === "cancelled";
    return true;
  }), [filter, tasks]);
  const activeCount = tasks.filter((task) => task.status === "running" || task.status === "paused" || task.status === "seeding").length;
  const queueCount = tasks.filter((task) => task.status === "queued").length;
  const totalSpeed = tasks.reduce((sum, task) => sum + (task.status === "running" ? task.speedBytesPerSecond : 0), 0);
  const createControlState = downloadCreateControlState(loading, storagePoolsLoading, mountedPools.length > 0);

  function openCreateDialog() {
    if (loading || storagePoolsLoading) return;
    if (mountedPools.length === 0) {
      onNotifyWarning(t("workspace.downloads.configureStoragePool"));
      onOpenStorage();
      return;
    }
    const pool = pools.find((candidate) => candidate.id === selectedStoragePoolId) ?? mountedPools[0] ?? null;
    setTarget(pool ? { storagePoolId: pool.id, path: pool.path, name: pool.name } : null);
    torrentPreviewRequestRef.current += 1;
    setSourceMode("link");
    setUrl("");
    setTorrentFileName("");
    setTorrentPreview(null);
    setSelectedFileIndices([]);
    setResolvingTorrent(false);
    setFileName("");
    setSha256("");
    setFileNameEdited(false);
    setCreateOpen(true);
  }

  function closeCreateDialog() {
    if (submitting) return;
    torrentPreviewRequestRef.current += 1;
    setResolvingTorrent(false);
    if (torrentPreview) {
      void deleteTorrentPreview(torrentPreview.id).catch(() => undefined);
    }
    setTorrentPreview(null);
    setSelectedFileIndices([]);
    setCreateOpen(false);
  }

  function handleCreateDialogKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape" && !event.defaultPrevented && !submitting) {
      event.preventDefault();
      closeCreateDialog();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = [...(createDialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    ) ?? [])].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      createDialogRef.current?.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function updateUrl(value: string) {
    if (resolvingTorrent || torrentPreview) {
      torrentPreviewRequestRef.current += 1;
      if (torrentPreview) {
        void deleteTorrentPreview(torrentPreview.id).catch(() => undefined);
      }
      setTorrentPreview(null);
      setSelectedFileIndices([]);
      setResolvingTorrent(false);
    }
    setUrl(value);
    if (!fileNameEdited) {
      setFileName(isMagnetLink(value) ? "" : deriveFileName(value));
    }
  }

  function selectSourceMode(mode: DownloadSourceMode) {
    if (sourceMode === mode) return;
    torrentPreviewRequestRef.current += 1;
    if (torrentPreview) {
      void deleteTorrentPreview(torrentPreview.id).catch(() => undefined);
    }
    setSourceMode(mode);
    setUrl("");
    setTorrentFileName("");
    setTorrentPreview(null);
    setSelectedFileIndices([]);
    setResolvingTorrent(false);
    setFileName("");
    setSha256("");
    setFileNameEdited(false);
  }

  async function resolveTorrent(createPreview: () => Promise<TorrentPreview>) {
    if (torrentPreview) {
      void deleteTorrentPreview(torrentPreview.id).catch(() => undefined);
    }
    const requestId = torrentPreviewRequestRef.current + 1;
    torrentPreviewRequestRef.current = requestId;
    setResolvingTorrent(true);
    setTorrentPreview(null);
    setSelectedFileIndices([]);
    onNotifyError(null);
    try {
      let preview = await createPreview();
      if (torrentPreviewRequestRef.current !== requestId) return;
      setTorrentPreview(preview);
      while (preview.status === "queued" || preview.status === "resolving") {
        await delay(750);
        if (torrentPreviewRequestRef.current !== requestId) return;
        preview = await getTorrentPreview(preview.id);
        if (torrentPreviewRequestRef.current !== requestId) return;
        setTorrentPreview(preview);
      }
      if (preview.status !== "ready") {
        throw new Error(preview.error ?? t(`workspace.downloads.previewStatus.${preview.status}`));
      }
      setSelectedFileIndices(preview.files.map((file) => file.fileIndex));
      setFileName(preview.name?.trim() || "torrent");
      setFileNameEdited(false);
    } catch (error) {
      if (torrentPreviewRequestRef.current === requestId) {
        onNotifyError(errorMessage(error));
      }
    } finally {
      if (torrentPreviewRequestRef.current === requestId) {
        setResolvingTorrent(false);
      }
    }
  }

  function resolveMagnet() {
    const magnet = url.trim();
    if (!isMagnetLink(magnet) || resolvingTorrent) return;
    void resolveTorrent(() => createMagnetPreview(magnet));
  }

  function selectTorrentFile(file: File | undefined) {
    if (!file || resolvingTorrent) return;
    setTorrentFileName(file.name);
    void resolveTorrent(() => uploadTorrentPreview(file));
  }

  function handleDirectorySelection(selection: StorageFileSelection) {
    setTarget(selection);
    onSelectStoragePool(selection.storagePoolId);
    setPickerOpen(false);
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || !fileName.trim() || !sourceReady || submitting) return;
    setSubmitting(true);
    onNotifyError(null);
    try {
      const task = torrentSource && torrentPreview?.status === "ready"
        ? await createTorrentDownload({
            torrentPreviewId: torrentPreview.id,
            selectedFileIndices,
            storagePoolId: target.storagePoolId,
            targetDirectory: target.path,
            fileName: fileName.trim(),
            seedRatioLimit: 1,
            seedTimeLimitSeconds: 7_200
          })
        : await createDownload({
            url: url.trim(),
            storagePoolId: target.storagePoolId,
            targetDirectory: target.path,
            fileName: fileName.trim(),
            ...(sha256.trim() ? { sha256: sha256.trim() } : {})
          });
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      torrentPreviewRequestRef.current += 1;
      setTorrentPreview(null);
      setSelectedFileIndices([]);
      setCreateOpen(false);
      onNotifySuccess(t("workspace.downloads.created"));
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function runAction(task: DownloadTask, action: "pause" | "resume" | "cancel" | "retry" | "stop-seeding") {
    const key = `${action}:${task.id}`;
    if (pendingAction) return;
    setPendingAction(key);
    try {
      const updated = await actOnDownload(task.id, action);
      setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function removeTask(task: DownloadTask) {
    if (pendingAction) return;
    setPendingAction(`delete:${task.id}`);
    try {
      await deleteDownload(task.id);
      setTasks((current) => current.filter((item) => item.id !== task.id));
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section
      className="workspace-management http-downloader-panel"
      aria-label={t("workspace.downloads.title")}
      aria-busy={loading || undefined}
    >
      <PanelHeader
        className="downloads-header"
        icon={<Download aria-hidden="true" size={20} />}
        title={t("workspace.downloads.title")}
        subtitle={t("workspace.downloads.description")}
        actions={<PanelHeaderActions label={t("workspace.management.actions.label")} className="downloads-header-actions">
          <PanelHeaderAction
            label={t(loading
              ? "common.states.loading"
              : storagePoolsLoading
                ? "workspace.downloads.loadingStoragePools"
                : "workspace.downloads.newDownload")}
            tooltip={loading
              ? t("common.states.loading")
              : storagePoolsLoading
                ? t("workspace.downloads.loadingStoragePools")
              : mountedPools.length
                ? t("workspace.downloads.newDownload")
                : t("workspace.downloads.configureStoragePool")}
            type="button"
            className="download-create-button"
            onClick={openCreateDialog}
            disabled={createControlState === "loading"}
            aria-busy={createControlState === "loading" || undefined}
            data-state={createControlState}
          >
            {createControlState === "loading"
              ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} />
              : <Plus aria-hidden="true" size={17} />}
          </PanelHeaderAction>
        </PanelHeaderActions>}
      />

      {loading ? (
        <DownloadsInitialSkeleton />
      ) : (
        <>
          <div className="downloads-toolbar">
            <div className="downloads-filters" role="tablist" aria-label={t("workspace.downloads.filters")}>
              {(["all", "active", "completed", "failed"] as DownloadFilter[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={filter === value}
                  className={filter === value ? "is-active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {t(`workspace.downloads.filter.${value}`)}
                </button>
              ))}
            </div>
            <div className="downloads-toolbar-meta">
              <div className="downloads-summary" aria-label={t("workspace.downloads.title")}>
                <div className="download-header-stat">
                  <strong>{formatLocaleNumber(activeCount, locale)}</strong>
                  <span>{t("workspace.downloads.active")}</span>
                </div>
                <div className="download-header-stat">
                  <strong>{formatLocaleNumber(queueCount, locale)}</strong>
                  <span>{t("workspace.downloads.queued")}</span>
                </div>
                <div className="download-header-stat">
                  <strong>{formatBytes(totalSpeed, locale)}/s</strong>
                  <span>{t("workspace.downloads.speed")}</span>
                </div>
                <div className="download-header-stat" data-state={workerHealth?.status ?? "unavailable"}>
                  <strong>{t(`workspace.downloads.workerStatus.${workerHealth?.status ?? "unavailable"}`)}</strong>
                  <span>{t("workspace.downloads.worker")}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="downloads-list">
            {visibleTasks.length === 0 ? (
              <div className="downloads-state">
                <Download aria-hidden="true" size={22} />
                <strong>{t("workspace.downloads.emptyTitle")}</strong>
                <span>{t("workspace.downloads.emptyBody")}</span>
              </div>
            ) : (
              visibleTasks.map((task) => (
                <DownloadTaskRow
                  key={task.id}
                  task={task}
                  locale={locale}
                  pendingAction={pendingAction}
                  onAction={(action) => void runAction(task, action)}
                  onDelete={() => void removeTask(task)}
                  onOpenDirectory={() => onOpenDirectory(task.storagePoolId, task.targetDirectory)}
                />
              ))
            )}
          </div>
        </>
      )}

      {createOpen ? (
        <div className="management-dialog-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && closeCreateDialog()}>
          <form
            ref={createDialogRef}
            className="management-dialog download-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="download-create-title"
            tabIndex={-1}
            onKeyDown={handleCreateDialogKeyDown}
            onSubmit={(event) => void submitCreate(event)}
          >
            <header className="download-create-dialog-header">
              <div className="download-create-dialog-heading">
                <span className="download-create-dialog-icon" aria-hidden="true"><Download size={19} /></span>
                <div>
                  <span className="eyebrow">{t("workspace.downloads.eyebrow")}</span>
                  <h3 id="download-create-title">{t("workspace.downloads.newDownload")}</h3>
                  <p>{t("workspace.downloads.createDescription")}</p>
                </div>
              </div>
              <button type="button" className="management-icon-action" onClick={closeCreateDialog} disabled={submitting} aria-label={t("common.actions.close")}>
                <X aria-hidden="true" size={16} />
              </button>
            </header>
            <div className="download-create-form">
              <section className="download-form-section">
                <div className="download-form-section-heading">
                  <span>01</span>
                  <div>
                    <h4>{t("workspace.downloads.sourceTitle")}</h4>
                    <p>{t("workspace.downloads.sourceDescription")}</p>
                  </div>
                </div>
                <div className="download-source-modes" role="tablist" aria-label={t("workspace.downloads.sourceModeLabel")}>
                  <button type="button" role="tab" aria-selected={sourceMode === "link"} className={sourceMode === "link" ? "is-active" : ""} onClick={() => selectSourceMode("link")}>
                    <Link2 aria-hidden="true" size={14} />
                    <span>{t("workspace.downloads.sourceMode.link")}</span>
                  </button>
                  <button type="button" role="tab" aria-selected={sourceMode === "torrent-file"} className={sourceMode === "torrent-file" ? "is-active" : ""} onClick={() => selectSourceMode("torrent-file")}>
                    <FileUp aria-hidden="true" size={14} />
                    <span>{t("workspace.downloads.sourceMode.torrentFile")}</span>
                  </button>
                </div>
                {sourceMode === "link" ? (
                  <div className="download-source-input-row">
                    <label className="download-form-field download-form-field-wide">
                      <span>{t("workspace.downloads.link")}</span>
                      <input
                        ref={createUrlInputRef}
                        type="text"
                        inputMode="url"
                        value={url}
                        onChange={(event) => updateUrl(event.target.value)}
                        placeholder={t("workspace.downloads.linkPlaceholder")}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </label>
                    {isMagnetLink(url) ? (
                      <button type="button" className="secondary-button download-resolve-button" disabled={resolvingTorrent || torrentReady} onClick={resolveMagnet}>
                        {resolvingTorrent ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : <Magnet aria-hidden="true" size={14} />}
                        <span>{t(torrentReady ? "workspace.downloads.metadataReady" : "workspace.downloads.resolveMetadata")}</span>
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div className="download-torrent-upload">
                    <input
                      ref={torrentFileInputRef}
                      type="file"
                      accept=".torrent,application/x-bittorrent"
                      hidden
                      onChange={(event) => {
                        selectTorrentFile(event.target.files?.[0]);
                        event.target.value = "";
                      }}
                    />
                    <button type="button" className="download-torrent-pick" disabled={resolvingTorrent} onClick={() => torrentFileInputRef.current?.click()}>
                      {resolvingTorrent ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <FileArchive aria-hidden="true" size={16} />}
                      <span>{torrentFileName || t("workspace.downloads.chooseTorrentFile")}</span>
                    </button>
                    <small>{t("workspace.downloads.torrentFileHint")}</small>
                  </div>
                )}
                {torrentPreview ? (
                  <div className="download-preview-status" data-status={torrentPreview.status} role="status">
                    {resolvingTorrent ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : torrentPreview.status === "ready" ? <CheckCircle2 aria-hidden="true" size={15} /> : <CircleAlert aria-hidden="true" size={15} />}
                    <div>
                      <strong>{t(`workspace.downloads.previewStatus.${torrentPreview.status}`)}</strong>
                      <span>{torrentPreview.status === "ready"
                        ? t("workspace.downloads.previewSummary", { name: torrentPreview.name ?? t("workspace.downloads.sourceKind.torrent"), count: torrentPreview.fileCount, size: formatBytes(torrentPreview.totalBytes ?? 0, locale) })
                        : torrentPreview.error ?? t("workspace.downloads.previewWaiting")}</span>
                    </div>
                  </div>
                ) : null}
                {torrentPreview?.status === "ready" ? (
                  <TorrentFileSelector
                    files={torrentPreview.files}
                    selectedFileIndices={selectedFileIndices}
                    locale={locale}
                    disabled={submitting}
                    onChange={setSelectedFileIndices}
                  />
                ) : null}
                <label className="download-form-field">
                  <span>{t(torrentSource ? "workspace.downloads.outputFolderName" : "workspace.downloads.fileName")}</span>
                  <input value={fileName} onChange={(event) => { setFileNameEdited(true); setFileName(event.target.value); }} />
                  <small>{t(torrentSource ? "workspace.downloads.outputFolderHint" : "workspace.downloads.fileNameHint")}</small>
                </label>
                {!torrentSource ? <label className="download-form-field download-form-field-wide">
                  <span>{t("workspace.downloads.sha256")}</span>
                  <input
                    value={sha256}
                    onChange={(event) => setSha256(event.target.value)}
                    placeholder={t("workspace.downloads.sha256Placeholder")}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <small>{t("workspace.downloads.sha256Hint")}</small>
                </label> : null}
                {torrentReady ? <p className="download-seeding-policy">{t("workspace.downloads.seedingPolicy")}</p> : null}
              </section>

              <section className="download-form-section">
                <div className="download-form-section-heading">
                  <span>02</span>
                  <div>
                    <h4>{t("workspace.downloads.destinationTitle")}</h4>
                    <p>{t("workspace.downloads.destinationDescription")}</p>
                  </div>
                </div>
                <div className="download-target-field">
                  <span>{t("workspace.downloads.targetDirectory")}</span>
                  <div className="download-target-control">
                    <div className="download-target-value" title={target?.path ?? undefined}>
                      <FolderOpen aria-hidden="true" size={15} />
                      <span>{target?.path ?? t("workspace.downloads.chooseDirectory")}</span>
                    </div>
                    <button type="button" onClick={() => setPickerOpen(true)} disabled={!mountedPools.length}>
                      <FolderOpen aria-hidden="true" size={15} />
                      <span>{t("workspace.downloads.chooseDirectory")}</span>
                    </button>
                  </div>
                  <small>{selectedPool?.name ?? t("workspace.downloads.noStoragePool")}</small>
                </div>
              </section>
            </div>
            <footer className="download-create-dialog-footer">
              <button type="button" className="secondary-button" onClick={closeCreateDialog} disabled={submitting}>{t("common.actions.cancel")}</button>
              <button type="submit" className="primary-button" disabled={submitting || !target || !sourceReady || !fileName.trim()} aria-busy={submitting || undefined}>
                {submitting ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : <Download aria-hidden="true" size={15} />}
                <span>{t("workspace.downloads.startDownload")}</span>
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      {pickerOpen ? (
        <StorageFilePickerDialog
          pools={mountedPools}
          initialPoolId={target?.storagePoolId ?? selectedStoragePoolId}
          locale={locale}
          mode="directory"
          onCancel={() => setPickerOpen(false)}
          onSelect={handleDirectorySelection}
          {...(onRequestCreateFolder ? { onRequestCreateFolder } : {})}
        />
      ) : null}
    </section>
  );
}

export function downloadCreateControlState(
  initialLoading: boolean,
  storagePoolsLoading: boolean,
  hasMountedPool: boolean
): "loading" | "ready" | "needs-storage" {
  if (initialLoading || storagePoolsLoading) return "loading";
  return hasMountedPool ? "ready" : "needs-storage";
}

function DownloadsInitialSkeleton() {
  const { t } = useTranslation();
  return (
    <>
      <span className="visually-hidden" role="status">{t("common.states.loading")}</span>
      <div className="downloads-toolbar downloads-toolbar-skeleton" aria-hidden="true">
        <div className="downloads-filters downloads-filters-skeleton">
          {[52, 58, 76, 54].map((width) => <SkeletonBlock key={width} width={`${width}px`} />)}
        </div>
        <div className="downloads-summary downloads-summary-skeleton">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="download-header-stat" key={index}>
              <SkeletonBlock width={index === 2 ? "56px" : "32px"} />
              <SkeletonBlock width={index === 3 ? "48px" : "38px"} />
            </div>
          ))}
        </div>
      </div>
      <div className="downloads-list downloads-list-skeleton" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <article className="download-task-row download-task-row-skeleton" key={index}>
            <div className="download-task-main">
              <div className="download-task-heading">
                <SkeletonBlock className="download-skeleton-icon" />
                <div>
                  <SkeletonBlock width={index % 2 ? "58%" : "72%"} />
                  <SkeletonBlock width={index % 2 ? "34%" : "42%"} />
                </div>
                <SkeletonBlock className="download-skeleton-status" />
              </div>
              <SkeletonBlock width={index % 2 ? "68%" : "82%"} />
              <SkeletonBlock className="download-skeleton-progress" />
              <div className="download-skeleton-meta">
                <SkeletonBlock width="76px" />
                <SkeletonBlock width="48px" />
                <SkeletonBlock width="58px" />
              </div>
            </div>
            <div className="download-task-actions">
              {Array.from({ length: 3 }, (_, actionIndex) => (
                <SkeletonBlock className="download-skeleton-action" key={actionIndex} />
              ))}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

export function TorrentFileSelector({
  files,
  selectedFileIndices,
  locale,
  disabled,
  onChange
}: {
  files: TorrentPreview["files"];
  selectedFileIndices: number[];
  locale: SupportedLocale;
  disabled: boolean;
  onChange: (fileIndices: number[]) => void;
}) {
  const { t } = useTranslation();
  const selected = new Set(selectedFileIndices);
  const allSelected = files.length > 0 && files.every((file) => selected.has(file.fileIndex));
  const selectedBytes = files.reduce((sum, file) => selected.has(file.fileIndex) ? sum + file.sizeBytes : sum, 0);
  const sortedSelection = (values: number[]) => [...values].sort((left, right) => left - right);

  return (
    <div className="torrent-file-selector" aria-label={t("workspace.downloads.torrentFiles")}>
      <div className="torrent-file-selector-toolbar">
        <label>
          <input
            type="checkbox"
            checked={allSelected}
            disabled={disabled || files.length === 0}
            onChange={(event) => onChange(event.target.checked ? files.map((file) => file.fileIndex) : [])}
          />
          <span>{t("workspace.downloads.selectAllFiles")}</span>
        </label>
        <span>{t("workspace.downloads.fileSelectionSummary", {
          selected: selected.size,
          total: files.length,
          size: formatBytes(selectedBytes, locale)
        })}</span>
      </div>
      <div className="torrent-file-list">
        {files.map((file) => (
          <label key={file.fileIndex} title={file.path}>
            <input
              type="checkbox"
              checked={selected.has(file.fileIndex)}
              disabled={disabled}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(file.fileIndex);
                else next.delete(file.fileIndex);
                onChange(sortedSelection([...next]));
              }}
            />
            <span>{file.path}</span>
            <small>{formatBytes(file.sizeBytes, locale)}</small>
          </label>
        ))}
      </div>
    </div>
  );
}

export function DownloadTaskRow({
  task,
  locale,
  pendingAction,
  onAction,
  onDelete,
  onOpenDirectory
}: {
  task: DownloadTask;
  locale: SupportedLocale;
  pendingAction: string | null;
  onAction: (action: "pause" | "resume" | "cancel" | "retry" | "stop-seeding") => void;
  onDelete: () => void;
  onOpenDirectory: () => void;
}) {
  const { t } = useTranslation();
  const progress = task.totalBytes && task.totalBytes > 0
    ? Math.min(100, Math.round(task.receivedBytes / task.totalBytes * 100))
    : null;
  const isIndeterminate = progress === null && task.status === "running";
  const progressValue = progress ?? (task.status === "completed" ? 100 : null);
  const progressWidth = progressValue ?? (isIndeterminate ? 36 : 0);
  const host = task.sourceKind === "http"
    ? getHost(task.url)
    : task.torrentName ?? t(`workspace.downloads.sourceKind.${task.sourceKind}`);
  const canPause = task.status === "queued" || task.status === "running" || task.status === "seeding";
  const canResume = task.status === "paused";
  const canCancel = task.status === "queued" || task.status === "running" || task.status === "paused";
  const canStopSeeding = task.status === "seeding";
  const canRetry = task.status === "failed" || task.status === "cancelled";
  const actionBusy = pendingAction?.endsWith(`:${task.id}`) === true;
  const retryLabel = formatRetry(task, locale, t);
  const checksumLabel = formatChecksum(task, t);

  return (
    <article className="download-task-row" data-status={task.status}>
      <div className="download-task-main">
        <div className="download-task-heading">
          <span className="download-task-icon" aria-hidden="true">
            {task.status === "completed"
              ? <CheckCircle2 size={17} />
              : task.status === "failed"
                ? <CircleAlert size={17} />
                : task.sourceKind === "magnet"
                  ? <Magnet size={17} />
                  : task.sourceKind === "torrent"
                    ? <FileArchive size={17} />
                    : <Download size={17} />}
          </span>
          <div>
            <strong title={task.targetFileName}>{task.targetFileName}</strong>
            <span title={task.url}>{host}</span>
          </div>
          <span className="download-task-status">{t(`workspace.downloads.status.${task.status}`)}</span>
        </div>
        <div className="download-task-path" title={task.targetPath}>{task.targetPath}</div>
        <div
          className={`download-progress-track${isIndeterminate ? " is-indeterminate" : ""}`}
          data-indeterminate={isIndeterminate ? "true" : undefined}
          role="progressbar"
          aria-label={t("workspace.downloads.progress", { name: task.targetFileName })}
          aria-valuemin={progressValue === null ? undefined : 0}
          aria-valuemax={progressValue === null ? undefined : 100}
          aria-valuenow={progressValue ?? undefined}
        >
          <span style={{ width: `${progressWidth}%` }} />
        </div>
        <div className="download-task-meta">
          <span>{formatProgress(task, locale, t)}</span>
          <span>{formatSpeed(task.speedBytesPerSecond, locale, t)}</span>
          <span>{formatEta(task, locale, t)}</span>
          {task.downloadMode ? <span>{t(`workspace.downloads.mode.${task.downloadMode}`)}</span> : null}
          {task.phase ? <span>{t(`workspace.downloads.phase.${task.phase}`)}</span> : null}
          {task.downloadMode === "segmented" && task.segmentCount > 0
            ? <span>{t("workspace.downloads.segments", { count: task.segmentCount })}</span>
            : null}
          {task.sourceKind !== "http" ? (
            <>
              <span>{t("workspace.downloads.uploaded", { value: formatBytes(task.uploadedBytes, locale) })}</span>
              <span>{t("workspace.downloads.uploadSpeed", { value: `${formatBytes(task.uploadSpeedBytesPerSecond, locale)}/s` })}</span>
              <span>{t("workspace.downloads.peers", { count: task.peerCount })}</span>
              <span>{t("workspace.downloads.ratio", { value: torrentRatio(task) })}</span>
            </>
          ) : null}
          {task.controlRequested
            ? <span>{t(`workspace.downloads.control.${task.controlRequested}`)}</span>
            : null}
          {retryLabel ? <span>{retryLabel}</span> : null}
          {checksumLabel ? <span title={task.actualSha256 ?? task.expectedSha256 ?? undefined}>{checksumLabel}</span> : null}
          {task.errorCode
            ? <span className="download-task-error" title={task.error ?? undefined}>{t(`workspace.downloads.errorCode.${task.errorCode}`)}</span>
            : task.error
              ? <span className="download-task-error" title={task.error}>{task.error}</span>
              : null}
        </div>
      </div>
      <div className="download-task-actions" aria-label={t("workspace.downloads.actions")}>
        {canPause ? (
          <IconAction icon={<Pause aria-hidden="true" size={14} />} label={t(task.status === "seeding" ? "workspace.downloads.pauseSeeding" : "workspace.downloads.pause")} disabled={actionBusy} busy={actionBusy} onClick={() => onAction("pause")} />
        ) : null}
        {canResume ? (
          <IconAction icon={<Play aria-hidden="true" size={14} />} label={t("workspace.downloads.resume")} disabled={actionBusy} busy={actionBusy} onClick={() => onAction("resume")} />
        ) : null}
        {canRetry ? (
          <IconAction icon={<RotateCw aria-hidden="true" size={14} />} label={t("workspace.downloads.retry")} disabled={actionBusy} busy={actionBusy} onClick={() => onAction("retry")} />
        ) : null}
        {canCancel ? (
          <IconAction icon={<X aria-hidden="true" size={14} />} label={t("workspace.downloads.cancel")} disabled={actionBusy} busy={actionBusy} onClick={() => onAction("cancel")} />
        ) : null}
        {canStopSeeding ? (
          <IconAction icon={<Square aria-hidden="true" size={13} />} label={t("workspace.downloads.stopSeeding")} disabled={actionBusy} busy={actionBusy} onClick={() => onAction("stop-seeding")} />
        ) : null}
        <IconAction icon={<FolderOpen aria-hidden="true" size={14} />} label={t("workspace.downloads.openDirectory")} onClick={onOpenDirectory} />
        {task.status !== "running" && task.status !== "seeding" ? (
          <IconAction icon={<Trash2 aria-hidden="true" size={14} />} label={t("workspace.downloads.remove")} disabled={actionBusy} busy={actionBusy} onClick={onDelete} />
        ) : null}
      </div>
    </article>
  );
}

function IconAction({ icon, label, disabled, busy, onClick }: { icon: ReactNode; label: string; disabled?: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="download-task-action" title={label} aria-label={label} aria-busy={busy || undefined} disabled={disabled} onClick={onClick}>
      {icon}
    </button>
  );
}

function deriveFileName(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const candidate = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "").trim();
    if (
      !candidate ||
      candidate === "." ||
      candidate === ".." ||
      candidate.includes("/") ||
      candidate.includes("\\")
    ) {
      return "download";
    }
    return candidate.length <= 255 ? candidate : `${candidate.slice(0, 252)}...`;
  } catch {
    return "download";
  }
}

function isMagnetLink(value: string): boolean {
  return value.trim().toLowerCase().startsWith("magnet:");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function getHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

function torrentRatio(task: DownloadTask): string {
  if (!task.totalBytes || task.totalBytes <= 0) return "0.00";
  return (task.uploadedBytes / task.totalBytes).toFixed(2);
}

function formatProgress(task: DownloadTask, locale: SupportedLocale, t: (key: string, options?: Record<string, unknown>) => string): string {
  const received = formatBytes(task.receivedBytes, locale);
  return task.totalBytes === null ? `${received} · ${t("workspace.downloads.unknownTotal")}` : `${received} / ${formatBytes(task.totalBytes, locale)}`;
}

function formatSpeed(speed: number, locale: SupportedLocale, t: (key: string) => string): string {
  return speed > 0 ? `${formatBytes(speed, locale)}/s` : t("workspace.downloads.noSpeed");
}

function formatEta(task: DownloadTask, _locale: SupportedLocale, t: (key: string) => string): string {
  if (!task.totalBytes || task.speedBytesPerSecond <= 0 || task.totalBytes <= task.receivedBytes) {
    return task.status === "completed" ? t("workspace.downloads.done") : t("workspace.downloads.unknownEta");
  }
  const seconds = Math.ceil((task.totalBytes - task.receivedBytes) / task.speedBytesPerSecond);
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds / 60) % 60}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatRetry(
  task: DownloadTask,
  locale: SupportedLocale,
  t: (key: string, options?: Record<string, unknown>) => string
): string | null {
  if (!task.nextRetryAt) return null;
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(task.nextRetryAt) - Date.now()) / 1000));
  return t("workspace.downloads.retryCountdown", {
    count: formatLocaleNumber(remainingSeconds, locale),
    retry: task.retryCount
  });
}

function formatChecksum(
  task: DownloadTask,
  t: (key: string, options?: Record<string, unknown>) => string
): string | null {
  if (!task.expectedSha256) return null;
  if (task.phase === "verifying") return t("workspace.downloads.checksumVerifying");
  if (task.actualSha256 === task.expectedSha256) return t("workspace.downloads.checksumVerified");
  if (task.actualSha256) return t("workspace.downloads.checksumMismatch");
  return t("workspace.downloads.checksumPending");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
