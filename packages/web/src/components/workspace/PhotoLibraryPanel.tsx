import { ModalPortal } from "../common/ModalPortal.js";
import {
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  FolderInput,
  List,
  Map,
  Search,
  SlidersHorizontal,
  ImageOff,
  Images,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  Play,
  RefreshCw,
  ScanLine,
  Square,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent
} from "react";
import { useTranslation } from "react-i18next";
import {
  createPhotoExport,
  getPhotoMetadata,
  getPhotoMetadataFields,
  getPhotoRecord,
  getPhotoLibrarySettings,
  getPhotoStatus,
  applyPhotoOperation,
  queryPhotos,
  requestPhotoScan,
  uploadPhoto,
  type PhotoAsset,
  type PhotoMetadataDetail,
  type PhotoMetadataField,
  type PhotoQueryAsset,
  type PhotoLibrarySettings,
  type PhotoLibraryStatus,
  type PhotoWorkerHealth
} from "../../api.js";
import {
  PHOTOS_UPLOAD_EXTENSIONS,
  PHOTOS_XMP_EXTENSION,
  photoExtension,
  photoMediaKind,
  type PhotoMediaKind
} from "@cyberos/shared/photos-config";
import type {
  PhotoMetadataCondition,
  PhotoQueryFacets,
  PhotoQueryFilters,
  PhotoQuerySortField
} from "@cyberos/shared";
import { formatBytes, formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { SkeletonBlock } from "./ManagementSkeleton.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";
import { CustomSelect, type CustomSelectOption } from "../common/CustomSelect.js";
import {
  StorageFilePickerDialog,
  type StorageFilePickerPool
} from "./StorageFilePickerDialog.js";
import { PhotoMapView } from "./PhotoMapView.js";
import { PhotoSearchFilterMenu } from "./PhotoSearchFilterMenu.js";

export const PHOTO_ACCEPT = PHOTOS_UPLOAD_EXTENSIONS.join(",");

export function PhotoLibraryPanel({
  pools,
  locale,
  onRequestCreateFolder,
  onWorkQueuesChanged,
  onNotifyError,
  onNotifySuccess,
  onNotifyWarning,
  onOpenSettings,
  configurationUpdatedAt
}: {
  pools: StorageFilePickerPool[];
  locale: SupportedLocale;
  onRequestCreateFolder?: (input: {
    storagePoolId: string;
    parentPath: string;
    name: string;
  }) => Promise<void>;
  onWorkQueuesChanged: () => void | Promise<void>;
  onNotifyError: (message: string | null) => void;
  onNotifySuccess: (message: string | null) => void;
  onNotifyWarning: (message: string | null) => void;
  onOpenSettings: () => void;
  configurationUpdatedAt: string | null;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PhotoLibrarySettings | null>(null);
  const [status, setStatus] = useState<PhotoLibraryStatus | null>(null);
  const [workerHealth, setWorkerHealth] = useState<PhotoWorkerHealth | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [photos, setPhotos] = useState<PhotoQueryAsset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<PhotoQueryFacets | null>(null);
  const [filters, setFilters] = useState<PhotoQueryFilters>({});
  const [searchText, setSearchText] = useState("");
  const [sortField, setSortField] = useState<PhotoQuerySortField>("captured_at");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [view, setView] = useState<"timeline" | "map">("timeline");
  const [metadataFields, setMetadataFields] = useState<PhotoMetadataField[]>([]);
  const [metadata, setMetadata] = useState<PhotoMetadataDetail | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [sensitiveRevealed, setSensitiveRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [hasLoadedSnapshot, setHasLoadedSnapshot] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"move" | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [runtimeAlertOpen, setRuntimeAlertOpen] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const libraryRef = useRef<HTMLElement | null>(null);
  const libraryContentRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);
  const lightboxTriggerRef = useRef<HTMLElement | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const runtimeAlertRef = useRef<HTMLDivElement | null>(null);
  const runtimeAlertTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dragDepthRef = useRef(0);
  const libraryRequestRef = useRef(0);
  const configurationUpdatedAtRef = useRef(configurationUpdatedAt);
  const timelineRequestRef = useRef(0);
  const timelineLoadRef = useRef<((cursor?: string | null) => Promise<void>) | null>(null);
  const loadedQueryKeyRef = useRef<string | null>(null);
  const queryKeyRef = useRef("");
  const loadingMoreRef = useRef(false);
  const metadataRequestRef = useRef(0);

  const configuredPool = pools.find((pool) => pool.id === settings?.storagePoolId) ?? null;
  const selected = photos.filter((photo) => selectedIds.has(photo.id));
  const groupedPhotos = useMemo(() => groupPhotosByDate(photos, locale), [locale, photos]);
  const lightboxIndex = lightboxId ? photos.findIndex((photo) => photo.id === lightboxId) : -1;
  const lightboxPhoto = lightboxIndex >= 0 ? photos[lightboxIndex] ?? null : null;
  const lightboxMediaKind = lightboxPhoto ? photoMediaKindForAsset(lightboxPhoto) : null;
  const statusBusy = isPhotoBusy(status?.state);
  const queryFilters = useMemo(() => readyPhotoQueryFilters(filters, metadataFields), [filters, metadataFields]);
  const queryKey = useMemo(() => JSON.stringify({ filters: queryFilters, sortField, sortDirection }), [queryFilters, sortDirection, sortField]);
  const runtimeAlert = photoRuntimeAlert(status, workerHealth);
  const runtimeAlertLabel = runtimeAlert
    ? [
        t(`settings.photos.states.${runtimeAlert.state}`),
        t(`settings.photos.workerStates.${runtimeAlert.workerStatus}`),
        runtimeAlert.error,
        runtimeAlert.errorCode,
        runtimeAlert.nextRetryAt ? t("workspace.photos.retryIn", { value: retryCountdown(runtimeAlert.nextRetryAt, clock) }) : null
      ].filter(Boolean).join(" · ")
    : null;
  const hasRuntimeAlert = runtimeAlert !== null;

  useEffect(() => {
    if (!hasRuntimeAlert) setRuntimeAlertOpen(false);
  }, [hasRuntimeAlert]);

  useEffect(() => {
    if (!runtimeAlertOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !runtimeAlertRef.current?.contains(target)) {
        setRuntimeAlertOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setRuntimeAlertOpen(false);
      runtimeAlertTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [runtimeAlertOpen]);

  const loadTimeline = useCallback(async (cursor: string | null = null) => {
    const requestId = cursor ? timelineRequestRef.current : ++timelineRequestRef.current;
    const page = await queryPhotos({
      filters: queryFilters,
      sort: { field: sortField, direction: sortDirection },
      cursor,
      limit: 60,
      includeFacets: !cursor
    });
    if (requestId !== timelineRequestRef.current) return;
    setPhotos((current) => cursor ? mergePhotos(current, page.photos) : page.photos);
    setNextCursor(page.nextCursor);
    setTotal(page.total);
    if (!cursor) setFacets(page.facets);
  }, [queryFilters, sortDirection, sortField]);
  timelineLoadRef.current = loadTimeline;
  queryKeyRef.current = queryKey;

  const loadLibrary = useCallback(async () => {
    const requestId = ++libraryRequestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [nextSettings, snapshot] = await Promise.all([
        getPhotoLibrarySettings(),
        getPhotoStatus()
      ]);
      if (requestId !== libraryRequestRef.current) return;
      setSettings(nextSettings);
      setStatus(snapshot.status);
      setWorkerHealth(snapshot.workerHealth);
      if (nextSettings) {
        loadedQueryKeyRef.current = queryKeyRef.current;
        const [, fields] = await Promise.all([
          timelineLoadRef.current?.() ?? Promise.resolve(),
          getPhotoMetadataFields()
        ]);
        if (requestId !== libraryRequestRef.current) return;
        setMetadataFields((current) => samePhotoMetadataFields(current, fields) ? current : fields);
      }
      else {
        loadedQueryKeyRef.current = null;
        setPhotos([]);
        setNextCursor(null);
        setTotal(0);
        setFacets(null);
      }
      setHasLoadedSnapshot(true);
    } catch (error) {
      if (requestId !== libraryRequestRef.current) return;
      const message = errorMessage(error);
      setLoadError(message);
      onNotifyError(message);
    } finally {
      if (requestId === libraryRequestRef.current) {
        setLoading(false);
        setInitialLoadComplete(true);
      }
    }
  }, [onNotifyError]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (configurationUpdatedAtRef.current === configurationUpdatedAt) return;
    configurationUpdatedAtRef.current = configurationUpdatedAt;
    if (configurationUpdatedAt) void loadLibrary();
  }, [configurationUpdatedAt, loadLibrary]);

  useEffect(() => {
    if (!settings || loading || loadedQueryKeyRef.current === queryKey) return;
    loadedQueryKeyRef.current = queryKey;
    setPaginationError(null);
    void loadTimeline().catch((error) => {
      if (queryKeyRef.current !== queryKey) return;
      loadedQueryKeyRef.current = null;
      onNotifyError(errorMessage(error));
    });
  }, [loadTimeline, loading, onNotifyError, queryKey, settings]);

  useEffect(() => () => {
    libraryRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (!settings) return undefined;
    let active = true;
    let timer: number | null = null;
    const poll = async (): Promise<void> => {
      let nextBusy = statusBusy;
      try {
        const snapshot = await getPhotoStatus();
        if (!active) return;
        nextBusy = isPhotoBusy(snapshot.status.state);
        const timelineChanged = snapshot.status.updatedAt !== status?.updatedAt;
        setStatus(snapshot.status);
        setWorkerHealth(snapshot.workerHealth);
        if (!nextBusy && timelineChanged) await loadTimeline();
      } catch (error) {
        if (active) onNotifyError(errorMessage(error));
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), nextBusy ? 2_000 : 5_000);
      }
    };
    timer = window.setTimeout(() => void poll(), statusBusy ? 2_000 : 5_000);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadTimeline, onNotifyError, settings, status?.updatedAt, statusBusy]);

  useEffect(() => {
    if (!status?.nextRetryAt) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status?.nextRetryAt]);

  useEffect(() => {
    setSelectedIds((current) => new Set([...current].filter((id) => photos.some((photo) => photo.id === id))));
  }, [photos]);

  useEffect(() => {
    if (!lightboxPhoto) return undefined;
    const previouslyFocused = lightboxTriggerRef.current;
    const frame = window.requestAnimationFrame(() => lightboxRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previouslyFocused?.isConnected) window.requestAnimationFrame(() => previouslyFocused.focus());
    };
  }, [lightboxPhoto]);

  useEffect(() => {
    const requestId = ++metadataRequestRef.current;
    if (!lightboxPhoto) {
      setMetadata(null);
      setSensitiveRevealed(false);
      return undefined;
    }
    let active = true;
    setMetadataLoading(true);
    setMetadata(null);
    setSensitiveRevealed(false);
    void getPhotoMetadata(lightboxPhoto.id).then((detail) => {
      if (active && requestId === metadataRequestRef.current) setMetadata(detail);
    }).catch((error) => {
      if (active) onNotifyError(errorMessage(error));
    }).finally(() => {
      if (active && requestId === metadataRequestRef.current) setMetadataLoading(false);
    });
    return () => { active = false; };
  }, [lightboxPhoto, onNotifyError]);

  useEffect(() => {
    if (!deleteOpen) return undefined;
    const trigger = deleteTriggerRef.current;
    const frame = window.requestAnimationFrame(() => deleteDialogRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (trigger?.isConnected) window.requestAnimationFrame(() => trigger.focus());
    };
  }, [deleteOpen]);

  async function startScan() {
    if (!settings || busyAction) return;
    setBusyAction("scan");
    try {
      await requestPhotoScan();
      const snapshot = await getPhotoStatus();
      setStatus(snapshot.status);
      setWorkerHealth(snapshot.workerHealth);
      onNotifySuccess(t("workspace.photos.scanQueued"));
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    const loadQueryKey = queryKeyRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setPaginationError(null);
    try {
      await loadTimeline(nextCursor);
    } catch (error) {
      if (queryKeyRef.current !== loadQueryKey) return;
      const message = errorMessage(error);
      setPaginationError(message);
      onNotifyError(message);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [loadTimeline, nextCursor, onNotifyError]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined" || !shouldAutoLoadPhotos({
      view,
      nextCursor,
      loadingMore,
      paginationError
    })) return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root: null, rootMargin: "320px 0px", threshold: 0.01 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, loadingMore, nextCursor, paginationError, view]);

  async function uploadFiles(files: File[]) {
    if (!settings || !files.length || busyAction) return;
    const supported = files
      .filter((file) => photoMediaKind(file.name) !== null || photoExtension(file.name) === PHOTOS_XMP_EXTENSION)
      .sort((left, right) => Number(photoExtension(left.name) === PHOTOS_XMP_EXTENSION) - Number(photoExtension(right.name) === PHOTOS_XMP_EXTENSION));
    if (!supported.length) {
      onNotifyWarning(t("workspace.photos.unsupportedUpload"));
      return;
    }
    setBusyAction("upload");
    let completed = 0;
    const failures: string[] = [];
    for (const file of supported) {
      try {
        await uploadPhoto(file, settings.path);
        completed += 1;
      } catch (error) {
        failures.push(`${file.name}: ${errorMessage(error)}`);
      }
    }
    if (completed) onNotifySuccess(t("workspace.photos.uploaded", { count: completed }));
    if (failures.length) onNotifyWarning(failures.slice(0, 3).join("\n"));
    try {
      const snapshot = await getPhotoStatus();
      setStatus(snapshot.status);
      setWorkerHealth(snapshot.workerHealth);
      if (!isPhotoBusy(snapshot.status.state)) await loadTimeline();
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  function handleUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    void uploadFiles(files);
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    if (!settings) return;
    dragDepthRef.current += 1;
    setDropActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = settings ? "copy" : "none";
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    if (!settings) return;
    void uploadFiles([...event.dataTransfer.files]);
  }

  function toggleSelection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllLoaded() {
    setSelectedIds(selectedIds.size === photos.length ? new Set() : new Set(photos.map((photo) => photo.id)));
  }

  function openLightbox(photo: PhotoQueryAsset, trigger: HTMLElement) {
    lightboxTriggerRef.current = trigger;
    setZoom(1);
    setLightboxId(photo.id);
  }

  async function openMapAsset(assetId: string) {
    let asset = photos.find((candidate) => candidate.id === assetId);
    if (!asset) {
      try {
        asset = await getPhotoRecord(assetId);
        setPhotos((current) => mergePhotos(current, [asset!]));
      } catch (error) {
        onNotifyError(errorMessage(error));
        return;
      }
    }
    openLightbox(asset, document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
  }

  async function revealSensitiveMetadata() {
    if (!lightboxPhoto || metadataLoading) return;
    const requestId = ++metadataRequestRef.current;
    setMetadataLoading(true);
    try {
      const detail = await getPhotoMetadata(lightboxPhoto.id, true);
      if (requestId !== metadataRequestRef.current) return;
      setMetadata(detail);
      setSensitiveRevealed(true);
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      if (requestId === metadataRequestRef.current) setMetadataLoading(false);
    }
  }

  function updateFilter<K extends keyof PhotoQueryFilters>(key: K, value: PhotoQueryFilters[K]) {
    setFilters((current) => {
      const next = { ...current, [key]: value };
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete next[key];
      return next;
    });
    resetQueryUi();
  }

  function applyFilters(nextFilters: PhotoQueryFilters) {
    setFilters(nextFilters);
    resetQueryUi();
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = searchText.trim();
    if ((filters.text ?? "") === text) return;
    setFilters((current) => {
      if (text) return { ...current, text };
      const { text: _text, ...rest } = current;
      return rest;
    });
    resetQueryUi();
  }

  function updateSortField(field: PhotoQuerySortField) {
    if (field === sortField) return;
    setSortField(field);
    resetQueryUi();
  }

  function reverseSortDirection() {
    setSortDirection((current) => current === "asc" ? "desc" : "asc");
    resetQueryUi();
  }

  function resetQueryUi() {
    setSelectedIds(new Set());
    setNextCursor(null);
    setPaginationError(null);
    libraryContentRef.current?.scrollTo({ top: 0 });
    libraryRef.current?.scrollTo({ top: 0 });
  }

  function showAdjacent(offset: number) {
    const next = photos[lightboxIndex + offset];
    if (!next) return;
    setZoom(1);
    setLightboxId(next.id);
  }

  async function downloadSelection() {
    if (!selected.length || busyAction) return;
    setBusyAction("download");
    try {
      const result = await createPhotoExport(selected.map((photo) => photo.id));
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.download = selected.length === 1 ? selected[0]!.name : "cyberos-photos.zip";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function applyBatch(operation: "move" | "trash", targetDirectory?: string) {
    if (!selected.length || busyAction) return;
    setBusyAction(operation);
    try {
      await applyPhotoOperation({
        assetIds: selected.map((photo) => photo.id),
        operation,
        ...(targetDirectory ? { targetDirectory } : {})
      });
      setPicker(null);
      setDeleteOpen(false);
      setSelectedIds(new Set());
      await loadLibrary();
      await onWorkQueuesChanged();
      onNotifySuccess(t("notifications.operationSucceeded"));
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  function handleLightboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setLightboxId(null);
      return;
    }
    const target = event.target as HTMLElement | null;
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && target?.closest("video")) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      showAdjacent(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      showAdjacent(1);
      return;
    }
    if (event.key !== "Tab") return;
    trapDialogFocus(event, lightboxRef.current);
  }

  const movePools = configuredPool ? [configuredPool] : [];
  const loadMode = photoLibraryLoadMode(initialLoadComplete, hasLoadedSnapshot, loadError);

  return (
    <section
      ref={libraryRef}
      className={`photo-library${dropActive ? " is-drop-active" : ""}`}
      aria-label={t("workspace.photos.title")}
      aria-busy={loading || undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={uploadInputRef}
        className="workspace-upload-input"
        type="file"
        accept={PHOTO_ACCEPT}
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleUploadChange}
      />

      <PanelHeader
        className="photo-library-header"
        icon={<Images aria-hidden="true" size={20} />}
        title={t("workspace.photos.title")}
        subtitle={t("workspace.photos.description")}
        actions={<PanelHeaderActions label={t("workspace.photos.actions")} className="photo-library-actions">
          <PanelHeaderAction
            label={t("workspace.photos.scanNow")}
            type="button"
            onClick={() => void startScan()}
            disabled={!settings || Boolean(busyAction) || statusBusy}
          >
            <ScanLine aria-hidden="true" size={17} />
          </PanelHeaderAction>
          <PanelHeaderAction
            label={t("workspace.photos.upload")}
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            disabled={!settings || Boolean(busyAction) || status?.state === "offline"}
            aria-busy={busyAction === "upload" || undefined}
          >
            {busyAction === "upload" ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <Upload aria-hidden="true" size={17} />}
          </PanelHeaderAction>
          <PanelHeaderAction label={t("common.actions.refresh")} type="button" onClick={() => void loadLibrary()} disabled={loading}>
            <RefreshCw className={loading ? "is-spinning" : undefined} aria-hidden="true" size={17} />
          </PanelHeaderAction>
        </PanelHeaderActions>}
      />

      {loadMode === "loading" ? <span className="visually-hidden" role="status">{t("common.states.loading")}</span> : null}

      {loadMode === "loading" ? (
        <PhotoQuerySkeleton />
      ) : settings ? (
        <div className="photo-query-panel">
          <div className="photo-query-toolbar">
            <form className="photo-search-field" role="search" onSubmit={submitSearch}>
              <button type="submit" title={t("workspace.photos.search")} aria-label={t("workspace.photos.search")}>
                <Search aria-hidden="true" size={15} />
              </button>
              <input
                type="search"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder={t("workspace.photos.searchPlaceholder")}
                aria-label={t("workspace.photos.searchPlaceholder")}
              />
            </form>
            <div className="photo-view-switch" role="tablist" aria-label={t("workspace.photos.views")}>
              <button type="button" role="tab" aria-selected={view === "timeline"} onClick={() => setView("timeline")} title={t("workspace.photos.timelineView")}>
                <List aria-hidden="true" size={15} /><span>{t("workspace.photos.timelineView")}</span>
              </button>
              <button type="button" role="tab" aria-selected={view === "map"} onClick={() => setView("map")} title={t("workspace.photos.mapView")}>
                <Map aria-hidden="true" size={15} /><span>{t("workspace.photos.mapView")}</span>
              </button>
            </div>
            <label className="photo-sort-field">
              <span>{t("workspace.photos.sort")}</span>
              <CustomSelect
                value={sortField}
                options={[
                  { value: "captured_at", label: t("workspace.photos.sortCaptured") },
                  { value: "indexed_at", label: t("workspace.photos.sortIndexed") },
                  { value: "name", label: t("workspace.photos.sortName") },
                  { value: "size_bytes", label: t("workspace.photos.sortSize") },
                  { value: "rating", label: t("workspace.photos.sortRating") },
                  ...(filters.location?.kind === "near" ? [{ value: "distance", label: t("workspace.photos.sortDistance") }] : [])
                ] as CustomSelectOption<PhotoQuerySortField>[]}
                onChange={updateSortField}
                ariaLabel={t("workspace.photos.sort")}
                className="photo-sort-select"
              />
              <button type="button" onClick={reverseSortDirection} title={t("workspace.photos.sortDirection")} aria-label={t("workspace.photos.sortDirection")}>
                {sortDirection === "asc" ? "↑" : "↓"}
              </button>
            </label>
            {runtimeAlert && runtimeAlertLabel ? (
              <div ref={runtimeAlertRef} className="photo-runtime-alert-popover">
                <button
                  ref={runtimeAlertTriggerRef}
                  className={`photo-runtime-alert${runtimeAlertOpen ? " is-open" : ""}`}
                  data-tone={runtimeAlert.tone}
                  type="button"
                  title={runtimeAlertLabel}
                  aria-label={t("workspace.photos.runtimeAlert", { details: runtimeAlertLabel })}
                  aria-haspopup="dialog"
                  aria-expanded={runtimeAlertOpen}
                  aria-controls="photo-runtime-alert-details"
                  onClick={() => setRuntimeAlertOpen((open) => !open)}
                >
                  <CircleAlert aria-hidden="true" size={15} />
                </button>
                {runtimeAlertOpen ? (
                  <div
                    id="photo-runtime-alert-details"
                    className="photo-runtime-alert-details"
                    data-tone={runtimeAlert.tone}
                    role="dialog"
                    aria-labelledby="photo-runtime-alert-title"
                  >
                    <div className="photo-runtime-alert-heading">
                      <strong id="photo-runtime-alert-title">{t("workspace.photos.runtimeAlertTitle")}</strong>
                      <button
                        type="button"
                        onClick={() => {
                          setRuntimeAlertOpen(false);
                          runtimeAlertTriggerRef.current?.focus();
                        }}
                        title={t("workspace.photos.closeRuntimeAlert")}
                        aria-label={t("workspace.photos.closeRuntimeAlert")}
                      >
                        <X aria-hidden="true" size={14} />
                      </button>
                    </div>
                    <p>{runtimeAlert.error ?? t("workspace.photos.runtimeAlertFallback")}</p>
                    <dl>
                      <div>
                        <dt>{t("workspace.photos.runtimeAlertState")}</dt>
                        <dd>{t(`settings.photos.states.${runtimeAlert.state}`)}</dd>
                      </div>
                      <div>
                        <dt>{t("workspace.photos.runtimeAlertWorker")}</dt>
                        <dd>{t(`settings.photos.workerStates.${runtimeAlert.workerStatus}`)}</dd>
                      </div>
                      {runtimeAlert.errorCode ? (
                        <div>
                          <dt>{t("workspace.photos.runtimeAlertCode")}</dt>
                          <dd><code>{runtimeAlert.errorCode}</code></dd>
                        </div>
                      ) : null}
                      {runtimeAlert.nextRetryAt ? (
                        <div>
                          <dt>{t("workspace.photos.runtimeAlertRetry")}</dt>
                          <dd>{retryCountdown(runtimeAlert.nextRetryAt, clock)}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                ) : null}
              </div>
            ) : null}
            <PhotoSearchFilterMenu
              filters={filters}
              facets={facets}
              metadataFields={metadataFields}
              onApply={applyFilters}
            />
            {photos.length ? (
              <button
                type="button"
                className="photo-select-loaded"
                onClick={selectAllLoaded}
                aria-pressed={selectedIds.size === photos.length}
                title={t("workspace.photos.selectLoaded")}
                aria-label={t("workspace.photos.selectLoaded")}
              >
                {selectedIds.size === photos.length ? <CheckSquare aria-hidden="true" size={15} /> : <Square aria-hidden="true" size={15} />}
              </button>
            ) : null}
          </div>
          {selected.length ? (
            <div className="photo-selection-actions" aria-label={t("workspace.photos.selectionActions")}>
              <span>{t("workspace.photos.selected", { count: selected.length })}</span>
              <button type="button" onClick={() => void downloadSelection()} disabled={Boolean(busyAction)} title={t("workspace.photos.downloadSelected")} aria-label={t("workspace.photos.downloadSelected")}>
                <Download aria-hidden="true" size={15} /><span>{t("workspace.photos.downloadSelected")}</span>
              </button>
              <button type="button" onClick={() => setPicker("move")} disabled={Boolean(busyAction)} title={t("workspace.photos.moveSelected")} aria-label={t("workspace.photos.moveSelected")}>
                <FolderInput aria-hidden="true" size={15} /><span>{t("workspace.photos.moveSelected")}</span>
              </button>
              <button ref={deleteTriggerRef} className="is-danger" type="button" onClick={() => setDeleteOpen(true)} disabled={Boolean(busyAction)} title={t("workspace.photos.deleteSelected")} aria-label={t("workspace.photos.deleteSelected")}>
                <Trash2 aria-hidden="true" size={15} /><span>{t("workspace.photos.deleteSelected")}</span>
              </button>
              <button type="button" onClick={() => setSelectedIds(new Set())} title={t("workspace.photos.clearSelection")} aria-label={t("workspace.photos.clearSelection")}>
                <X aria-hidden="true" size={15} />
              </button>
            </div>
          ) : null}
          <div className="photo-query-summary"><span>{t("workspace.photos.resultCount", { count: total })}</span>{status?.metadataIndex?.pending ? <span>{t("workspace.photos.metadataProgress", { indexed: status.metadataIndex.indexed, total: status.metadataIndex.total })}</span> : null}</div>
        </div>
      ) : null}

      <div ref={libraryContentRef} className="photo-library-content">
        {dropActive ? (
          <div className="workspace-drop-overlay" role="presentation" aria-hidden="true">
            <div className="workspace-drop-panel">
              <Images aria-hidden="true" size={22} />
              <strong>{t("workspace.photos.dropTitle")}</strong>
              <p>{t("workspace.photos.dropBody")}</p>
            </div>
          </div>
        ) : null}

        {loadMode === "loading" ? (
          <PhotoTimelineSkeleton />
        ) : loadMode === "error" ? (
          <div className="workspace-empty-state" role="alert"><ImageOff aria-hidden="true" size={28} /><strong>{t("workspace.photos.loadFailed")}</strong><p>{loadError}</p><button className="secondary-button" type="button" onClick={() => void loadLibrary()}>{t("common.actions.refresh")}</button></div>
        ) : !settings ? (
          <PhotoLibraryEmptyState onConfigure={onOpenSettings} />
        ) : view === "map" ? (
          <PhotoMapView
            filters={queryFilters}
            onOpenAsset={openMapAsset}
            onSearchBounds={(nextBounds) => updateFilter("location", nextBounds)}
            onError={(message) => onNotifyError(message)}
          />
        ) : photos.length === 0 ? (
          <div className="workspace-empty-state photo-library-empty" role="status">
            {statusBusy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={30} /> : <ImageOff aria-hidden="true" size={30} />}
            <strong>{statusBusy ? t("workspace.photos.scanningTitle") : t("workspace.photos.emptyTitle")}</strong>
            <p>{statusBusy ? t("workspace.photos.scanningBody", { count: status?.scanned ?? 0 }) : t("workspace.photos.emptyBody")}</p>
          </div>
        ) : (
          <div className="photo-timeline">
            {groupedPhotos.map((group) => (
              <section className="photo-day" key={group.key} aria-labelledby={`photo-day-${group.key}`}>
                <header><h3 id={`photo-day-${group.key}`}>{group.label}</h3><span>{formatLocaleNumber(group.photos.length, locale)}</span></header>
                <div className="photo-wall">
                  {group.photos.map((photo) => {
                    const isSelected = selectedIds.has(photo.id);
                    const mediaKind = photoMediaKindForAsset(photo);
                    const aspectRatio = photoAspectRatio(photo.width, photo.height);
                    return (
                      <article className={`photo-tile${isSelected ? " is-selected" : ""}`} key={photo.id} style={{ aspectRatio }}>
                        <button className="photo-open" type="button" onClick={(event) => openLightbox(photo, event.currentTarget)} aria-label={t("workspace.photos.openPhoto", { name: photo.name })}>
                          <img
                            src={`/api/photos/${encodeURIComponent(photo.id)}/thumbnail`}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            width={photo.width && photo.width > 0 ? photo.width : 1}
                            height={photo.height && photo.height > 0 ? photo.height : 1}
                          />
                          {mediaKind === "video" ? <span className="photo-media-badge is-video" aria-hidden="true"><Play size={13} fill="currentColor" /></span> : null}
                          {mediaKind === "raw" ? <span className="photo-media-badge is-raw" aria-hidden="true">RAW</span> : null}
                          <span className="photo-name">{photo.name}</span>
                        </button>
                        <button className="photo-select" type="button" aria-pressed={isSelected} onClick={() => toggleSelection(photo.id)} aria-label={isSelected ? t("workspace.photos.deselectPhoto", { name: photo.name }) : t("workspace.photos.selectPhoto", { name: photo.name })}>
                          {isSelected ? <Check aria-hidden="true" size={14} /> : <span aria-hidden="true" />}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
            {nextCursor || paginationError ? (
              <div ref={loadMoreSentinelRef} className="photo-pagination-sentinel" aria-live="polite">
                {paginationError ? (
                  <div className="photo-pagination-error" role="alert">
                    <span title={paginationError}>{t("workspace.photos.loadMoreFailed")}</span>
                    <button className="secondary-button" type="button" onClick={() => void loadMore()}>{t("workspace.photos.retryLoadMore")}</button>
                  </div>
                ) : loadingMore ? (
                  <span role="status"><LoaderCircle className="is-spinning" aria-hidden="true" size={15} />{t("workspace.photos.loadingMore")}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {picker === "move" && settings ? (
        <StorageFilePickerDialog
          pools={movePools}
          initialPoolId={settings.storagePoolId}
          initialPath={settings.path}
          boundaryPath={settings.path}
          locale={locale}
          mode="directory"
          directoryPurpose="photoMove"
          onCancel={() => setPicker(null)}
          onSelect={(selection) => void applyBatch("move", selection.path)}
          {...(onRequestCreateFolder ? { onRequestCreateFolder } : {})}
        />
      ) : null}

      {deleteOpen ? (
        <ModalPortal className="file-action-backdrop" role="presentation">
          <div
            ref={deleteDialogRef}
            className="file-action-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="photo-delete-title"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busyAction) {
                event.preventDefault();
                setDeleteOpen(false);
              } else if (event.key === "Tab") {
                trapDialogFocus(event, deleteDialogRef.current);
              }
            }}
          >
            <header><span className="eyebrow">{t("workspace.photos.deleteSelected")}</span><h2 id="photo-delete-title">{t("workspace.photos.deleteTitle", { count: selected.length })}</h2></header>
            <p>{t("workspace.photos.deleteBody")}</p>
            <div className="file-action-actions"><button type="button" onClick={() => setDeleteOpen(false)} disabled={Boolean(busyAction)}>{t("common.actions.cancel")}</button><button className="danger-button" type="button" onClick={() => void applyBatch("trash")} disabled={Boolean(busyAction)} aria-busy={busyAction === "trash" || undefined}>{t("workspace.photos.requestDelete")}</button></div>
          </div>
        </ModalPortal>
      ) : null}

      {lightboxPhoto ? (
        <ModalPortal className="photo-lightbox-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && setLightboxId(null)}>
          <div ref={lightboxRef} className="photo-lightbox" role="dialog" aria-modal="true" aria-labelledby="photo-lightbox-title" tabIndex={-1} onKeyDown={handleLightboxKeyDown}>
            <header className="photo-lightbox-header">
              <div><span className="eyebrow">{t("workspace.photos.viewer")}</span><h2 id="photo-lightbox-title">{lightboxPhoto.name}</h2></div>
              <div className="photo-lightbox-tools">
                {lightboxMediaKind !== "video" ? <>
                  <button type="button" onClick={() => setZoom((current) => Math.max(1, current - 0.5))} disabled={zoom <= 1} title={t("workspace.photos.zoomOut")} aria-label={t("workspace.photos.zoomOut")}><Minus aria-hidden="true" size={17} /></button>
                  <button type="button" onClick={() => setZoom(1)} title={t("workspace.photos.resetZoom")} aria-label={t("workspace.photos.resetZoom")}><Maximize2 aria-hidden="true" size={17} /><span>{Math.round(zoom * 100)}%</span></button>
                  <button type="button" onClick={() => setZoom((current) => Math.min(4, current + 0.5))} disabled={zoom >= 4} title={t("workspace.photos.zoomIn")} aria-label={t("workspace.photos.zoomIn")}><Plus aria-hidden="true" size={17} /></button>
                </> : null}
                <button type="button" onClick={() => setLightboxId(null)} title={t("common.actions.close")} aria-label={t("common.actions.close")}><X aria-hidden="true" size={18} /></button>
              </div>
            </header>
            <div className="photo-lightbox-body">
              <button className="photo-lightbox-nav is-previous" type="button" onClick={() => showAdjacent(-1)} disabled={lightboxIndex <= 0} title={t("workspace.photos.previous")} aria-label={t("workspace.photos.previous")}><ChevronLeft aria-hidden="true" size={24} /></button>
              <div className="photo-lightbox-canvas">
                {lightboxMediaKind === "video" ? (
                  <video
                    className="photo-lightbox-video"
                    src={`/api/photos/${encodeURIComponent(lightboxPhoto.id)}/video`}
                    poster={`/api/photos/${encodeURIComponent(lightboxPhoto.id)}/preview`}
                    controls
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <img src={`/api/photos/${encodeURIComponent(lightboxPhoto.id)}/preview`} alt={lightboxPhoto.name} style={{ width: `${zoom * 100}%` }} />
                )}
              </div>
              <button className="photo-lightbox-nav is-next" type="button" onClick={() => showAdjacent(1)} disabled={lightboxIndex >= photos.length - 1} title={t("workspace.photos.next")} aria-label={t("workspace.photos.next")}><ChevronRight aria-hidden="true" size={24} /></button>
              <aside className="photo-lightbox-meta">
                <dl>
                  <div><dt>{t("workspace.photos.takenAt")}</dt><dd>{formatPhotoDateTime(lightboxPhoto.metadata?.capturedAtLocal ?? lightboxPhoto.takenAt, locale)}</dd></div>
                  <div><dt>{t("workspace.photos.dimensions")}</dt><dd>{lightboxPhoto.width && lightboxPhoto.height ? `${lightboxPhoto.width} × ${lightboxPhoto.height}` : t("common.states.unknown")}</dd></div>
                  <div><dt>{t("workspace.photos.fileSize")}</dt><dd>{formatBytes(lightboxPhoto.sizeBytes, locale)}</dd></div>
                  <div><dt>{t("workspace.photos.format")}</dt><dd>{lightboxPhoto.mimeType}</dd></div>
                  <div><dt>{t("workspace.photos.path")}</dt><dd title={lightboxPhoto.path}>{lightboxPhoto.path}</dd></div>
                  {lightboxPhoto.metadata?.cameraModel ? <div><dt>{t("workspace.photos.camera")}</dt><dd>{lightboxPhoto.metadata.cameraModel}</dd></div> : null}
                  {lightboxPhoto.metadata?.lensModel ? <div><dt>{t("workspace.photos.lens")}</dt><dd>{lightboxPhoto.metadata.lensModel}</dd></div> : null}
                  {lightboxPhoto.metadata?.iso ? <div><dt>ISO</dt><dd>{lightboxPhoto.metadata.iso}</dd></div> : null}
                  {lightboxPhoto.metadata?.aperture ? <div><dt>{t("workspace.photos.aperture")}</dt><dd>f/{lightboxPhoto.metadata.aperture}</dd></div> : null}
                  {lightboxPhoto.metadata?.exposureTimeSeconds ? <div><dt>{t("workspace.photos.shutter")}</dt><dd>{formatExposure(lightboxPhoto.metadata.exposureTimeSeconds)}</dd></div> : null}
                  {lightboxPhoto.metadata?.focalLengthMm ? <div><dt>{t("workspace.photos.focalLength")}</dt><dd>{lightboxPhoto.metadata.focalLengthMm} mm</dd></div> : null}
                </dl>
                <section className="photo-metadata-inspector">
                  <header><strong>{t("workspace.photos.metadata")}</strong>{metadataLoading ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : null}</header>
                  {metadata?.warnings.length ? <div className="photo-metadata-warnings">{metadata.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
                  {Object.entries(metadata?.groups ?? {}).map(([source, entries]) => (
                    <details key={source}>
                      <summary>{source}<span>{Object.keys(entries).length}</span></summary>
                      <dl>{Object.entries(entries).map(([key, values]) => <div key={key}><dt>{key}</dt><dd>{values.join(", ")}</dd></div>)}</dl>
                    </details>
                  ))}
                  {metadata?.sensitiveOmitted && !sensitiveRevealed ? <button type="button" className="photo-reveal-sensitive" onClick={() => void revealSensitiveMetadata()} disabled={metadataLoading}><SlidersHorizontal aria-hidden="true" size={14} />{t("workspace.photos.revealSensitive")}</button> : null}
                  {Object.entries(metadata?.sensitiveGroups ?? {}).map(([source, entries]) => (
                    <details className="is-sensitive" key={source}>
                      <summary>{source}<span>{Object.keys(entries).length}</span></summary>
                      <dl>{Object.entries(entries).map(([key, values]) => <div key={key}><dt>{key}</dt><dd>{values.join(", ")}</dd></div>)}</dl>
                    </details>
                  ))}
                </section>
                <a className="secondary-button" href={`/api/photos/${encodeURIComponent(lightboxPhoto.id)}/original?download=1`} download={lightboxPhoto.name}><Download aria-hidden="true" size={15} />{t("workspace.photos.downloadOriginal")}</a>
              </aside>
            </div>
          </div>
        </ModalPortal>
      ) : null}
    </section>
  );
}

export function PhotoLibraryEmptyState({ onConfigure }: { onConfigure: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="workspace-empty-state photo-library-empty" role="status">
      <Images aria-hidden="true" size={34} />
      <strong>{t("workspace.photos.unconfiguredTitle")}</strong>
      <p>{t("workspace.photos.unconfiguredBody")}</p>
      <button className="primary-button" type="button" onClick={onConfigure}>
        <SlidersHorizontal aria-hidden="true" size={15} />
        <span>{t("workspace.photos.configure")}</span>
      </button>
    </div>
  );
}

export function photoLibraryLoadMode(
  initialLoadComplete: boolean,
  hasLoadedSnapshot: boolean,
  loadError: string | null
): "loading" | "error" | "content" {
  if (!initialLoadComplete) return "loading";
  if (loadError && !hasLoadedSnapshot) return "error";
  return "content";
}

function PhotoQuerySkeleton() {
  return (
    <div className="photo-query-panel photo-query-panel-skeleton" aria-hidden="true">
      <div className="photo-query-toolbar photo-query-toolbar-skeleton">
        <SkeletonBlock className="photo-skeleton-search" />
        <SkeletonBlock className="photo-skeleton-view" />
        <SkeletonBlock className="photo-skeleton-sort" />
        <SkeletonBlock className="photo-skeleton-advanced" />
      </div>
      <div className="photo-query-summary photo-query-summary-skeleton">
        <SkeletonBlock width="72px" />
      </div>
    </div>
  );
}

function PhotoTimelineSkeleton() {
  return (
    <div className="photo-timeline photo-timeline-skeleton" aria-hidden="true">
      {Array.from({ length: 2 }, (_, groupIndex) => (
        <section className="photo-day" key={groupIndex}>
          <header>
            <SkeletonBlock width={groupIndex === 0 ? "128px" : "104px"} />
            <SkeletonBlock width="24px" />
          </header>
          <div className="photo-wall photo-skeleton-wall">
            {Array.from({ length: groupIndex === 0 ? 10 : 6 }, (_, tileIndex) => (
              <SkeletonBlock className="photo-skeleton-tile" key={tileIndex} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function groupPhotosByDate<T extends PhotoAsset & {
  metadata?: { capturedAtLocal?: string | null } | null;
}>(assets: T[], locale: SupportedLocale) {
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
  const groups: Array<{ key: string; label: string; photos: T[] }> = [];
  for (const asset of assets) {
    const localCaptureDate = localCalendarDate(asset.metadata?.capturedAtLocal);
    const takenAt = new Date(asset.takenAt);
    const validDate = localCaptureDate ?? (Number.isFinite(takenAt.getTime()) ? takenAt : new Date(asset.mtimeMs));
    const key = localCaptureDate
      ? asset.metadata!.capturedAtLocal!.slice(0, 10)
      : [validDate.getFullYear(), String(validDate.getMonth() + 1).padStart(2, "0"), String(validDate.getDate()).padStart(2, "0")].join("-");
    const previous = groups.at(-1);
    if (previous?.key === key) previous.photos.push(asset);
    else groups.push({ key, label: formatter.format(validDate), photos: [asset] });
  }
  return groups;
}

export function isPhotoBusy(state: PhotoLibraryStatus["state"] | undefined): boolean {
  return state === "queued" || state === "discovering" || state === "processing" || state === "retrying";
}

export function photoRuntimeAlert(
  status: PhotoLibraryStatus | null,
  workerHealth: PhotoWorkerHealth | null
): {
  tone: "warning" | "danger";
  state: PhotoLibraryStatus["state"];
  workerStatus: PhotoWorkerHealth["status"];
  error: string | null;
  errorCode: PhotoLibraryStatus["errorCode"];
  nextRetryAt: string | null;
} | null {
  const hasRuntimeProblem = status?.state === "degraded" || status?.state === "offline" ||
    Boolean(status?.errorCode) || (workerHealth !== null && workerHealth.status !== "ready");
  if (!hasRuntimeProblem) return null;
  const state = status?.state ?? "offline";
  const workerStatus = workerHealth?.status ?? "unavailable";
  return {
    tone: state === "offline" || workerStatus === "unavailable" ? "danger" : "warning",
    state,
    workerStatus,
    error: status?.error ?? null,
    errorCode: status?.errorCode ?? null,
    nextRetryAt: status?.nextRetryAt ?? null
  };
}

export function photoAspectRatio(width: number | null, height: number | null): number {
  return width !== null && height !== null && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : 1;
}

export function shouldAutoLoadPhotos({
  view,
  nextCursor,
  loadingMore,
  paginationError
}: {
  view: "timeline" | "map";
  nextCursor: string | null;
  loadingMore: boolean;
  paginationError: string | null;
}): boolean {
  return view === "timeline" && Boolean(nextCursor) && !loadingMore && !paginationError;
}

export function retryCountdown(nextRetryAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(nextRetryAt) - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function localCalendarDate(value: string | null | undefined): Date | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function photoMediaKindForAsset(photo: Pick<PhotoAsset, "name" | "mimeType">): PhotoMediaKind {
  return photoMediaKind(photo.name) ?? (photo.mimeType.startsWith("video/") ? "video" : "image");
}

function samePhotoMetadataFields(left: PhotoMetadataField[], right: PhotoMetadataField[]): boolean {
  return left.length === right.length && left.every((field, index) => {
    const other = right[index];
    return other !== undefined && field.key === other.key && field.valueType === other.valueType &&
      field.count === other.count && field.sensitive === other.sensitive;
  });
}

export function readyPhotoQueryFilters(
  filters: PhotoQueryFilters,
  metadataFields: PhotoMetadataField[] = []
): PhotoQueryFilters {
  const advanced = filters.advanced;
  if (!advanced) return filters;
  const conditions: PhotoMetadataCondition[] = [];
  for (const condition of advanced.conditions) {
    if (condition.operator === "exists" || condition.operator === "not_exists") {
      conditions.push(condition);
      continue;
    }
    const values = Array.isArray(condition.value) ? condition.value : [condition.value];
    if (!values.length || values.some((value) => value === undefined || String(value).trim() === "")) continue;
    if (condition.operator === "between" && (condition.valueTo === undefined || String(condition.valueTo).trim() === "")) continue;
    const valueType = metadataFields.find((field) => field.key === condition.key)?.valueType;
    const coercedValues = values.map((value) => value === undefined ? undefined : coerceMetadataScalar(value, valueType));
    if (coercedValues.some((value) => value === undefined)) continue;
    const valueTo = condition.valueTo === undefined ? undefined : coerceMetadataScalar(condition.valueTo, valueType);
    if (condition.valueTo !== undefined && valueTo === undefined) continue;
    const nextCondition: PhotoMetadataCondition = {
      ...condition,
      value: Array.isArray(condition.value)
        ? coercedValues as Array<string | number | boolean>
        : coercedValues[0] as string | number | boolean
    };
    if (valueTo !== undefined && typeof valueTo !== "boolean") nextCondition.valueTo = valueTo;
    conditions.push(nextCondition);
  }
  if (!conditions.length) {
    const { advanced: _advanced, ...rest } = filters;
    return rest;
  }
  return { ...filters, advanced: { ...advanced, conditions } };
}

function coerceMetadataScalar(
  value: string | number | boolean,
  valueType: PhotoMetadataField["valueType"] | undefined
): string | number | boolean | undefined {
  if (valueType === "number") {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (valueType === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    return undefined;
  }
  return value;
}

export function mergePhotos(current: PhotoQueryAsset[], incoming: PhotoQueryAsset[]): PhotoQueryAsset[] {
  const ids = new Set(current.map((photo) => photo.id));
  return [...current, ...incoming.filter((photo) => !ids.has(photo.id))];
}

function formatExposure(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(seconds % 1 ? 1 : 0)} s`;
  return `1/${Math.max(1, Math.round(1 / seconds))} s`;
}

function formatPhotoDateTime(value: string, locale: SupportedLocale): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

function hasFileDrag(event: DragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

function trapDialogFocus(event: KeyboardEvent<HTMLDivElement>, dialog: HTMLDivElement | null) {
  const focusable = [...(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') ?? [])]
    .filter((element) => element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    dialog?.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
