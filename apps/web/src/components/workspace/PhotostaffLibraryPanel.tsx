import {
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
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
  type KeyboardEvent
} from "react";
import { useTranslation } from "react-i18next";
import {
  createPhotostaffExport,
  getPhotostaffMetadata,
  getPhotostaffMetadataFields,
  getPhotostaffRecord,
  getPhotostaffLibrarySettings,
  getPhotostaffStatus,
  proposePhotostaffOperation,
  queryPhotostaff,
  requestPhotostaffScan,
  uploadPhotostaff,
  type PhotostaffAsset,
  type PhotostaffMetadataDetail,
  type PhotostaffMetadataField,
  type PhotostaffQueryAsset,
  type PhotostaffLibrarySettings,
  type PhotostaffLibraryStatus,
  type PhotostaffWorkerHealth
} from "../../api.js";
import {
  PHOTOSTAFF_UPLOAD_EXTENSIONS,
  PHOTOSTAFF_XMP_EXTENSION,
  photostaffExtension,
  photostaffMediaKind,
  type PhotostaffMediaKind
} from "@sigmaos/shared/photostaff-config";
import type {
  PhotostaffMetadataCondition,
  PhotostaffQueryFacets,
  PhotostaffQueryFilters,
  PhotostaffQuerySortField
} from "@sigmaos/shared";
import { formatBytes, formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";
import {
  StorageFilePickerDialog,
  type StorageFilePickerPool
} from "./StorageFilePickerDialog.js";
import { PhotostaffMapView } from "./PhotostaffMapView.js";

export const PHOTOSTAFF_ACCEPT = PHOTOSTAFF_UPLOAD_EXTENSIONS.join(",");

export function PhotostaffLibraryPanel({
  pools,
  selectedRootId,
  sessionId,
  approvalRefreshKey,
  locale,
  onRequestCreateFolder,
  onWorkQueuesChanged,
  onNotifyError,
  onNotifySuccess,
  onNotifyWarning
}: {
  pools: StorageFilePickerPool[];
  selectedRootId: string;
  sessionId: string | null;
  approvalRefreshKey: string;
  locale: SupportedLocale;
  onRequestCreateFolder?: (input: {
    rootId: string;
    storagePoolId: string;
    parentPath: string;
    name: string;
  }) => Promise<void>;
  onWorkQueuesChanged: () => void | Promise<void>;
  onNotifyError: (message: string | null) => void;
  onNotifySuccess: (message: string | null) => void;
  onNotifyWarning: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PhotostaffLibrarySettings | null>(null);
  const [status, setStatus] = useState<PhotostaffLibraryStatus | null>(null);
  const [workerHealth, setWorkerHealth] = useState<PhotostaffWorkerHealth | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [photostaff, setPhotostaff] = useState<PhotostaffQueryAsset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<PhotostaffQueryFacets | null>(null);
  const [filters, setFilters] = useState<PhotostaffQueryFilters>({});
  const [sortField, setSortField] = useState<PhotostaffQuerySortField>("captured_at");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [view, setView] = useState<"timeline" | "map">("timeline");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [metadataFields, setMetadataFields] = useState<PhotostaffMetadataField[]>([]);
  const [metadata, setMetadata] = useState<PhotostaffMetadataDetail | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [sensitiveRevealed, setSensitiveRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"move" | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);
  const lightboxTriggerRef = useRef<HTMLElement | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dragDepthRef = useRef(0);
  const timelineRequestRef = useRef(0);
  const metadataRequestRef = useRef(0);

  const configuredPool = pools.find((pool) => pool.id === settings?.storagePoolId) ?? null;
  const selected = photostaff.filter((photostaff) => selectedIds.has(photostaff.id));
  const groupedPhotostaff = useMemo(() => groupPhotostaffByDate(photostaff, locale), [locale, photostaff]);
  const lightboxIndex = lightboxId ? photostaff.findIndex((photostaff) => photostaff.id === lightboxId) : -1;
  const lightboxPhotostaff = lightboxIndex >= 0 ? photostaff[lightboxIndex] ?? null : null;
  const lightboxMediaKind = lightboxPhotostaff ? photostaffMediaKindForAsset(lightboxPhotostaff) : null;
  const canPropose = Boolean(sessionId && settings?.rootId === selectedRootId);
  const statusBusy = isPhotostaffBusy(status?.state);
  const queryFilters = useMemo(() => readyPhotostaffQueryFilters(filters, metadataFields), [filters, metadataFields]);

  const loadTimeline = useCallback(async (cursor: string | null = null) => {
    const requestId = cursor ? timelineRequestRef.current : ++timelineRequestRef.current;
    const page = await queryPhotostaff({
      filters: queryFilters,
      sort: { field: sortField, direction: sortDirection },
      cursor,
      limit: 60,
      includeFacets: !cursor
    });
    if (requestId !== timelineRequestRef.current) return;
    setPhotostaff((current) => cursor ? mergePhotostaff(current, page.photostaff) : page.photostaff);
    setNextCursor(page.nextCursor);
    setTotal(page.total);
    if (!cursor) setFacets(page.facets);
  }, [queryFilters, sortDirection, sortField]);

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextSettings, snapshot] = await Promise.all([
        getPhotostaffLibrarySettings(),
        getPhotostaffStatus()
      ]);
      setSettings(nextSettings);
      setStatus(snapshot.status);
      setWorkerHealth(snapshot.workerHealth);
      if (nextSettings) {
        const [, fields] = await Promise.all([loadTimeline(), getPhotostaffMetadataFields()]);
        setMetadataFields((current) => samePhotostaffMetadataFields(current, fields) ? current : fields);
      }
      else {
        setPhotostaff([]);
        setNextCursor(null);
        setTotal(0);
        setFacets(null);
      }
    } catch (error) {
      const message = errorMessage(error);
      setLoadError(message);
      onNotifyError(message);
    } finally {
      setLoading(false);
    }
  }, [loadTimeline, onNotifyError]);

  useEffect(() => {
    void loadLibrary();
  }, [approvalRefreshKey, loadLibrary]);

  useEffect(() => {
    if (!settings) return undefined;
    let active = true;
    let timer: number | null = null;
    const poll = async (): Promise<void> => {
      let nextBusy = statusBusy;
      try {
        const snapshot = await getPhotostaffStatus();
        if (!active) return;
        nextBusy = isPhotostaffBusy(snapshot.status.state);
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
    setSelectedIds((current) => new Set([...current].filter((id) => photostaff.some((photostaff) => photostaff.id === id))));
  }, [photostaff]);

  useEffect(() => {
    if (!lightboxPhotostaff) return undefined;
    const previouslyFocused = lightboxTriggerRef.current;
    const frame = window.requestAnimationFrame(() => lightboxRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previouslyFocused?.isConnected) window.requestAnimationFrame(() => previouslyFocused.focus());
    };
  }, [lightboxPhotostaff]);

  useEffect(() => {
    const requestId = ++metadataRequestRef.current;
    if (!lightboxPhotostaff) {
      setMetadata(null);
      setSensitiveRevealed(false);
      return undefined;
    }
    let active = true;
    setMetadataLoading(true);
    setMetadata(null);
    setSensitiveRevealed(false);
    void getPhotostaffMetadata(lightboxPhotostaff.id).then((detail) => {
      if (active && requestId === metadataRequestRef.current) setMetadata(detail);
    }).catch((error) => {
      if (active) onNotifyError(errorMessage(error));
    }).finally(() => {
      if (active && requestId === metadataRequestRef.current) setMetadataLoading(false);
    });
    return () => { active = false; };
  }, [lightboxPhotostaff, onNotifyError]);

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
      await requestPhotostaffScan();
      const snapshot = await getPhotostaffStatus();
      setStatus(snapshot.status);
      setWorkerHealth(snapshot.workerHealth);
      onNotifySuccess(t("workspace.photostaff.scanQueued"));
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await loadTimeline(nextCursor);
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }

  async function uploadFiles(files: File[]) {
    if (!settings || !files.length || busyAction) return;
    const supported = files
      .filter((file) => photostaffMediaKind(file.name) !== null || photostaffExtension(file.name) === PHOTOSTAFF_XMP_EXTENSION)
      .sort((left, right) => Number(photostaffExtension(left.name) === PHOTOSTAFF_XMP_EXTENSION) - Number(photostaffExtension(right.name) === PHOTOSTAFF_XMP_EXTENSION));
    if (!supported.length) {
      onNotifyWarning(t("workspace.photostaff.unsupportedUpload"));
      return;
    }
    setBusyAction("upload");
    let completed = 0;
    const failures: string[] = [];
    for (const file of supported) {
      try {
        await uploadPhotostaff(file, settings.path);
        completed += 1;
      } catch (error) {
        failures.push(`${file.name}: ${errorMessage(error)}`);
      }
    }
    if (completed) onNotifySuccess(t("workspace.photostaff.uploaded", { count: completed }));
    if (failures.length) onNotifyWarning(failures.slice(0, 3).join("\n"));
    try {
      const snapshot = await getPhotostaffStatus();
      setStatus(snapshot.status);
      setWorkerHealth(snapshot.workerHealth);
      if (!isPhotostaffBusy(snapshot.status.state)) await loadTimeline();
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
    setSelectedIds(selectedIds.size === photostaff.length ? new Set() : new Set(photostaff.map((photostaff) => photostaff.id)));
  }

  function openLightbox(photostaff: PhotostaffQueryAsset, trigger: HTMLElement) {
    lightboxTriggerRef.current = trigger;
    setZoom(1);
    setLightboxId(photostaff.id);
  }

  async function openMapAsset(assetId: string) {
    let asset = photostaff.find((candidate) => candidate.id === assetId);
    if (!asset) {
      try {
        asset = await getPhotostaffRecord(assetId);
        setPhotostaff((current) => mergePhotostaff(current, [asset!]));
      } catch (error) {
        onNotifyError(errorMessage(error));
        return;
      }
    }
    openLightbox(asset, document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
  }

  async function revealSensitiveMetadata() {
    if (!lightboxPhotostaff || metadataLoading) return;
    const requestId = ++metadataRequestRef.current;
    setMetadataLoading(true);
    try {
      const detail = await getPhotostaffMetadata(lightboxPhotostaff.id, true);
      if (requestId !== metadataRequestRef.current) return;
      setMetadata(detail);
      setSensitiveRevealed(true);
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      if (requestId === metadataRequestRef.current) setMetadataLoading(false);
    }
  }

  function updateFilter<K extends keyof PhotostaffQueryFilters>(key: K, value: PhotostaffQueryFilters[K]) {
    setFilters((current) => {
      const next = { ...current, [key]: value };
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete next[key];
      return next;
    });
    setSelectedIds(new Set());
  }

  function updateAdvancedCondition(index: number, patch: Partial<PhotostaffMetadataCondition>) {
    const advanced = filters.advanced ?? { mode: "all" as const, conditions: [] };
    updateFilter("advanced", {
      ...advanced,
      conditions: advanced.conditions.map((condition, conditionIndex) => conditionIndex === index
        ? { ...condition, ...patch }
        : condition)
    });
  }

  function addAdvancedCondition() {
    const advanced = filters.advanced ?? { mode: "all" as const, conditions: [] };
    const firstField = metadataFields[0]?.key ?? "exif.ISO";
    updateFilter("advanced", {
      ...advanced,
      conditions: [...advanced.conditions, { key: firstField, operator: "eq", value: "" }]
    });
    setAdvancedOpen(true);
  }

  function showAdjacent(offset: number) {
    const next = photostaff[lightboxIndex + offset];
    if (!next) return;
    setZoom(1);
    setLightboxId(next.id);
  }

  async function downloadSelection() {
    if (!selected.length || busyAction) return;
    setBusyAction("download");
    try {
      const result = await createPhotostaffExport(selected.map((photostaff) => photostaff.id));
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.download = selected.length === 1 ? selected[0]!.name : "sigmaos-photostaff.zip";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      onNotifyError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function proposeBatch(operation: "move" | "trash", targetDirectory?: string) {
    if (!sessionId || !selected.length || busyAction) return;
    setBusyAction(operation);
    try {
      await proposePhotostaffOperation({
        sessionId,
        assetIds: selected.map((photostaff) => photostaff.id),
        operation,
        ...(targetDirectory ? { targetDirectory } : {})
      });
      setPicker(null);
      setDeleteOpen(false);
      setSelectedIds(new Set());
      await onWorkQueuesChanged();
      onNotifyWarning(t("workspace.photostaff.approvalQueued"));
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

  return (
    <section
      className={`photostaff-library${dropActive ? " is-drop-active" : ""}`}
      aria-label={t("workspace.photostaff.title")}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={uploadInputRef}
        className="workspace-upload-input"
        type="file"
        accept={PHOTOSTAFF_ACCEPT}
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleUploadChange}
      />

      <PanelHeader
        className="photostaff-library-header"
        icon={<Images aria-hidden="true" size={20} />}
        title={t("workspace.photostaff.title")}
        subtitle={t("workspace.photostaff.description")}
        actions={<PanelHeaderActions label={t("workspace.photostaff.actions")} className="photostaff-library-actions">
          <PanelHeaderAction
            label={t("workspace.photostaff.scanNow")}
            type="button"
            onClick={() => void startScan()}
            disabled={!settings || Boolean(busyAction) || statusBusy}
          >
            <ScanLine aria-hidden="true" size={17} />
          </PanelHeaderAction>
          <PanelHeaderAction
            label={t("workspace.photostaff.upload")}
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

      {settings ? (
        <div className="photostaff-library-bar">
          <div className="photostaff-library-location" title={settings.path}>
            <FolderInput aria-hidden="true" size={15} />
            <strong>{configuredPool?.name ?? settings.storagePoolId}</strong>
            <span>{settings.path}</span>
          </div>
          <div className="photostaff-runtime-status" data-state={workerHealth?.status ?? "unavailable"}>
            {statusBusy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={13} /> : null}
            <strong>{t(`settings.photostaff.states.${status?.state ?? "offline"}`)}</strong>
            {status?.phase ? <span>{t(`settings.photostaff.phases.${status.phase}`)}</span> : null}
            <span>{t(`settings.photostaff.workerStates.${workerHealth?.status ?? "unavailable"}`)}</span>
            {status?.nextRetryAt ? <span>{t("workspace.photostaff.retryIn", { value: retryCountdown(status.nextRetryAt, clock) })}</span> : null}
            {status?.errorCode ? <code>{status.errorCode}</code> : null}
          </div>
          {selected.length ? (
            <div className="photostaff-selection-actions" aria-label={t("workspace.photostaff.selectionActions")}>
              <span>{t("workspace.photostaff.selected", { count: selected.length })}</span>
              <button type="button" onClick={selectAllLoaded} aria-pressed={selectedIds.size === photostaff.length} title={t("workspace.photostaff.selectAll")} aria-label={t("workspace.photostaff.selectAll")}>
                {selectedIds.size === photostaff.length ? <CheckSquare aria-hidden="true" size={15} /> : <Square aria-hidden="true" size={15} />}
                <span>{t("workspace.photostaff.selectAll")}</span>
              </button>
              <button type="button" onClick={() => void downloadSelection()} disabled={Boolean(busyAction)} title={t("workspace.photostaff.downloadSelected")} aria-label={t("workspace.photostaff.downloadSelected")}>
                <Download aria-hidden="true" size={15} />
                <span>{t("workspace.photostaff.downloadSelected")}</span>
              </button>
              <button type="button" onClick={() => canPropose ? setPicker("move") : onNotifyWarning(t("workspace.photostaff.switchRootForManagement"))} disabled={Boolean(busyAction)} title={t("workspace.photostaff.moveSelected")} aria-label={t("workspace.photostaff.moveSelected")}>
                <FolderInput aria-hidden="true" size={15} />
                <span>{t("workspace.photostaff.moveSelected")}</span>
              </button>
              <button ref={deleteTriggerRef} className="is-danger" type="button" onClick={() => canPropose ? setDeleteOpen(true) : onNotifyWarning(t("workspace.photostaff.switchRootForManagement"))} disabled={Boolean(busyAction)} title={t("workspace.photostaff.deleteSelected")} aria-label={t("workspace.photostaff.deleteSelected")}>
                <Trash2 aria-hidden="true" size={15} />
                <span>{t("workspace.photostaff.deleteSelected")}</span>
              </button>
              <button type="button" onClick={() => setSelectedIds(new Set())} title={t("workspace.photostaff.clearSelection")} aria-label={t("workspace.photostaff.clearSelection")}>
                <X aria-hidden="true" size={15} />
              </button>
            </div>
          ) : photostaff.length ? (
            <button className="photostaff-select-all" type="button" onClick={selectAllLoaded} aria-label={t("workspace.photostaff.selectAll")} title={t("workspace.photostaff.selectAll")}>
              <Square aria-hidden="true" size={15} />
              <span>{t("workspace.photostaff.selectAll")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {settings ? (
        <div className="photostaff-query-panel">
          <div className="photostaff-query-toolbar">
            <label className="photostaff-search-field">
              <Search aria-hidden="true" size={15} />
              <input
                type="search"
                value={filters.text ?? ""}
                onChange={(event) => updateFilter("text", event.target.value)}
                placeholder={t("workspace.photostaff.searchPlaceholder")}
                aria-label={t("workspace.photostaff.searchPlaceholder")}
              />
            </label>
            <div className="photostaff-view-switch" role="tablist" aria-label={t("workspace.photostaff.views")}>
              <button type="button" role="tab" aria-selected={view === "timeline"} onClick={() => setView("timeline")} title={t("workspace.photostaff.timelineView")}>
                <List aria-hidden="true" size={15} /><span>{t("workspace.photostaff.timelineView")}</span>
              </button>
              <button type="button" role="tab" aria-selected={view === "map"} onClick={() => setView("map")} title={t("workspace.photostaff.mapView")}>
                <Map aria-hidden="true" size={15} /><span>{t("workspace.photostaff.mapView")}</span>
              </button>
            </div>
            <label className="photostaff-sort-field">
              <span>{t("workspace.photostaff.sort")}</span>
              <select value={sortField} onChange={(event) => setSortField(event.target.value as PhotostaffQuerySortField)}>
                <option value="captured_at">{t("workspace.photostaff.sortCaptured")}</option>
                <option value="indexed_at">{t("workspace.photostaff.sortIndexed")}</option>
                <option value="name">{t("workspace.photostaff.sortName")}</option>
                <option value="size_bytes">{t("workspace.photostaff.sortSize")}</option>
                <option value="rating">{t("workspace.photostaff.sortRating")}</option>
                {filters.location?.kind === "near" ? <option value="distance">{t("workspace.photostaff.sortDistance")}</option> : null}
              </select>
              <button type="button" onClick={() => setSortDirection((current) => current === "asc" ? "desc" : "asc")} title={t("workspace.photostaff.sortDirection")} aria-label={t("workspace.photostaff.sortDirection")}>
                {sortDirection === "asc" ? "↑" : "↓"}
              </button>
            </label>
            <button type="button" className="photostaff-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
              <SlidersHorizontal aria-hidden="true" size={15} />{t("workspace.photostaff.advanced")}
            </button>
          </div>
          <div className="photostaff-common-filters">
            <PhotostaffFacetSelect
              label={t("workspace.photostaff.mediaType")}
              options={facets?.mediaKinds ?? []}
              selected={filters.mediaKinds ?? []}
              allLabel={t("workspace.photostaff.allValues")}
              selectedLabel={(count) => t("workspace.photostaff.selectedValues", { count })}
              onChange={(value) => updateFilter("mediaKinds", value as PhotostaffMediaKind[])}
            />
            <PhotostaffFacetSelect
              label={t("workspace.photostaff.camera")}
              options={facets?.cameraModels ?? []}
              selected={filters.cameraModels ?? []}
              allLabel={t("workspace.photostaff.allValues")}
              selectedLabel={(count) => t("workspace.photostaff.selectedValues", { count })}
              onChange={(value) => updateFilter("cameraModels", value)}
            />
            <PhotostaffFacetSelect
              label={t("workspace.photostaff.lens")}
              options={facets?.lensModels ?? []}
              selected={filters.lensModels ?? []}
              allLabel={t("workspace.photostaff.allValues")}
              selectedLabel={(count) => t("workspace.photostaff.selectedValues", { count })}
              onChange={(value) => updateFilter("lensModels", value)}
            />
            <label><span>{t("workspace.photostaff.takenAt")}</span><div className="photostaff-range-inputs"><input type="date" value={filters.capturedAt?.from?.slice(0, 10) ?? ""} aria-label={t("workspace.photostaff.min")} onChange={(event) => updateFilter("capturedAt", dateRange(event.target.value, filters.capturedAt?.to))} /><input type="date" value={filters.capturedAt?.to?.slice(0, 10) ?? ""} aria-label={t("workspace.photostaff.max")} onChange={(event) => updateFilter("capturedAt", dateRange(filters.capturedAt?.from, event.target.value))} /></div></label>
            <label><span>ISO</span><div className="photostaff-range-inputs"><input type="number" min="0" value={filters.iso?.min ?? ""} placeholder={t("workspace.photostaff.min")} onChange={(event) => updateFilter("iso", numberRange(event.target.value, filters.iso?.max))} /><input type="number" min="0" value={filters.iso?.max ?? ""} placeholder={t("workspace.photostaff.max")} onChange={(event) => updateFilter("iso", numberRange(filters.iso?.min, event.target.value))} /></div></label>
            <label><span>{t("workspace.photostaff.aperture")}</span><div className="photostaff-range-inputs"><input type="number" min="0" step="0.1" value={filters.aperture?.min ?? ""} placeholder={t("workspace.photostaff.min")} onChange={(event) => updateFilter("aperture", numberRange(event.target.value, filters.aperture?.max))} /><input type="number" min="0" step="0.1" value={filters.aperture?.max ?? ""} placeholder={t("workspace.photostaff.max")} onChange={(event) => updateFilter("aperture", numberRange(filters.aperture?.min, event.target.value))} /></div></label>
            <label><span>{t("workspace.photostaff.shutter")}</span><div className="photostaff-range-inputs"><input type="number" min="0" step="any" value={filters.exposureTimeSeconds?.min ?? ""} placeholder={t("workspace.photostaff.min")} onChange={(event) => updateFilter("exposureTimeSeconds", numberRange(event.target.value, filters.exposureTimeSeconds?.max))} /><input type="number" min="0" step="any" value={filters.exposureTimeSeconds?.max ?? ""} placeholder={t("workspace.photostaff.max")} onChange={(event) => updateFilter("exposureTimeSeconds", numberRange(filters.exposureTimeSeconds?.min, event.target.value))} /></div></label>
            <label><span>{t("workspace.photostaff.focalLength")}</span><div className="photostaff-range-inputs"><input type="number" min="0" value={filters.focalLengthMm?.min ?? ""} placeholder={t("workspace.photostaff.min")} onChange={(event) => updateFilter("focalLengthMm", numberRange(event.target.value, filters.focalLengthMm?.max))} /><input type="number" min="0" value={filters.focalLengthMm?.max ?? ""} placeholder={t("workspace.photostaff.max")} onChange={(event) => updateFilter("focalLengthMm", numberRange(filters.focalLengthMm?.min, event.target.value))} /></div></label>
            <label><span>{t("workspace.photostaff.rating")}</span><select value={filters.rating?.min ?? ""} onChange={(event) => updateFilter("rating", event.target.value ? { min: Number(event.target.value) } : undefined)}><option value="">{t("workspace.photostaff.allValues")}</option>{[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating}+ ({facets?.ratings.find((item) => Number(item.value) === rating)?.count ?? 0})</option>)}</select></label>
            <label className="photostaff-location-filter"><input type="checkbox" checked={filters.hasLocation === true} onChange={(event) => updateFilter("hasLocation", event.target.checked ? true : undefined)} /><span>{t("workspace.photostaff.hasLocation")}</span></label>
          </div>
          {facets?.keywords.length ? (
            <div className="photostaff-keyword-facets" aria-label={t("workspace.photostaff.keywords")}>
              {facets.keywords.slice(0, 12).map((item) => {
                const active = filters.keywords?.includes(item.value) ?? false;
                return <button key={item.value} type="button" aria-pressed={active} onClick={() => updateFilter("keywords", active ? filters.keywords?.filter((value) => value !== item.value) : [...(filters.keywords ?? []), item.value])}>{item.value}<span>{item.count}</span></button>;
              })}
            </div>
          ) : null}
          {advancedOpen ? (
            <div className="photostaff-advanced-builder">
              <div className="photostaff-advanced-heading">
                <div className="photostaff-condition-mode" role="group" aria-label={t("workspace.photostaff.conditionMode")}>
                  <button type="button" aria-pressed={(filters.advanced?.mode ?? "all") === "all"} onClick={() => updateFilter("advanced", { mode: "all", conditions: filters.advanced?.conditions ?? [] })}>{t("workspace.photostaff.matchAll")}</button>
                  <button type="button" aria-pressed={filters.advanced?.mode === "any"} onClick={() => updateFilter("advanced", { mode: "any", conditions: filters.advanced?.conditions ?? [] })}>{t("workspace.photostaff.matchAny")}</button>
                </div>
                <button type="button" onClick={addAdvancedCondition} disabled={!metadataFields.length || (filters.advanced?.conditions.length ?? 0) >= 25}><Plus aria-hidden="true" size={14} />{t("workspace.photostaff.addCondition")}</button>
              </div>
              {(filters.advanced?.conditions ?? []).map((condition, index) => (
                <div className="photostaff-condition-row" key={`${index}:${condition.key}`}>
                  <select className="photostaff-condition-field" value={condition.key} onChange={(event) => updateAdvancedCondition(index, { key: event.target.value })} aria-label={t("workspace.photostaff.metadataField")}>
                    {metadataFields.map((field) => <option key={`${field.key}:${field.valueType}`} value={field.key}>{field.key} ({field.count})</option>)}
                  </select>
                  <select className="photostaff-condition-operator" value={condition.operator} onChange={(event) => updateAdvancedCondition(index, { operator: event.target.value as PhotostaffMetadataCondition["operator"] })} aria-label={t("workspace.photostaff.operator")}>
                    {metadataOperatorOptions(t).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  {condition.operator !== "exists" && condition.operator !== "not_exists" ? <input className="photostaff-condition-value" value={String(Array.isArray(condition.value) ? condition.value.join(",") : condition.value ?? "")} onChange={(event) => updateAdvancedCondition(index, { value: condition.operator === "in" ? event.target.value.split(",").map((value) => value.trim()).filter(Boolean) : event.target.value })} aria-label={t("workspace.photostaff.value")} /> : <span className="photostaff-condition-value" />}
                  {condition.operator === "between" ? <input className="photostaff-condition-value-to" value={String(condition.valueTo ?? "")} onChange={(event) => updateAdvancedCondition(index, { valueTo: event.target.value })} aria-label={t("workspace.photostaff.max")} /> : <span className="photostaff-condition-value-to" />}
                  <button type="button" onClick={() => {
                    const remaining = filters.advanced?.conditions.filter((_, conditionIndex) => conditionIndex !== index) ?? [];
                    updateFilter("advanced", remaining.length ? { mode: filters.advanced?.mode ?? "all", conditions: remaining } : undefined);
                  }} title={t("workspace.photostaff.removeCondition")} aria-label={t("workspace.photostaff.removeCondition")}><X aria-hidden="true" size={14} /></button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="photostaff-query-summary"><span>{t("workspace.photostaff.resultCount", { count: total })}</span>{status?.metadataIndex?.pending ? <span>{t("workspace.photostaff.metadataProgress", { indexed: status.metadataIndex.indexed, total: status.metadataIndex.total })}</span> : null}</div>
        </div>
      ) : null}

      <div className="photostaff-library-content">
        {dropActive ? (
          <div className="workspace-drop-overlay" role="presentation" aria-hidden="true">
            <div className="workspace-drop-panel">
              <Images aria-hidden="true" size={22} />
              <strong>{t("workspace.photostaff.dropTitle")}</strong>
              <p>{t("workspace.photostaff.dropBody")}</p>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="workspace-empty-state" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" size={24} /><strong>{t("workspace.photostaff.loading")}</strong></div>
        ) : loadError ? (
          <div className="workspace-empty-state" role="alert"><ImageOff aria-hidden="true" size={28} /><strong>{t("workspace.photostaff.loadFailed")}</strong><p>{loadError}</p><button className="secondary-button" type="button" onClick={() => void loadLibrary()}>{t("common.actions.refresh")}</button></div>
        ) : !settings ? (
          <div className="workspace-empty-state photostaff-library-empty"><Images aria-hidden="true" size={34} /><strong>{t("workspace.photostaff.unconfiguredTitle")}</strong><p>{t("workspace.photostaff.unconfiguredBody")}</p></div>
        ) : view === "map" ? (
          <PhotostaffMapView
            filters={queryFilters}
            onOpenAsset={openMapAsset}
            onSearchBounds={(nextBounds) => updateFilter("location", nextBounds)}
            onError={(message) => onNotifyError(message)}
          />
        ) : photostaff.length === 0 ? (
          <div className="workspace-empty-state photostaff-library-empty" role="status">
            {statusBusy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={30} /> : <ImageOff aria-hidden="true" size={30} />}
            <strong>{statusBusy ? t("workspace.photostaff.scanningTitle") : t("workspace.photostaff.emptyTitle")}</strong>
            <p>{statusBusy ? t("workspace.photostaff.scanningBody", { count: status?.scanned ?? 0 }) : t("workspace.photostaff.emptyBody")}</p>
          </div>
        ) : (
          <div className="photostaff-timeline">
            {groupedPhotostaff.map((group) => (
              <section className="photostaff-day" key={group.key} aria-labelledby={`photostaff-day-${group.key}`}>
                <header><h3 id={`photostaff-day-${group.key}`}>{group.label}</h3><span>{formatLocaleNumber(group.photostaff.length, locale)}</span></header>
                <div className="photostaff-wall">
                  {group.photostaff.map((photostaff) => {
                    const isSelected = selectedIds.has(photostaff.id);
                    const mediaKind = photostaffMediaKindForAsset(photostaff);
                    return (
                      <article className={`photostaff-tile${isSelected ? " is-selected" : ""}`} key={photostaff.id}>
                        <button className="photostaff-open" type="button" onClick={(event) => openLightbox(photostaff, event.currentTarget)} aria-label={t("workspace.photostaff.openPhotostaff", { name: photostaff.name })}>
                          <img src={`/api/photostaff/${encodeURIComponent(photostaff.id)}/thumbnail`} alt="" loading="lazy" />
                          {mediaKind === "video" ? <span className="photostaff-media-badge is-video" aria-hidden="true"><Play size={13} fill="currentColor" /></span> : null}
                          {mediaKind === "raw" ? <span className="photostaff-media-badge is-raw" aria-hidden="true">RAW</span> : null}
                          <span className="photostaff-name">{photostaff.name}</span>
                        </button>
                        <button className="photostaff-select" type="button" aria-pressed={isSelected} onClick={() => toggleSelection(photostaff.id)} aria-label={isSelected ? t("workspace.photostaff.deselectPhotostaff", { name: photostaff.name }) : t("workspace.photostaff.selectPhotostaff", { name: photostaff.name })}>
                          {isSelected ? <Check aria-hidden="true" size={14} /> : <span aria-hidden="true" />}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
            {nextCursor ? <button className="photostaff-load-more secondary-button" type="button" onClick={() => void loadMore()} disabled={loadingMore} aria-busy={loadingMore || undefined}>{loadingMore ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : null}{t("workspace.photostaff.loadMore")}</button> : null}
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
          directoryPurpose="photostaffMove"
          onCancel={() => setPicker(null)}
          onSelect={(selection) => void proposeBatch("move", selection.path)}
          {...(onRequestCreateFolder ? { onRequestCreateFolder } : {})}
        />
      ) : null}

      {deleteOpen ? (
        <div className="file-action-backdrop" role="presentation">
          <div
            ref={deleteDialogRef}
            className="file-action-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="photostaff-delete-title"
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
            <header><span className="eyebrow">{t("workspace.photostaff.deleteSelected")}</span><h2 id="photostaff-delete-title">{t("workspace.photostaff.deleteTitle", { count: selected.length })}</h2></header>
            <p>{t("workspace.photostaff.deleteBody")}</p>
            <div className="file-action-actions"><button type="button" onClick={() => setDeleteOpen(false)} disabled={Boolean(busyAction)}>{t("common.actions.cancel")}</button><button className="danger-button" type="button" onClick={() => void proposeBatch("trash")} disabled={Boolean(busyAction)} aria-busy={busyAction === "trash" || undefined}>{t("workspace.photostaff.requestDelete")}</button></div>
          </div>
        </div>
      ) : null}

      {lightboxPhotostaff ? (
        <div className="photostaff-lightbox-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && setLightboxId(null)}>
          <div ref={lightboxRef} className="photostaff-lightbox" role="dialog" aria-modal="true" aria-labelledby="photostaff-lightbox-title" tabIndex={-1} onKeyDown={handleLightboxKeyDown}>
            <header className="photostaff-lightbox-header">
              <div><span className="eyebrow">{t("workspace.photostaff.viewer")}</span><h2 id="photostaff-lightbox-title">{lightboxPhotostaff.name}</h2></div>
              <div className="photostaff-lightbox-tools">
                {lightboxMediaKind !== "video" ? <>
                  <button type="button" onClick={() => setZoom((current) => Math.max(1, current - 0.5))} disabled={zoom <= 1} title={t("workspace.photostaff.zoomOut")} aria-label={t("workspace.photostaff.zoomOut")}><Minus aria-hidden="true" size={17} /></button>
                  <button type="button" onClick={() => setZoom(1)} title={t("workspace.photostaff.resetZoom")} aria-label={t("workspace.photostaff.resetZoom")}><Maximize2 aria-hidden="true" size={17} /><span>{Math.round(zoom * 100)}%</span></button>
                  <button type="button" onClick={() => setZoom((current) => Math.min(4, current + 0.5))} disabled={zoom >= 4} title={t("workspace.photostaff.zoomIn")} aria-label={t("workspace.photostaff.zoomIn")}><Plus aria-hidden="true" size={17} /></button>
                </> : null}
                <button type="button" onClick={() => setLightboxId(null)} title={t("common.actions.close")} aria-label={t("common.actions.close")}><X aria-hidden="true" size={18} /></button>
              </div>
            </header>
            <div className="photostaff-lightbox-body">
              <button className="photostaff-lightbox-nav is-previous" type="button" onClick={() => showAdjacent(-1)} disabled={lightboxIndex <= 0} title={t("workspace.photostaff.previous")} aria-label={t("workspace.photostaff.previous")}><ChevronLeft aria-hidden="true" size={24} /></button>
              <div className="photostaff-lightbox-canvas">
                {lightboxMediaKind === "video" ? (
                  <video
                    className="photostaff-lightbox-video"
                    src={`/api/photostaff/${encodeURIComponent(lightboxPhotostaff.id)}/video`}
                    poster={`/api/photostaff/${encodeURIComponent(lightboxPhotostaff.id)}/preview`}
                    controls
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <img src={`/api/photostaff/${encodeURIComponent(lightboxPhotostaff.id)}/preview`} alt={lightboxPhotostaff.name} style={{ width: `${zoom * 100}%` }} />
                )}
              </div>
              <button className="photostaff-lightbox-nav is-next" type="button" onClick={() => showAdjacent(1)} disabled={lightboxIndex >= photostaff.length - 1} title={t("workspace.photostaff.next")} aria-label={t("workspace.photostaff.next")}><ChevronRight aria-hidden="true" size={24} /></button>
              <aside className="photostaff-lightbox-meta">
                <dl>
                  <div><dt>{t("workspace.photostaff.takenAt")}</dt><dd>{formatPhotostaffDateTime(lightboxPhotostaff.metadata?.capturedAtLocal ?? lightboxPhotostaff.takenAt, locale)}</dd></div>
                  <div><dt>{t("workspace.photostaff.dimensions")}</dt><dd>{lightboxPhotostaff.width && lightboxPhotostaff.height ? `${lightboxPhotostaff.width} × ${lightboxPhotostaff.height}` : t("common.states.unknown")}</dd></div>
                  <div><dt>{t("workspace.photostaff.fileSize")}</dt><dd>{formatBytes(lightboxPhotostaff.sizeBytes, locale)}</dd></div>
                  <div><dt>{t("workspace.photostaff.format")}</dt><dd>{lightboxPhotostaff.mimeType}</dd></div>
                  <div><dt>{t("workspace.photostaff.path")}</dt><dd title={lightboxPhotostaff.path}>{lightboxPhotostaff.path}</dd></div>
                  {lightboxPhotostaff.metadata?.cameraModel ? <div><dt>{t("workspace.photostaff.camera")}</dt><dd>{lightboxPhotostaff.metadata.cameraModel}</dd></div> : null}
                  {lightboxPhotostaff.metadata?.lensModel ? <div><dt>{t("workspace.photostaff.lens")}</dt><dd>{lightboxPhotostaff.metadata.lensModel}</dd></div> : null}
                  {lightboxPhotostaff.metadata?.iso ? <div><dt>ISO</dt><dd>{lightboxPhotostaff.metadata.iso}</dd></div> : null}
                  {lightboxPhotostaff.metadata?.aperture ? <div><dt>{t("workspace.photostaff.aperture")}</dt><dd>f/{lightboxPhotostaff.metadata.aperture}</dd></div> : null}
                  {lightboxPhotostaff.metadata?.exposureTimeSeconds ? <div><dt>{t("workspace.photostaff.shutter")}</dt><dd>{formatExposure(lightboxPhotostaff.metadata.exposureTimeSeconds)}</dd></div> : null}
                  {lightboxPhotostaff.metadata?.focalLengthMm ? <div><dt>{t("workspace.photostaff.focalLength")}</dt><dd>{lightboxPhotostaff.metadata.focalLengthMm} mm</dd></div> : null}
                </dl>
                <section className="photostaff-metadata-inspector">
                  <header><strong>{t("workspace.photostaff.metadata")}</strong>{metadataLoading ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : null}</header>
                  {metadata?.warnings.length ? <div className="photostaff-metadata-warnings">{metadata.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
                  {Object.entries(metadata?.groups ?? {}).map(([source, entries]) => (
                    <details key={source}>
                      <summary>{source}<span>{Object.keys(entries).length}</span></summary>
                      <dl>{Object.entries(entries).map(([key, values]) => <div key={key}><dt>{key}</dt><dd>{values.join(", ")}</dd></div>)}</dl>
                    </details>
                  ))}
                  {metadata?.sensitiveOmitted && !sensitiveRevealed ? <button type="button" className="photostaff-reveal-sensitive" onClick={() => void revealSensitiveMetadata()} disabled={metadataLoading}><SlidersHorizontal aria-hidden="true" size={14} />{t("workspace.photostaff.revealSensitive")}</button> : null}
                  {Object.entries(metadata?.sensitiveGroups ?? {}).map(([source, entries]) => (
                    <details className="is-sensitive" key={source}>
                      <summary>{source}<span>{Object.keys(entries).length}</span></summary>
                      <dl>{Object.entries(entries).map(([key, values]) => <div key={key}><dt>{key}</dt><dd>{values.join(", ")}</dd></div>)}</dl>
                    </details>
                  ))}
                </section>
                <a className="secondary-button" href={`/api/photostaff/${encodeURIComponent(lightboxPhotostaff.id)}/original?download=1`} download={lightboxPhotostaff.name}><Download aria-hidden="true" size={15} />{t("workspace.photostaff.downloadOriginal")}</a>
              </aside>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function groupPhotostaffByDate<T extends PhotostaffAsset & {
  metadata?: { capturedAtLocal?: string | null } | null;
}>(assets: T[], locale: SupportedLocale) {
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
  const groups: Array<{ key: string; label: string; photostaff: T[] }> = [];
  for (const asset of assets) {
    const localCaptureDate = localCalendarDate(asset.metadata?.capturedAtLocal);
    const takenAt = new Date(asset.takenAt);
    const validDate = localCaptureDate ?? (Number.isFinite(takenAt.getTime()) ? takenAt : new Date(asset.mtimeMs));
    const key = localCaptureDate
      ? asset.metadata!.capturedAtLocal!.slice(0, 10)
      : [validDate.getFullYear(), String(validDate.getMonth() + 1).padStart(2, "0"), String(validDate.getDate()).padStart(2, "0")].join("-");
    const previous = groups.at(-1);
    if (previous?.key === key) previous.photostaff.push(asset);
    else groups.push({ key, label: formatter.format(validDate), photostaff: [asset] });
  }
  return groups;
}

export function isPhotostaffBusy(state: PhotostaffLibraryStatus["state"] | undefined): boolean {
  return state === "queued" || state === "discovering" || state === "processing" || state === "retrying";
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

export function photostaffMediaKindForAsset(photostaff: Pick<PhotostaffAsset, "name" | "mimeType">): PhotostaffMediaKind {
  return photostaffMediaKind(photostaff.name) ?? (photostaff.mimeType.startsWith("video/") ? "video" : "image");
}

function PhotostaffFacetSelect({
  label,
  options,
  selected,
  allLabel,
  selectedLabel,
  onChange
}: {
  label: string;
  options: Array<{ value: string; count: number }>;
  selected: string[];
  allLabel: string;
  selectedLabel: (count: number) => string;
  onChange: (value: string[] | undefined) => void;
}) {
  const summary = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? selected[0]!
      : selectedLabel(selected.length);
  return (
    <label className="photostaff-facet-filter">
      <span>{label}</span>
      <select
        value=""
        aria-label={label}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "__clear__") onChange(undefined);
          else if (value) onChange(togglePhotostaffFacetValue(selected, value));
        }}
      >
        <option value="" disabled>{summary}</option>
        {selected.length ? <option value="__clear__">{allLabel}</option> : null}
        {options.map((item) => (
          <option key={item.value} value={item.value}>
            {selected.includes(item.value) ? "[x] " : ""}{item.value} ({item.count})
          </option>
        ))}
      </select>
    </label>
  );
}

export function togglePhotostaffFacetValue<T extends string>(selected: T[] | undefined, value: T): T[] | undefined {
  const current = selected ?? [];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  return next.length ? next : undefined;
}

function samePhotostaffMetadataFields(left: PhotostaffMetadataField[], right: PhotostaffMetadataField[]): boolean {
  return left.length === right.length && left.every((field, index) => {
    const other = right[index];
    return other !== undefined && field.key === other.key && field.valueType === other.valueType &&
      field.count === other.count && field.sensitive === other.sensitive;
  });
}

export function readyPhotostaffQueryFilters(
  filters: PhotostaffQueryFilters,
  metadataFields: PhotostaffMetadataField[] = []
): PhotostaffQueryFilters {
  const advanced = filters.advanced;
  if (!advanced) return filters;
  const conditions: PhotostaffMetadataCondition[] = [];
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
    const nextCondition: PhotostaffMetadataCondition = {
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
  valueType: PhotostaffMetadataField["valueType"] | undefined
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

function mergePhotostaff(current: PhotostaffQueryAsset[], incoming: PhotostaffQueryAsset[]): PhotostaffQueryAsset[] {
  const ids = new Set(current.map((photostaff) => photostaff.id));
  return [...current, ...incoming.filter((photostaff) => !ids.has(photostaff.id))];
}

function numberRange(
  min: string | number | undefined,
  max: string | number | undefined
): { min?: number; max?: number } | undefined {
  const minValue = min === "" || min === undefined ? undefined : Number(min);
  const maxValue = max === "" || max === undefined ? undefined : Number(max);
  if (minValue === undefined && maxValue === undefined) return undefined;
  return {
    ...(minValue !== undefined && Number.isFinite(minValue) ? { min: minValue } : {}),
    ...(maxValue !== undefined && Number.isFinite(maxValue) ? { max: maxValue } : {})
  };
}

function dateRange(
  from: string | undefined,
  to: string | undefined
): { from?: string; to?: string } | undefined {
  const fromDate = from?.slice(0, 10) || undefined;
  const toDate = to?.slice(0, 10) || undefined;
  if (!fromDate && !toDate) return undefined;
  return {
    ...(fromDate ? { from: `${fromDate}T00:00:00` } : {}),
    ...(toDate ? { to: `${toDate}T23:59:59.999` } : {})
  };
}

function metadataOperatorOptions(translate: (key: string) => string): Array<{
  value: PhotostaffMetadataCondition["operator"];
  label: string;
}> {
  return [
    ["eq", "equals"], ["contains", "contains"], ["prefix", "prefix"], ["in", "oneOf"],
    ["exists", "exists"], ["not_exists", "notExists"], ["lt", "lessThan"],
    ["lte", "lessOrEqual"], ["gt", "greaterThan"], ["gte", "greaterOrEqual"], ["between", "between"]
  ].map(([value, label]) => ({
    value: value as PhotostaffMetadataCondition["operator"],
    label: translate(`workspace.photostaff.operators.${label}`)
  }));
}

function formatExposure(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(seconds % 1 ? 1 : 0)} s`;
  return `1/${Math.max(1, Math.round(1 / seconds))} s`;
}

function formatPhotostaffDateTime(value: string, locale: SupportedLocale): string {
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
