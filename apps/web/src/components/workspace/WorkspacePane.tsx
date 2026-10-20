import { ChangeEvent, DragEvent, FormEvent, KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  Activity,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronLeft,
  Container,
  Copy,
  Download,
  Ellipsis,
  Files,
  FolderInput,
  FolderPlus,
  GitBranch,
  HardDrive,
  Images,
  MessageSquarePlus,
  MonitorPlay,
  MonitorCog,
  Network,
  LoaderCircle,
  PencilLine,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
  FolderUp,
  Upload,
  type LucideIcon
} from "lucide-react";
import { createFileExport, getFileDownloadUrl, type DockerOperation, type FileBatch, type FileEntry, type FileListing, type FileMeta, type FileOperation, type IndexSearchCategory, type IndexSearchRequest, type IndexSearchResult, type NasRoot, type PendingApproval, type VodPlayerCommand, type VodPlayerStatus, type TextPreview, type VmOperation } from "../../api.js";
import { describeFileVisual, isHiddenName } from "../../file-type-utils.js";
import { formatBytes, formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { sortEntries, type FileSortDirection, type FileSortKey, type FileSortState } from "../../lib/file-listing-sort.js";
import { formatFileModifiedAt } from "../../lib/format.js";
import { fileDownloadMode, isInvalidFileMoveDestination, reconcileFileSelection, updateFileSelection } from "../../lib/file-selection.js";
import {
  readStoredWorkspacePanel,
  writeStoredWorkspacePanel,
  type WorkspacePanelId
} from "../../lib/workspace-panel-settings.js";
import { ActivityMenu } from "../activity/ActivityMenu.js";
import { FileTypeIcon } from "../file/FileTypeIcon.js";
import { VodPlayerControls } from "../preview/VodPlayerControls.js";
import {
  collectUploadSourcesFromDataTransfer,
  collectUploadSourcesFromFileList,
  joinNasPath,
  type UploadBatchState,
  type UploadSource
} from "../../lib/uploads.js";
import { WorkspaceManagementPanel } from "./WorkspaceManagementPanel.js";
import { LocalTerminalPanel } from "./LocalTerminalPanel.js";
import { HttpDownloaderPanel } from "./HttpDownloaderPanel.js";
import { PhotoLibraryPanel } from "./PhotoLibraryPanel.js";
import { FileListSkeleton, SkeletonBlock } from "./ManagementSkeleton.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";
import type { CodeFontSettings } from "../../lib/editor-settings.js";
import type { ResolvedTheme } from "../../lib/theme-settings.js";
import { StorageFilePickerDialog } from "./StorageFilePickerDialog.js";
import { FilePreviewDialog } from "./FilePreviewDialog.js";
import { MonitoringPanel } from "./MonitoringPanel.js";

const EPOCH_DATE = new Date(0).toISOString();

const WORKSPACE_PANELS = [
  {
    id: "files",
    labelKey: "workspace.panels.files",
    shortLabelKey: "workspace.panels.filesShort",
    Icon: Files
  },
  {
    id: "photos",
    labelKey: "workspace.panels.photos",
    shortLabelKey: "workspace.panels.photosShort",
    Icon: Images
  },
  {
    id: "terminal",
    labelKey: "workspace.panels.terminal",
    shortLabelKey: "workspace.panels.terminalShort",
    Icon: TerminalSquare
  },
  {
    id: "downloads",
    labelKey: "workspace.panels.downloads",
    shortLabelKey: "workspace.panels.downloadsShort",
    Icon: Download
  },
  {
    id: "monitoring",
    labelKey: "workspace.panels.monitoring",
    shortLabelKey: "workspace.panels.monitoringShort",
    Icon: Activity
  },
  {
    id: "docker",
    labelKey: "workspace.panels.docker",
    shortLabelKey: "workspace.panels.dockerShort",
    Icon: Container
  },
  {
    id: "virtualMachines",
    labelKey: "workspace.panels.virtualMachines",
    shortLabelKey: "workspace.panels.virtualMachinesShort",
    Icon: MonitorCog
  },
  {
    id: "network",
    labelKey: "workspace.panels.network",
    shortLabelKey: "workspace.panels.networkShort",
    Icon: Network
  },
  {
    id: "storage",
    labelKey: "workspace.panels.storage",
    shortLabelKey: "workspace.panels.storageShort",
    Icon: HardDrive
  },
  {
    id: "shares",
    labelKey: "workspace.panels.shares",
    shortLabelKey: "workspace.panels.sharesShort",
    Icon: Share2
  }
] as const satisfies ReadonlyArray<{
  id: WorkspacePanelId;
  labelKey: string;
  shortLabelKey: string;
  Icon: LucideIcon;
}>;

export interface FileStoragePoolOption {
  id: string;
  rootId: string;
  name: string;
  path: string;
  filesystem: string | null;
  status: "ready" | "warning" | "offline" | "unknown";
}

export interface WorkspaceSearchOptions {
  categories: IndexSearchCategory[];
  extractionSources: NonNullable<IndexSearchRequest["extractionSources"]>;
  extractionStatuses: NonNullable<IndexSearchRequest["extractionStatuses"]>;
  mimeTypes: string;
  modifiedFrom: string;
  modifiedTo: string;
  sizeMin: string;
  sizeMax: string;
  sort: NonNullable<IndexSearchRequest["sort"]>;
}

export function defaultWorkspaceSearchOptions(): WorkspaceSearchOptions {
  return {
    categories: [],
    extractionSources: [],
    extractionStatuses: [],
    mimeTypes: "",
    modifiedFrom: "",
    modifiedTo: "",
    sizeMin: "",
    sizeMax: "",
    sort: { field: "relevance", direction: "desc" }
  };
}

export function hasWorkspaceSearchFilters(options: WorkspaceSearchOptions): boolean {
  return options.categories.length > 0
    || options.extractionSources.length > 0
    || options.extractionStatuses.length > 0
    || Boolean(options.mimeTypes.trim() || options.modifiedFrom || options.modifiedTo || options.sizeMin || options.sizeMax)
    || options.sort.field !== "relevance"
    || options.sort.direction !== "desc";
}

const SEARCH_CATEGORIES: IndexSearchCategory[] = ["text", "document", "spreadsheet", "presentation", "pdf", "other"];
const SEARCH_STATUSES: NonNullable<IndexSearchRequest["extractionStatuses"]> = ["pending", "ready", "stale", "error", "skipped"];
const SEARCH_SOURCES: NonNullable<IndexSearchRequest["extractionSources"]> = ["plain_text", "pdftotext", "docx", "xlsx", "pptx", "ocr"];

function SearchFilterMenu({ options, disabled, onChange, onApply }: {
  options: WorkspaceSearchOptions;
  disabled: boolean;
  onChange: (options: WorkspaceSearchOptions) => void;
  onApply: (options?: WorkspaceSearchOptions) => void;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const active = hasWorkspaceSearchFilters(options);

  useEffect(() => {
    if (!open) return undefined;
    function close(event: PointerEvent) {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function toggleList<Key extends "categories" | "extractionSources" | "extractionStatuses">(
    key: Key,
    value: WorkspaceSearchOptions[Key][number]
  ) {
    const values = options[key] as string[];
    onChange({
      ...options,
      [key]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
    });
  }

  return (
    <div ref={containerRef} className="workspace-search-filter">
      <button
        ref={triggerRef}
        type="button"
        className={`workspace-search-filter-trigger${active ? " is-active" : ""}`}
        aria-label={active ? t("workspace.search.filtersActive") : t("workspace.search.filters")}
        title={t("workspace.search.filters")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontal aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div className="workspace-search-filter-menu" role="dialog" aria-label={t("workspace.search.filters")}>
          <fieldset>
            <legend>{t("workspace.search.category")}</legend>
            <div className="workspace-search-checks">
              {SEARCH_CATEGORIES.map((category) => <label key={category}><input type="checkbox" checked={options.categories.includes(category)} onChange={() => toggleList("categories", category)} /><span>{t(`workspace.search.categories.${category}`)}</span></label>)}
            </div>
          </fieldset>
          <fieldset>
            <legend>{t("workspace.search.extractionStatus")}</legend>
            <div className="workspace-search-checks">
              {SEARCH_STATUSES.map((status) => <label key={status}><input type="checkbox" checked={options.extractionStatuses.includes(status)} onChange={() => toggleList("extractionStatuses", status)} /><span>{t(`workspace.search.statuses.${status}`)}</span></label>)}
            </div>
          </fieldset>
          <fieldset>
            <legend>{t("workspace.search.extractionSource")}</legend>
            <div className="workspace-search-checks">
              {SEARCH_SOURCES.map((source) => <label key={source}><input type="checkbox" checked={options.extractionSources.includes(source)} onChange={() => toggleList("extractionSources", source)} /><span>{t(`workspace.search.sources.${source}`)}</span></label>)}
            </div>
          </fieldset>
          <label className="workspace-search-field"><span>{t("workspace.search.mimeTypes")}</span><input value={options.mimeTypes} placeholder={t("workspace.search.mimeTypesPlaceholder")} onChange={(event) => onChange({ ...options, mimeTypes: event.target.value })} /></label>
          <div className="workspace-search-field-grid">
            <label className="workspace-search-field"><span>{t("workspace.search.modifiedFrom")}</span><input type="date" value={options.modifiedFrom} onChange={(event) => onChange({ ...options, modifiedFrom: event.target.value })} /></label>
            <label className="workspace-search-field"><span>{t("workspace.search.modifiedTo")}</span><input type="date" value={options.modifiedTo} onChange={(event) => onChange({ ...options, modifiedTo: event.target.value })} /></label>
            <label className="workspace-search-field"><span>{t("workspace.search.sizeMin")}</span><input type="number" min="0" value={options.sizeMin} onChange={(event) => onChange({ ...options, sizeMin: event.target.value })} /></label>
            <label className="workspace-search-field"><span>{t("workspace.search.sizeMax")}</span><input type="number" min="0" value={options.sizeMax} onChange={(event) => onChange({ ...options, sizeMax: event.target.value })} /></label>
            <label className="workspace-search-field"><span>{t("workspace.search.sort")}</span><select value={options.sort.field} onChange={(event) => onChange({ ...options, sort: { ...options.sort, field: event.target.value as WorkspaceSearchOptions["sort"]["field"] } })}>{(["relevance", "name", "mtime", "size"] as const).map((field) => <option key={field} value={field}>{t(`workspace.search.sortFields.${field}`)}</option>)}</select></label>
            <label className="workspace-search-field"><span>{t("workspace.search.sort")}</span><select value={options.sort.direction} onChange={(event) => onChange({ ...options, sort: { ...options.sort, direction: event.target.value as "asc" | "desc" } })}><option value="desc">{t("workspace.search.directions.desc")}</option><option value="asc">{t("workspace.search.directions.asc")}</option></select></label>
          </div>
          <div className="workspace-search-filter-actions">
            <button type="button" className="secondary-button" onClick={() => { const reset = defaultWorkspaceSearchOptions(); onChange(reset); onApply(reset); setOpen(false); }}>{t("workspace.search.reset")}</button>
            <button type="button" className="primary-button" onClick={() => { onApply(); setOpen(false); }}>{t("workspace.search.apply")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function nextFileSort(current: FileSortState, key: FileSortKey): FileSortState {
  if (current.key !== key) {
    return { key, direction: "desc" };
  }

  return { key, direction: current.direction === "desc" ? "asc" : "desc" };
}

function fileSortAria(sort: FileSortState, key: FileSortKey): "ascending" | "descending" | "none" {
  if (sort.key !== key) {
    return "none";
  }

  return sort.direction === "desc" ? "descending" : "ascending";
}

function SortDirectionIcon({ direction }: { direction: FileSortDirection }) {
  const Icon = direction === "desc" ? ArrowDown : ArrowUp;

  return <Icon aria-hidden="true" size={12} />;
}

function HighlightedSnippet({ result }: { result: IndexSearchResult }) {
  const { t } = useTranslation();
  if (!result.snippet) {
    return <span>{t("workspace.search.noSnippet")}</span>;
  }
  const ranges = result.highlightRanges
    .map((range) => ({
      start: Math.max(0, Math.min(result.snippet.length, range.start)),
      end: Math.max(0, Math.min(result.snippet.length, range.end))
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const content = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) content.push(result.snippet.slice(cursor, range.start));
    content.push(<mark key={`${range.start}-${range.end}`}>{result.snippet.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < result.snippet.length) content.push(result.snippet.slice(cursor));
  return <span>{content}</span>;
}

function StoragePoolSwitcher({
  pools,
  selectedPoolId,
  onSelect
}: {
  pools: FileStoragePoolOption[];
  selectedPoolId: string;
  onSelect: (poolId: string) => void;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const selectedPool = pools.find((pool) => pool.id === selectedPoolId);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function closeOnPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={`storage-pool-switcher${open ? " is-open" : ""}`}>
      <button
        id="storage-pool-switcher"
        className="storage-pool-switcher-trigger"
        type="button"
        aria-label={`${t("workspace.storagePoolLabel")}: ${selectedPool?.name ?? t("workspace.storagePoolPlaceholder")}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "storage-pool-menu" : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="storage-pool-switcher-icon" data-state={selectedPool?.status ?? "unknown"}>
          <HardDrive aria-hidden="true" size={16} />
        </span>
        <span className="storage-pool-switcher-copy">
          <strong>{selectedPool?.name ?? t("workspace.storagePoolPlaceholder")}</strong>
          <small>{selectedPool?.filesystem ?? t("common.states.unknown")}</small>
        </span>
        <ChevronDown aria-hidden="true" size={15} />
      </button>

      {open ? (
        <div id="storage-pool-menu" className="storage-pool-menu" role="menu" aria-labelledby="storage-pool-switcher">
          <div className="storage-pool-menu-heading">{t("workspace.storagePoolLabel")}</div>
          {pools.map((pool) => {
            const selected = pool.id === selectedPoolId;
            return (
              <button
                key={pool.id}
                className={`storage-pool-menu-option${selected ? " is-selected" : ""}`}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onSelect(pool.id);
                  setOpen(false);
                }}
              >
                <span className="storage-pool-status" data-state={pool.status} aria-hidden="true" />
                <span className="storage-pool-menu-copy">
                  <strong>{pool.name}</strong>
                  <small>{[pool.filesystem, pool.path].filter(Boolean).join(" · ")}</small>
                </span>
                {selected ? <Check aria-hidden="true" size={15} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function WorkspacePane({
  active,
  roots,
  selectedRoot,
  selectedRootId,
  storagePools,
  storageSummaryLoading,
  selectedStoragePoolId,
  currentPath,
  breadcrumbs,
  entries,
  fileListingLoading,
  gitStatus,
  selectedFilePath,
  previewMeta,
  previewLoading,
  previewError,
  textPreview,
  blobUrl,
  videoUrl,
  vodPlayerStatus,
  vodPlayerBusy,
  previewFileSizeLimitBytes,
  searchQuery,
  searchOptions,
  searchResults,
  searchNextCursor,
  operations,
  fileBatches,
  uploadBatches,
  dockerOperations,
  vmOperations,
  operationsReady,
  sessionId,
  pendingApprovals,
  locale,
  codeFontSettings,
  resolvedTheme,
  filesPanelActivationId,
  onSelectStoragePool,
  onOpenDownloadedDirectory,
  onGoUp,
  onRefreshFiles,
  onSubmitSearch,
  onSearchQueryChange,
  onSearchOptionsChange,
  onApplySearchFilters,
  onLoadMoreSearchResults,
  onGoToBreadcrumb,
  onGoToStoragePool,
  onOpenEntry,
  onOpenWorkspacePath,
  onInsertWorkspacePath,
  onOpenEditor,
  onPlayToVodPlayer,
  onVodPlayerCommand,
  onRetryVodPlayer,
  onRequestCreateFolder,
  onRequestCreateFolderAt,
  onRequestRename,
  onRequestTrash,
  onRequestTransfer,
  onRequestBatch,
  onRequestExtract,
  onUploadSources,
  onCancelUploadBatch,
  onCancelFileBatch,
  onWorkQueuesChanged,
  onNotifyError,
  onNotifySuccess,
  onNotifyWarning,
  onOpenDeviceSettings,
  onClosePreview,
  onRollback
}: {
  active: boolean;
  roots: NasRoot[];
  selectedRoot: NasRoot | undefined;
  selectedRootId: string;
  storagePools: FileStoragePoolOption[];
  storageSummaryLoading: boolean;
  selectedStoragePoolId: string;
  currentPath: string;
  breadcrumbs: string[];
  entries: FileEntry[];
  fileListingLoading: boolean;
  gitStatus: FileListing["git"];
  selectedFilePath: string | null;
  previewMeta: FileMeta | null;
  previewLoading: boolean;
  previewError: string | null;
  textPreview: TextPreview | null;
  blobUrl: string;
  videoUrl: string;
  vodPlayerStatus: VodPlayerStatus | null;
  vodPlayerBusy: boolean;
  previewFileSizeLimitBytes: number;
  searchQuery: string;
  searchOptions: WorkspaceSearchOptions;
  searchResults: IndexSearchResult[] | null;
  searchNextCursor: string | null;
  operations: FileOperation[];
  fileBatches: FileBatch[];
  uploadBatches: UploadBatchState[];
  dockerOperations: DockerOperation[];
  vmOperations: VmOperation[];
  operationsReady: boolean;
  sessionId: string | null;
  pendingApprovals: PendingApproval[];
  locale: SupportedLocale;
  codeFontSettings: CodeFontSettings;
  resolvedTheme: ResolvedTheme;
  filesPanelActivationId: number;
  onSelectStoragePool: (poolId: string) => void;
  onOpenDownloadedDirectory: (rootId: string, storagePoolId: string, path: string) => void;
  onGoUp: () => void;
  onRefreshFiles: () => void;
  onSubmitSearch: (event: FormEvent<HTMLFormElement>) => void;
  onSearchQueryChange: (query: string) => void;
  onSearchOptionsChange: (options: WorkspaceSearchOptions) => void;
  onApplySearchFilters: (options?: WorkspaceSearchOptions) => void;
  onLoadMoreSearchResults: () => void;
  onGoToBreadcrumb: (index: number) => void;
  onGoToStoragePool: () => void;
  onOpenEntry: (entry: FileEntry) => void;
  onOpenWorkspacePath: (path: string) => void;
  onInsertWorkspacePath: (path: string) => void;
  onOpenEditor: (meta: FileMeta) => void;
  onPlayToVodPlayer: () => void;
  onVodPlayerCommand: (command: Exclude<VodPlayerCommand, { type: "play" }>) => void;
  onRetryVodPlayer: () => void;
  onRequestCreateFolder: (folderName: string) => Promise<void>;
  onRequestCreateFolderAt?: (input: {
    rootId: string;
    storagePoolId: string;
    parentPath: string;
    name: string;
  }) => Promise<void>;
  onRequestRename: (entry: FileEntry, targetName: string) => Promise<void>;
  onRequestTrash: (entry: FileEntry) => Promise<void>;
  onRequestTransfer: (entry: FileEntry, operation: "move" | "copy", targetPath: string) => Promise<void>;
  onRequestBatch: (entries: FileEntry[], operation: "move" | "trash", targetDirectory?: string) => Promise<void>;
  onRequestExtract: (meta: FileMeta) => Promise<void>;
  onUploadSources: (sources: UploadSource[]) => void | Promise<void>;
  onCancelUploadBatch: (batchId: string) => void;
  onCancelFileBatch: (jobId: string) => void;
  onWorkQueuesChanged: () => void | Promise<void>;
  onNotifyError: (message: string | null) => void;
  onNotifySuccess: (message: string | null) => void;
  onNotifyWarning: (message: string | null) => void;
  onOpenDeviceSettings: (section: "wireless" | "bluetooth") => void;
  onClosePreview: () => void;
  onRollback: (operation: FileOperation) => void;
}) {
  const { t } = useTranslation();
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [renameEntry, setRenameEntry] = useState<FileEntry | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteState, setDeleteState] = useState<{ entries: FileEntry[] } | null>(null);
  const [transferState, setTransferState] = useState<{ entry: FileEntry; operation: "move" | "copy" } | null>(null);
  const [batchMoveEntries, setBatchMoveEntries] = useState<FileEntry[] | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [desktopMultiSelect, setDesktopMultiSelect] = useState(false);
  const [downloadKey, setDownloadKey] = useState<string | null>(null);
  const [rowActionMenu, setRowActionMenu] = useState<{ entry: FileEntry; top: number; right: number } | null>(null);
  const [transferTargetDirectory, setTransferTargetDirectory] = useState(currentPath);
  const [operationSubmitting, setOperationSubmitting] = useState(false);
  const [activePanel, setActivePanel] = useState<WorkspacePanelId>(() => readStoredWorkspacePanel());
  const [terminalMounted, setTerminalMounted] = useState(activePanel === "terminal");
  const [compactLayout, setCompactLayout] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 1040px)").matches
  );
  const [fileSort, setFileSort] = useState<FileSortState>({ key: "name", direction: "asc" });
  const [isDropActive, setIsDropActive] = useState(false);
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);
  const folderUploadInputRef = useRef<HTMLInputElement | null>(null);
  const rowActionMenuRef = useRef<HTMLDivElement | null>(null);
  const rowActionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewScopeRef = useRef(`${selectedRootId}\0${selectedStoragePoolId}\0${currentPath}`);
  const dragDepthRef = useRef(0);
  const selectedStoragePool = storagePools.find((pool) => pool.id === selectedStoragePoolId);
  const hasStoragePool = Boolean(selectedStoragePool);
  const storagePoolPathDepth = selectedStoragePool?.path.split("/").filter(Boolean).length ?? 0;
  const visibleBreadcrumbs = selectedStoragePool ? breadcrumbs.slice(storagePoolPathDepth) : breadcrumbs;
  const sortedEntries = useMemo(
    () => searchResults ? entries : sortEntries(entries, fileSort),
    [entries, fileSort, searchResults]
  );
  const selectablePaths = useMemo(
    () => sortedEntries.filter((entry) => entry.isSafe).map((entry) => entry.path),
    [sortedEntries]
  );
  const selectedEntries = useMemo(
    () => sortedEntries.filter((entry) => selectedPaths.has(entry.path)),
    [selectedPaths, sortedEntries]
  );
  const searchResultByPath = useMemo(
    () => new Map((searchResults ?? []).map((result) => [result.path, result])),
    [searchResults]
  );
  const gitChangeCount = gitStatus
    ? gitStatus.summary.staged + gitStatus.summary.modified + gitStatus.summary.untracked + gitStatus.summary.conflicted
    : 0;
  const gitBranchLabel = gitStatus?.branch ?? gitStatus?.headSha ?? t("workspace.git.detached");
  const gitSummaryText = gitStatus
    ? [
        gitStatus.repositoryName,
        gitBranchLabel,
        gitStatus.dirty ? t("workspace.git.dirtyShort", { count: gitChangeCount }) : t("workspace.git.clean"),
        gitStatus.ahead > 0 ? t("workspace.git.aheadShort", { count: gitStatus.ahead }) : null,
        gitStatus.behind > 0 ? t("workspace.git.behindShort", { count: gitStatus.behind }) : null
      ]
        .filter((item): item is string => Boolean(item))
        .join(" · ")
    : "";
  const gitTooltip = gitStatus
    ? [
        `${t("workspace.git.repository")}: ${gitStatus.repositoryName}`,
        `${t("workspace.git.branch")}: ${gitBranchLabel}`,
        gitStatus.upstream ? `${t("workspace.git.upstream")}: ${gitStatus.upstream}` : null,
        gitStatus.ahead > 0 ? t("workspace.git.ahead", { count: gitStatus.ahead }) : null,
        gitStatus.behind > 0 ? t("workspace.git.behind", { count: gitStatus.behind }) : null,
        gitStatus.dirty ? t("workspace.git.dirty", { count: gitChangeCount }) : t("workspace.git.clean")
      ]
        .filter((item): item is string => Boolean(item))
        .join("\n")
    : "";
  const gitStatusState = gitStatus && (gitStatus.dirty || gitStatus.ahead > 0 || gitStatus.behind > 0) ? "warning" : "ready";
  const entryCount = formatLocaleNumber(sortedEntries.length, locale);
  const hasPreview = Boolean(selectedFilePath);
  const selectedFileName = selectedFilePath?.split("/").pop() ?? "";
  const previewTitle = previewMeta?.name ?? selectedFileName;
  const isPreviewLoading = previewLoading || (hasPreview && !previewMeta && !previewError);
  const canEditPreview = previewMeta?.kind === "file" && previewMeta.previewKind === "text";
  const canExtractPreview = previewMeta?.kind === "file" && isArchiveFileName(previewMeta.name);
  const trimmedFolderName = folderName.trim();
  const folderNameInvalid =
    !trimmedFolderName ||
    trimmedFolderName === "." ||
    trimmedFolderName === ".." ||
    trimmedFolderName.includes("/") ||
    trimmedFolderName.includes("\\");
  const trimmedRenameName = renameName.trim();
  const renameNameInvalid =
    !trimmedRenameName ||
    trimmedRenameName === "." ||
    trimmedRenameName === ".." ||
    trimmedRenameName.includes("/") ||
    trimmedRenameName.includes("\\");
  const renameNameUnchanged = renameEntry ? trimmedRenameName === renameEntry.name : false;
  const deleteEntries = deleteState?.entries ?? [];
  const deleteDirectoryCount = deleteEntries.filter((entry) => entry.kind === "directory").length;
  const deleteFileCount = deleteEntries.length - deleteDirectoryCount;
  const deleteIsDirectory = deleteEntries.length === 1 && deleteEntries[0]?.kind === "directory";
  const deleteTitle = deleteState
    ? deleteEntries.length > 1
      ? t("workspace.batch.deleteTitle", { count: deleteEntries.length })
      : deleteIsDirectory
        ? t("workspace.actions.deleteFolderTitle")
        : t("workspace.actions.deleteTitle")
    : "";
  const deleteBody = deleteState
    ? deleteEntries.length > 1
      ? t("workspace.batch.deleteBody", { files: deleteFileCount, directories: deleteDirectoryCount })
      : t("workspace.actions.deleteBody", { name: deleteEntries[0]?.name ?? "" })
    : "";
  const createFolderLocation = selectedStoragePool ? poolRelativePath(currentPath, selectedStoragePool.path) : t("common.root");
  const transferDirectoryDisplay = selectedStoragePool
    ? poolRelativePath(transferTargetDirectory, selectedStoragePool.path)
    : transferTargetDirectory;
  const rawTransferDirectory = transferDirectoryDisplay.trim().replace(/\\/gu, "/");
  const normalizedTransferDirectory = rawTransferDirectory.replace(/^\.\//u, "").replace(/\/+$/u, "") || ".";
  const transferTargetPath =
    normalizedTransferDirectory === "."
      ? transferState?.entry.name ?? ""
      : `${normalizedTransferDirectory}/${transferState?.entry.name ?? ""}`;
  const transferDirectoryInvalid =
    !transferTargetDirectory.trim() ||
    rawTransferDirectory.startsWith("/") ||
    normalizedTransferDirectory.split("/").some((segment) => segment === ".." || segment === "");
  const transferTargetRootPath = transferState && !transferDirectoryInvalid
    ? selectedStoragePool
      ? joinNasPath(selectedStoragePool.path, transferTargetPath)
      : transferTargetPath
    : "";
  const transferTargetInvalid =
    transferDirectoryInvalid ||
    transferTargetRootPath === transferState?.entry.path;
  const workspaceVisible = active || !compactLayout;

  useEffect(() => {
    const media = window.matchMedia("(hover: hover) and (pointer: fine)");
    const syncMultiSelect = () => setDesktopMultiSelect(media.matches);
    syncMultiSelect();
    media.addEventListener("change", syncMultiSelect);
    return () => media.removeEventListener("change", syncMultiSelect);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1040px)");
    const syncLayout = () => setCompactLayout(media.matches);
    syncLayout();
    media.addEventListener("change", syncLayout);
    return () => media.removeEventListener("change", syncLayout);
  }, []);

  useEffect(() => {
    const input = folderUploadInputRef.current;
    if (!input) {
      return;
    }

    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    writeStoredWorkspacePanel(activePanel);
  }, [activePanel]);

  useEffect(() => {
    dragDepthRef.current = 0;
    setIsDropActive(false);
  }, [activePanel, active, selectedRootId, selectedStoragePoolId]);

  useEffect(() => {
    setCreateFolderOpen(false);
    setFolderName("");
    setRenameEntry(null);
    setRenameName("");
    setDeleteState(null);
    setTransferState(null);
    setBatchMoveEntries(null);
    setTransferTargetDirectory(".");
  }, [selectedStoragePool?.path, selectedStoragePoolId]);

  useEffect(() => {
    setSelectedPaths(new Set());
    setSelectionAnchorPath(null);
    setRowActionMenu(null);
  }, [activePanel, currentPath, searchOptions, searchQuery, selectedRootId, selectedStoragePoolId]);

  useEffect(() => {
    const nextScope = `${selectedRootId}\0${selectedStoragePoolId}\0${currentPath}`;
    if (previewScopeRef.current !== nextScope) {
      previewScopeRef.current = nextScope;
      onClosePreview();
    }
  }, [currentPath, onClosePreview, selectedRootId, selectedStoragePoolId]);

  useEffect(() => {
    const availablePaths = new Set(entries.map((entry) => entry.path));
    setSelectedPaths((current) => reconcileFileSelection(current, availablePaths));
    setSelectionAnchorPath((current) => current && availablePaths.has(current) ? current : null);
  }, [entries]);

  useEffect(() => {
    if (activePanel !== "files" || selectedPaths.size === 0) return;
    const clearSelectionOnEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape"
        || event.defaultPrevented
        || document.querySelector('[role="dialog"], [role="menu"]')
      ) {
        return;
      }
      event.preventDefault();
      setSelectedPaths(new Set());
      setSelectionAnchorPath(null);
    };
    document.addEventListener("keydown", clearSelectionOnEscape);
    return () => document.removeEventListener("keydown", clearSelectionOnEscape);
  }, [activePanel, selectedPaths.size]);

  useEffect(() => {
    if (selectedFilePath && !fileListingLoading && !entries.some((entry) => entry.path === selectedFilePath)) {
      onClosePreview();
    }
  }, [entries, fileListingLoading, onClosePreview, selectedFilePath]);

  useEffect(() => {
    if (!rowActionMenu) return;
    const frame = window.requestAnimationFrame(() => {
      rowActionMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
    });
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (!rowActionMenuRef.current?.contains(event.target as Node)) closeRowActionMenu(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRowActionMenu(true);
      }
    };
    const closeOnViewportChange = () => closeRowActionMenu(false);
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [rowActionMenu]);

  useEffect(() => {
    if (filesPanelActivationId > 0) {
      setActivePanel("files");
    }
  }, [filesPanelActivationId]);

  function openCreateFolderDialog() {
    setRenameEntry(null);
    setDeleteState(null);
    setTransferState(null);
    setCreateFolderOpen(true);
    setFolderName("");
  }

  function openRenameDialog(event: MouseEvent<HTMLButtonElement>, entry: FileEntry) {
    event.stopPropagation();
    setCreateFolderOpen(false);
    setDeleteState(null);
    setRenameEntry(entry);
    setRenameName(entry.name);
  }

  function openDeleteDialog(event: MouseEvent<HTMLButtonElement>, entry: FileEntry) {
    event.stopPropagation();
    setCreateFolderOpen(false);
    setRenameEntry(null);
    setDeleteState({ entries: [entry] });
  }

  function openTransferDialog(event: MouseEvent<HTMLButtonElement>, entry: FileEntry, operation: "move" | "copy") {
    event.stopPropagation();
    setCreateFolderOpen(false);
    setRenameEntry(null);
    setDeleteState(null);
    setTransferState({ entry, operation });
    setTransferTargetDirectory(selectedStoragePool ? poolRelativePath(currentPath, selectedStoragePool.path) : ".");
  }

  function closeActionDialog() {
    if (operationSubmitting) {
      return;
    }
    setCreateFolderOpen(false);
    setFolderName("");
    setRenameEntry(null);
    setDeleteState(null);
    setTransferState(null);
    setBatchMoveEntries(null);
  }

  function clearBatchSelection() {
    setSelectedPaths(new Set());
    setSelectionAnchorPath(null);
  }

  function openBatchMoveDialog() {
    if (!selectedEntries.length || operationSubmitting) return;
    setCreateFolderOpen(false);
    setRenameEntry(null);
    setDeleteState(null);
    setTransferState(null);
    setBatchMoveEntries(selectedEntries);
  }

  function openBatchDeleteDialog() {
    if (!selectedEntries.length || operationSubmitting) return;
    setCreateFolderOpen(false);
    setRenameEntry(null);
    setTransferState(null);
    setBatchMoveEntries(null);
    setDeleteState({ entries: selectedEntries });
  }

  function closeRowActionMenu(restoreFocus: boolean) {
    setRowActionMenu(null);
    if (restoreFocus && rowActionTriggerRef.current?.isConnected) {
      window.requestAnimationFrame(() => rowActionTriggerRef.current?.focus());
    }
  }

  function openRowActionMenu(event: MouseEvent<HTMLButtonElement>, entry: FileEntry) {
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const menuHeight = 224;
    const top = window.innerHeight - bounds.bottom >= menuHeight
      ? bounds.bottom + 5
      : Math.max(8, bounds.top - menuHeight - 5);
    rowActionTriggerRef.current = event.currentTarget;
    setRowActionMenu({ entry, top, right: Math.max(8, window.innerWidth - bounds.right) });
  }

  function handleRowActionMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')];
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    if (event.key === "Home") {
      items[0]?.focus();
    } else if (event.key === "End") {
      items.at(-1)?.focus();
    } else {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = currentIndex < 0
        ? direction > 0 ? 0 : items.length - 1
        : (currentIndex + direction + items.length) % items.length;
      items[nextIndex]?.focus();
    }
  }

  async function downloadEntries(downloadEntries: FileEntry[]) {
    if (!downloadEntries.length || downloadKey) return;
    const key = downloadEntries.map((entry) => entry.path).join("\0");
    if (fileDownloadMode(downloadEntries) === "direct") {
      const entry = downloadEntries[0]!;
      triggerBrowserDownload(getFileDownloadUrl(selectedRootId, entry.path, selectedStoragePoolId), entry.name);
      return;
    }

    setDownloadKey(key);
    try {
      const result = await createFileExport({
        rootId: selectedRootId,
        storagePoolId: selectedStoragePoolId,
        sourcePaths: downloadEntries.map((entry) => entry.path)
      });
      triggerBrowserDownload(result.url, result.fileName);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onNotifyError(`${t("workspace.batch.downloadFailed")} ${detail}`);
    } finally {
      setDownloadKey(null);
    }
  }

  function openEntryFromRow(entry: FileEntry) {
    if (operationSubmitting || !entry.isSafe) {
      return;
    }
    clearBatchSelection();
    onOpenEntry(entry);
  }

  function updateBatchSelection(entry: FileEntry, mode: "toggle" | "range") {
    if (!desktopMultiSelect || operationSubmitting || !entry.isSafe) return;
    setSelectedPaths((current) => updateFileSelection(current, selectablePaths, entry.path, selectionAnchorPath, mode));
    if (mode === "toggle" || !selectionAnchorPath || !selectablePaths.includes(selectionAnchorPath)) {
      setSelectionAnchorPath(entry.path);
    }
  }

  function handleRowClick(event: MouseEvent<HTMLDivElement>, entry: FileEntry) {
    if (desktopMultiSelect && (event.metaKey || event.ctrlKey)) {
      updateBatchSelection(entry, "toggle");
      return;
    }
    if (desktopMultiSelect && event.shiftKey) {
      updateBatchSelection(entry, "range");
      return;
    }
    event.currentTarget.focus({ preventScroll: true });
    openEntryFromRow(entry);
  }

  function handleRowPointerDown(event: ReactPointerEvent<HTMLDivElement>, entry: FileEntry) {
    if (!desktopMultiSelect || !entry.isSafe || !(event.metaKey || event.ctrlKey || event.shiftKey)) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
  }

  function selectPanel(panel: WorkspacePanelId) {
    if (panel === "terminal") {
      setTerminalMounted(true);
    }
    clearBatchSelection();
    setRowActionMenu(null);
    if (panel !== "files") onClosePreview();
    setActivePanel(panel);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, entry: FileEntry) {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === " " && desktopMultiSelect && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      event.preventDefault();
      updateBatchSelection(entry, event.shiftKey ? "range" : "toggle");
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    openEntryFromRow(entry);
  }

  function triggerFileUpload() {
    fileUploadInputRef.current?.click();
  }

  function triggerFolderUpload() {
    folderUploadInputRef.current?.click();
  }

  function handleUploadFilesChange(event: ChangeEvent<HTMLInputElement>) {
    const sources = event.currentTarget.files ? collectUploadSourcesFromFileList(event.currentTarget.files) : [];
    event.currentTarget.value = "";
    if (sources.length) {
      void onUploadSources(sources);
    }
  }

  function handleUploadFolderChange(event: ChangeEvent<HTMLInputElement>) {
    const sources = event.currentTarget.files ? collectUploadSourcesFromFileList(event.currentTarget.files) : [];
    event.currentTarget.value = "";
    if (sources.length) {
      void onUploadSources(sources);
    }
  }

  function isFileDrag(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleGridDragEnter(event: DragEvent<HTMLDivElement>) {
    if (activePanel !== "files" || !hasStoragePool || !isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDropActive(true);
  }

  function handleGridDragOver(event: DragEvent<HTMLDivElement>) {
    if (activePanel !== "files" || !hasStoragePool || !isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDropActive(true);
  }

  function handleGridDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!isDropActive || !isFileDrag(event)) {
      return;
    }

    if (dragDepthRef.current > 0) {
      dragDepthRef.current -= 1;
    }
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDropActive(false);
    }
  }

  function handleGridDrop(event: DragEvent<HTMLDivElement>) {
    if (activePanel !== "files" || !hasStoragePool || !isFileDrag(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDropActive(false);
    void (async () => {
      const sources = await collectUploadSourcesFromDataTransfer(event.dataTransfer);
      if (sources.length) {
        await onUploadSources(sources);
      }
    })();
  }

  async function submitCreateFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createFolderOpen || folderNameInvalid || operationSubmitting) {
      return;
    }

    setOperationSubmitting(true);
    try {
      await onRequestCreateFolder(trimmedFolderName);
      setCreateFolderOpen(false);
      setFolderName("");
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationSubmitting(false);
    }
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameEntry || renameNameInvalid || renameNameUnchanged || operationSubmitting) {
      return;
    }

    setOperationSubmitting(true);
    try {
      await onRequestRename(renameEntry, trimmedRenameName);
      setRenameEntry(null);
      setRenameName("");
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationSubmitting(false);
    }
  }

  async function submitDelete() {
    if (!deleteState?.entries.length || operationSubmitting) {
      return;
    }

    setOperationSubmitting(true);
    try {
      if (deleteState.entries.length === 1) {
        await onRequestTrash(deleteState.entries[0]!);
      } else {
        await onRequestBatch(deleteState.entries, "trash");
      }
      setDeleteState(null);
      clearBatchSelection();
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationSubmitting(false);
    }
  }

  async function submitBatchMove(targetDirectory: string) {
    if (!batchMoveEntries?.length || operationSubmitting) return;
    setOperationSubmitting(true);
    try {
      await onRequestBatch(batchMoveEntries, "move", targetDirectory);
      setBatchMoveEntries(null);
      clearBatchSelection();
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationSubmitting(false);
    }
  }

  async function submitTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transferState || transferTargetInvalid || operationSubmitting) {
      return;
    }

    setOperationSubmitting(true);
    try {
      await onRequestTransfer(transferState.entry, transferState.operation, transferTargetPath);
      setTransferState(null);
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationSubmitting(false);
    }
  }

  async function submitExtract(meta: FileMeta) {
    if (operationSubmitting) {
      return;
    }

    setOperationSubmitting(true);
    try {
      await onRequestExtract(meta);
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationSubmitting(false);
    }
  }

  return (
    <section
      className={`workspace-pane ${active ? "is-mobile-active" : ""}`}
      aria-label={t("workspace.label")}
      aria-hidden={!workspaceVisible}
    >
      <input
        ref={fileUploadInputRef}
        className="workspace-upload-input"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleUploadFilesChange}
      />
      <input
        ref={folderUploadInputRef}
        className="workspace-upload-input"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleUploadFolderChange}
      />
      <div className="workspace-shell">
        <div className="workspace-stage" data-panel={activePanel}>
          {activePanel === "files" ? (
            <>
              <PanelHeader
                className="files-header"
                icon={<Files aria-hidden="true" size={20} />}
                title={t("workspace.files")}
                subtitle={t("workspace.filesManagementDescription")}
                actions={<PanelHeaderActions label={t("workspace.management.actions.label")} className="files-header-actions">
                  <PanelHeaderAction
                    className="files-header-button"
                    label={t("common.actions.up")}
                    type="button"
                    onClick={onGoUp}
                    disabled={!selectedStoragePool || currentPath === selectedStoragePool.path}
                  >
                    <ChevronLeft aria-hidden="true" size={18} />
                  </PanelHeaderAction>
                  <PanelHeaderAction
                    className="files-header-button"
                    label={t("common.actions.refresh")}
                    type="button"
                    onClick={onRefreshFiles}
                    disabled={!hasStoragePool}
                  >
                    <RefreshCw aria-hidden="true" size={18} />
                  </PanelHeaderAction>
                  <PanelHeaderAction
                    className="files-header-button"
                    label={t("workspace.actions.newFolder")}
                    tooltip={sessionId ? t("workspace.actions.newFolder") : t("workspace.actions.noSession")}
                    type="button"
                    onClick={openCreateFolderDialog}
                    disabled={!hasStoragePool || !sessionId}
                  >
                    <FolderPlus aria-hidden="true" size={18} />
                  </PanelHeaderAction>
                  <PanelHeaderAction
                    className="files-header-button"
                    label={t("workspace.uploadFiles")}
                    type="button"
                    onClick={triggerFileUpload}
                    disabled={!hasStoragePool}
                  >
                    <Upload aria-hidden="true" size={18} />
                  </PanelHeaderAction>
                  <PanelHeaderAction
                    className="files-header-button"
                    label={t("workspace.uploadFolder")}
                    type="button"
                    onClick={triggerFolderUpload}
                    disabled={!hasStoragePool}
                  >
                    <FolderUp aria-hidden="true" size={18} />
                  </PanelHeaderAction>
                  <ActivityMenu
                    operations={operations}
                    fileBatches={fileBatches}
                    operationsReady={operationsReady}
                    uploadBatches={uploadBatches}
                    locale={locale}
                    onCancelUploadBatch={onCancelUploadBatch}
                    onCancelFileBatch={onCancelFileBatch}
                    onRollback={onRollback}
                  />
                </PanelHeaderActions>}
              />

              <div
                className={`files-navigation-bar${storagePools.length > 0 ? " has-storage-pool-switcher" : ""}${selectedPaths.size > 0 ? " has-batch-selection" : ""}`}
              >
                  <div className="root-control storage-pool-control">
                    <label htmlFor="storage-pool-switcher">{t("workspace.storagePoolLabel")}</label>
                    {fileListingLoading ? (
                      <SkeletonBlock className="files-skeleton-select" />
                    ) : (
                      <StoragePoolSwitcher
                        pools={storagePools}
                        selectedPoolId={selectedStoragePoolId}
                        onSelect={onSelectStoragePool}
                      />
                    )}
                  </div>

                  <div className="workspace-search-controls">
                    <form className="search" onSubmit={onSubmitSearch}>
                      <Search aria-hidden="true" size={17} />
                      <input
                        value={searchQuery}
                        onChange={(event) => onSearchQueryChange(event.target.value)}
                        placeholder={t("workspace.searchPlaceholder")}
                        aria-label={t("workspace.searchAria")}
                        disabled={!hasStoragePool}
                        maxLength={256}
                      />
                    </form>
                    <SearchFilterMenu
                      options={searchOptions}
                      disabled={!hasStoragePool}
                      onChange={onSearchOptionsChange}
                      onApply={onApplySearchFilters}
                    />
                  </div>
                  {selectedPaths.size > 0 ? (
                    <div className="file-batch-toolbar" role="toolbar" aria-label={t("workspace.batch.actions")}>
                      <span className="file-batch-count" role="status" aria-live="polite">
                        {t("workspace.batch.selected", { count: selectedPaths.size })}
                      </span>
                      <button
                        type="button"
                        className="file-batch-action"
                        onClick={() => void downloadEntries(selectedEntries)}
                        disabled={Boolean(downloadKey)}
                        aria-busy={Boolean(downloadKey) || undefined}
                        title={downloadKey ? t("workspace.batch.preparingDownload") : t("workspace.batch.download")}
                        aria-label={downloadKey ? t("workspace.batch.preparingDownload") : t("workspace.batch.download")}
                      >
                        {downloadKey ? <LoaderCircle className="spin" aria-hidden="true" size={16} /> : <Download aria-hidden="true" size={16} />}
                      </button>
                      <button
                        type="button"
                        className="file-batch-action"
                        onClick={openBatchMoveDialog}
                        disabled={operationSubmitting}
                        title={t("workspace.batch.move")}
                        aria-label={t("workspace.batch.move")}
                      >
                        <FolderInput aria-hidden="true" size={16} />
                      </button>
                      <button
                        type="button"
                        className="file-batch-action is-danger"
                        onClick={openBatchDeleteDialog}
                        disabled={operationSubmitting}
                        title={t("workspace.batch.delete")}
                        aria-label={t("workspace.batch.delete")}
                      >
                        <Trash2 aria-hidden="true" size={16} />
                      </button>
                    </div>
                  ) : null}
              </div>

              <div
                className={`workspace-grid${isDropActive ? " is-drop-active" : ""}`}
                onDragEnter={handleGridDragEnter}
                onDragOver={handleGridDragOver}
                onDragLeave={handleGridDragLeave}
                onDrop={handleGridDrop}
              >
                {isDropActive ? (
                  <div className="workspace-drop-overlay" role="presentation" aria-hidden="true">
                    <div className="workspace-drop-panel">
                      <FolderUp aria-hidden="true" size={22} />
                      <strong>{t("workspace.uploadDropTitle")}</strong>
                      <p>{t("workspace.uploadDropBody")}</p>
                    </div>
                  </div>
                ) : null}
                <section className="file-browser" aria-label={t("workspace.fileBrowser")}>
                  <header className="management-section-header files-list-header">
                    <div className="files-list-title-block">
                      {fileListingLoading ? (
                        <div className="breadcrumbs files-skeleton-breadcrumbs" aria-hidden="true">
                          <SkeletonBlock width="72%" />
                        </div>
                      ) : (
                        <nav className="breadcrumbs files-content-breadcrumbs" aria-label={t("workspace.breadcrumbs")}>
                          <button type="button" onClick={onGoToStoragePool} disabled={!selectedStoragePool}>
                            <HardDrive aria-hidden="true" size={14} />
                            <span>{selectedStoragePool?.name ?? t("workspace.storagePoolPlaceholder")}</span>
                          </button>
                          {visibleBreadcrumbs.map((crumb, index) => (
                            <button
                              key={`${crumb}-${index}`}
                              type="button"
                              onClick={() => onGoToBreadcrumb(selectedStoragePool ? storagePoolPathDepth + index : index)}
                            >
                              <span>{crumb}</span>
                            </button>
                          ))}
                        </nav>
                      )}
                      <p className="files-list-summary">
                        {fileListingLoading ? <SkeletonBlock width="58%" /> : t("workspace.filesListDescription", {
                          total: entryCount,
                          root: selectedStoragePool?.name ?? t("workspace.storagePoolPlaceholder")
                        })}
                      </p>
                    </div>
                    {gitStatus ? (
                      <span className="management-status-pill files-git-status" data-state={gitStatusState} title={gitTooltip} aria-label={gitTooltip}>
                        <GitBranch aria-hidden="true" size={13} />
                        <span>{gitSummaryText}</span>
                      </span>
                    ) : null}
                  </header>

                  {fileListingLoading ? (
                    <div
                      className="file-list"
                      role="table"
                      aria-label={t("workspace.table.files")}
                      onClick={(event) => {
                        if (event.target === event.currentTarget) clearBatchSelection();
                      }}
                    >
                      <FileListSkeleton />
                    </div>
                  ) : hasStoragePool ? (
                    <div
                      className="file-list"
                      role="table"
                      aria-label={t("workspace.table.files")}
                      onClick={(event) => {
                        if (event.target === event.currentTarget) clearBatchSelection();
                      }}
                    >
                    <div className="file-row file-row-head" role="row">
                      <span role="columnheader" aria-sort={fileSortAria(fileSort, "name")}>
                        {t("workspace.table.name")}
                      </span>
                      <span className="file-actions-column" role="columnheader" aria-label={t("workspace.table.actions")} />
                      <span className="file-column-sort" role="columnheader" aria-sort={fileSortAria(fileSort, "sizeBytes")}>
                        <button
                          type="button"
                          className="file-sort-button"
                          onClick={() => setFileSort((current) => nextFileSort(current, "sizeBytes"))}
                          aria-label={t("workspace.table.size")}
                          title={t("workspace.table.size")}
                        >
                          <span>{t("workspace.table.size")}</span>
                          {fileSort.key === "sizeBytes" ? <SortDirectionIcon direction={fileSort.direction} /> : null}
                        </button>
                      </span>
                      <span className="file-column-sort" role="columnheader" aria-sort={fileSortAria(fileSort, "modifiedAt")}>
                        <button
                          type="button"
                          className="file-sort-button"
                          onClick={() => setFileSort((current) => nextFileSort(current, "modifiedAt"))}
                          aria-label={t("workspace.table.modified")}
                          title={t("workspace.table.modified")}
                        >
                          <span>{t("workspace.table.modified")}</span>
                          {fileSort.key === "modifiedAt" ? <SortDirectionIcon direction={fileSort.direction} /> : null}
                        </button>
                      </span>
                    </div>
                    {fileListingLoading ? <FileListSkeleton /> : sortedEntries.map((entry) => {
                      const fileVisual = describeFileVisual(entry);
                      const searchResult = searchResultByPath.get(entry.path);
                      const isHidden = isHiddenName(entry.name);
                      const displaySize =
                        entry.kind === "directory"
                          ? t("common.dash")
                          : entry.sizeBytes
                            ? formatBytes(entry.sizeBytes, locale)
                            : t("common.dash");
                      return (
                        <div
                          key={entry.path}
                          className={[
                            "file-row",
                            entry.path === selectedFilePath ? "is-previewed" : "",
                            selectedPaths.has(entry.path) ? "is-batch-selected" : "",
                            isHidden ? "is-hidden" : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          onPointerDown={(event) => handleRowPointerDown(event, entry)}
                          onClick={(event) => handleRowClick(event, entry)}
                          onKeyDown={(event) => handleRowKeyDown(event, entry)}
                          tabIndex={entry.isSafe ? 0 : -1}
                          aria-disabled={!entry.isSafe}
                          aria-selected={selectedPaths.has(entry.path)}
                          aria-current={entry.path === selectedFilePath ? "true" : undefined}
                          data-previewed={entry.path === selectedFilePath || undefined}
                          role="row"
                        >
                          <span className={`file-name${searchResult ? " is-search-result" : ""}`} role="cell">
                            <FileTypeIcon kind={fileVisual.kind} />
                            <span className="file-search-copy">
                              <span className="file-name-text">{entry.name}</span>
                              {searchResult ? (
                                <span className="file-search-snippet">
                                  <HighlightedSnippet result={searchResult} />
                                  <small data-state={searchResult.extractionStatus}>{t("workspace.search.resultStatus", { status: t(`workspace.search.statuses.${searchResult.extractionStatus}`) })}</small>
                                </span>
                              ) : null}
                            </span>
                            {entry.gitStatus ? (
                              <span
                                className={`git-file-status git-file-status-${entry.gitStatus}`}
                                title={t(`workspace.git.statuses.${entry.gitStatus}`)}
                                aria-label={t(`workspace.git.statuses.${entry.gitStatus}`)}
                              >
                                {gitFileStatusCode(entry.gitStatus)}
                              </span>
                            ) : null}
                          </span>
                          <span className="file-row-actions" role="cell" aria-label={t("workspace.table.actions")}>
                            <button
                              type="button"
                              className="file-action-button file-action-button-download"
                              onClick={(event) => {
                                event.stopPropagation();
                                void downloadEntries([entry]);
                              }}
                              disabled={!entry.isSafe || Boolean(downloadKey)}
                              aria-busy={downloadKey === entry.path || undefined}
                              title={downloadKey === entry.path
                                ? t("workspace.batch.preparingDownload")
                                : entry.kind === "directory"
                                  ? t("workspace.actions.downloadFolder")
                                  : t("workspace.downloadFile")}
                              aria-label={downloadKey === entry.path
                                ? t("workspace.batch.preparingDownload")
                                : t("workspace.actions.downloadEntry", { name: entry.name })}
                            >
                              {downloadKey === entry.path
                                ? <LoaderCircle className="spin" aria-hidden="true" size={14} />
                                : <Download aria-hidden="true" size={14} />}
                            </button>
                            <span className="file-row-expanded-actions">
                              <button
                                type="button"
                                className="file-action-button file-action-button-send"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onInsertWorkspacePath(entry.path);
                                }}
                                disabled={!entry.isSafe}
                                title={t("workspace.actions.sendPathToAgent")}
                                aria-label={t("workspace.actions.sendPathToAgentEntry", { name: entry.name })}
                              >
                                <MessageSquarePlus aria-hidden="true" size={14} />
                              </button>
                              <button
                                type="button"
                                className="file-action-button"
                                onClick={(event) => openTransferDialog(event, entry, "move")}
                                disabled={!entry.isSafe}
                                title={t("workspace.actions.move")}
                                aria-label={t("workspace.actions.moveEntry", { name: entry.name })}
                              >
                                <FolderInput aria-hidden="true" size={14} />
                              </button>
                              <button
                                type="button"
                                className="file-action-button"
                                onClick={(event) => openTransferDialog(event, entry, "copy")}
                                disabled={!entry.isSafe}
                                title={t("workspace.actions.copy")}
                                aria-label={t("workspace.actions.copyEntry", { name: entry.name })}
                              >
                                <Copy aria-hidden="true" size={14} />
                              </button>
                              <button
                                type="button"
                                className="file-action-button"
                                onClick={(event) => openRenameDialog(event, entry)}
                                disabled={!entry.isSafe}
                                title={t("workspace.actions.rename")}
                                aria-label={t("workspace.actions.renameEntry", { name: entry.name })}
                              >
                                <PencilLine aria-hidden="true" size={14} />
                              </button>
                              <button
                                type="button"
                                className="file-action-button is-danger"
                                onClick={(event) => openDeleteDialog(event, entry)}
                                disabled={!entry.isSafe}
                                title={t("workspace.actions.delete")}
                                aria-label={t("workspace.actions.deleteEntry", { name: entry.name })}
                              >
                                <Trash2 aria-hidden="true" size={14} />
                              </button>
                            </span>
                            <button
                              type="button"
                              className="file-action-button file-action-button-more"
                              onClick={(event) => openRowActionMenu(event, entry)}
                              disabled={!entry.isSafe}
                              title={t("workspace.actions.more")}
                              aria-label={t("workspace.actions.moreEntry", { name: entry.name })}
                              aria-haspopup="menu"
                              aria-expanded={rowActionMenu?.entry.path === entry.path}
                            >
                              <Ellipsis aria-hidden="true" size={15} />
                            </button>
                          </span>
                          <span role="cell">{displaySize}</span>
                          <span role="cell">
                            {entry.modifiedAt === EPOCH_DATE ? t("common.dash") : formatFileModifiedAt(entry.modifiedAt)}
                          </span>
                        </div>
                      );
                    })}
                    {searchResults && searchNextCursor ? (
                      <div className="workspace-search-more">
                        <button type="button" className="secondary-button" disabled={fileListingLoading} onClick={onLoadMoreSearchResults}>
                          {t("workspace.search.loadMore")}
                        </button>
                      </div>
                    ) : null}
                    </div>
                  ) : (
                    <div className="workspace-empty-state" role="status">
                      <HardDrive aria-hidden="true" size={28} />
                      <strong>{t("workspace.selectStoragePoolTitle")}</strong>
                      <p>{t("workspace.selectStoragePoolBody")}</p>
                      <button type="button" className="secondary-button" onClick={() => selectPanel("storage")}>
                        {t("workspace.openStorageManagement")}
                      </button>
                    </div>
                  )}
                </section>

              </div>
              {hasPreview ? (
                <FilePreviewDialog
                  title={previewTitle}
                  meta={previewMeta}
                  loading={isPreviewLoading}
                  error={previewError}
                  textPreview={textPreview}
                  blobUrl={blobUrl}
                  videoUrl={videoUrl}
                  rootId={selectedRootId}
                  previewFileSizeLimitBytes={previewFileSizeLimitBytes}
                  locale={locale}
                  onOpenWorkspacePath={onOpenWorkspacePath}
                  onClose={onClosePreview}
                  actions={<>
                    {previewMeta?.previewKind === "video" ? (
                      <button
                        type="button"
                        className="preview-tool-button"
                        onClick={onPlayToVodPlayer}
                        disabled={vodPlayerBusy}
                        aria-busy={vodPlayerBusy || undefined}
                        title={t("preview.vodPlayer.play")}
                        aria-label={t("preview.vodPlayer.play")}
                      >
                        <MonitorPlay aria-hidden="true" size={14} />
                      </button>
                    ) : null}
                    {canEditPreview && previewMeta ? (
                      <button
                        type="button"
                        className="preview-tool-button"
                        onClick={() => onOpenEditor(previewMeta)}
                        title={t("editor.open")}
                        aria-label={t("editor.open")}
                      >
                        <PencilLine aria-hidden="true" size={14} />
                      </button>
                    ) : null}
                    {canExtractPreview && previewMeta ? (
                      <button
                        type="button"
                        className="preview-tool-button"
                        onClick={() => void submitExtract(previewMeta)}
                        disabled={operationSubmitting}
                        title={t("workspace.actions.extract")}
                        aria-label={t("workspace.actions.extractEntry", { name: previewMeta.name })}
                      >
                        <ArchiveRestore aria-hidden="true" size={14} />
                      </button>
                    ) : null}
                  </>}
                  footer={vodPlayerStatus ? (
                    <VodPlayerControls status={vodPlayerStatus} busy={vodPlayerBusy} onCommand={onVodPlayerCommand} onRetry={onRetryVodPlayer} />
                  ) : null}
                />
              ) : null}
            </>
          ) : activePanel === "downloads" ? (
            <HttpDownloaderPanel
              pools={storagePools}
              storagePoolsLoading={storageSummaryLoading}
              selectedStoragePoolId={selectedStoragePoolId}
              locale={locale}
              onSelectStoragePool={onSelectStoragePool}
              onOpenDirectory={onOpenDownloadedDirectory}
              onOpenStorage={() => selectPanel("storage")}
              {...(onRequestCreateFolderAt ? { onRequestCreateFolder: onRequestCreateFolderAt } : {})}
              onNotifyError={onNotifyError}
              onNotifySuccess={onNotifySuccess}
              onNotifyWarning={onNotifyWarning}
            />
          ) : activePanel === "photos" ? (
            <PhotoLibraryPanel
              pools={storagePools}
              selectedRootId={selectedRootId}
              sessionId={sessionId}
              approvalRefreshKey={pendingApprovals.map((approval) => approval.id).join(",")}
              locale={locale}
              {...(onRequestCreateFolderAt ? { onRequestCreateFolder: onRequestCreateFolderAt } : {})}
              onWorkQueuesChanged={onWorkQueuesChanged}
              onNotifyError={onNotifyError}
              onNotifySuccess={onNotifySuccess}
              onNotifyWarning={onNotifyWarning}
            />
          ) : activePanel === "monitoring" ? (
            <MonitoringPanel locale={locale} />
          ) : activePanel === "terminal" || !workspaceVisible ? null : (
            <WorkspaceManagementPanel
              panel={activePanel}
              roots={roots}
              storagePools={storagePools}
              selectedStoragePoolId={selectedStoragePoolId}
              sessionId={sessionId}
              pendingApprovals={pendingApprovals}
              dockerOperations={dockerOperations}
              vmOperations={vmOperations}
              locale={locale}
              onWorkQueuesChanged={onWorkQueuesChanged}
              onNotifyError={onNotifyError}
              onNotifySuccess={onNotifySuccess}
              onNotifyWarning={onNotifyWarning}
              onOpenDeviceSettings={onOpenDeviceSettings}
            />
          )}
          {terminalMounted ? (
            <LocalTerminalPanel
              active={activePanel === "terminal" && workspaceVisible}
              root={selectedRoot}
              codeFontSettings={codeFontSettings}
              resolvedTheme={resolvedTheme}
            />
          ) : null}
        </div>

        <nav className="workspace-panel-rail" aria-label={t("workspace.panelRail")}>
          {WORKSPACE_PANELS.map((panel) => {
            const PanelIcon = panel.Icon;
            const isActive = activePanel === panel.id;
            return (
              <button
                key={panel.id}
                type="button"
                className={isActive ? "workspace-panel-tab is-active" : "workspace-panel-tab"}
                onClick={() => selectPanel(panel.id)}
                title={t(panel.labelKey)}
                aria-label={t(panel.labelKey)}
                aria-current={isActive ? "page" : undefined}
              >
                <PanelIcon aria-hidden="true" size={19} />
                <span>{t(panel.shortLabelKey)}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {rowActionMenu ? (
        <div
          ref={rowActionMenuRef}
          className="file-row-action-menu"
          role="menu"
          aria-label={t("workspace.actions.moreEntry", { name: rowActionMenu.entry.name })}
          style={{ top: rowActionMenu.top, right: rowActionMenu.right }}
          onKeyDown={handleRowActionMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              onInsertWorkspacePath(rowActionMenu.entry.path);
              closeRowActionMenu(true);
            }}
          >
            <MessageSquarePlus aria-hidden="true" size={15} />
            <span>{t("workspace.actions.sendPathToAgent")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              openTransferDialog(event, rowActionMenu.entry, "move");
              closeRowActionMenu(false);
            }}
          >
            <FolderInput aria-hidden="true" size={15} />
            <span>{t("workspace.actions.move")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              openTransferDialog(event, rowActionMenu.entry, "copy");
              closeRowActionMenu(false);
            }}
          >
            <Copy aria-hidden="true" size={15} />
            <span>{t("workspace.actions.copy")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              openRenameDialog(event, rowActionMenu.entry);
              closeRowActionMenu(false);
            }}
          >
            <PencilLine aria-hidden="true" size={15} />
            <span>{t("workspace.actions.rename")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={(event) => {
              openDeleteDialog(event, rowActionMenu.entry);
              closeRowActionMenu(false);
            }}
          >
            <Trash2 aria-hidden="true" size={15} />
            <span>{t("workspace.actions.delete")}</span>
          </button>
        </div>
      ) : null}

      {createFolderOpen ? (
        <div className="file-action-backdrop" role="presentation">
          <form
            className="file-action-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-create-folder-title"
            onSubmit={(event) => void submitCreateFolder(event)}
          >
            <header>
              <span className="eyebrow">{t("workspace.actions.newFolder")}</span>
              <h2 id="file-create-folder-title">{createFolderLocation}</h2>
            </header>

            <label className="file-action-field">
              <span>{t("workspace.actions.folderName")}</span>
              <input
                autoFocus
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                aria-describedby="file-create-folder-hint"
              />
            </label>

            <p id="file-create-folder-hint" className="file-action-hint">
              {t("workspace.actions.createFolderHint")}
            </p>
            <footer>
              <button type="button" className="secondary-button" onClick={closeActionDialog} disabled={operationSubmitting}>
                {t("common.actions.cancel")}
              </button>
              <button type="submit" className="primary-button" disabled={operationSubmitting || folderNameInvalid} aria-busy={operationSubmitting || undefined}>
                {operationSubmitting ? t("common.actions.saving") : t("workspace.actions.requestCreateFolder")}
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      {renameEntry ? (
        <div className="file-action-backdrop" role="presentation">
          <form className="file-action-dialog" role="dialog" aria-modal="true" aria-labelledby="file-rename-title" onSubmit={submitRename}>
            <header>
              <span className="eyebrow">{t("workspace.actions.rename")}</span>
              <h2 id="file-rename-title">{renameEntry.name}</h2>
            </header>

            <label className="file-action-field">
              <span>{t("workspace.actions.newName")}</span>
              <input
                autoFocus
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
                aria-describedby="file-rename-hint"
              />
            </label>

            <p id="file-rename-hint" className="file-action-hint">{t("workspace.actions.renameHint")}</p>

            <footer>
              <button type="button" className="secondary-button" onClick={closeActionDialog} disabled={operationSubmitting}>
                {t("common.actions.cancel")}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={operationSubmitting || renameNameInvalid || renameNameUnchanged}
                aria-busy={operationSubmitting || undefined}
              >
                {operationSubmitting ? t("common.actions.saving") : t("workspace.actions.requestRename")}
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      {deleteState ? (
        <div className="file-action-backdrop" role="presentation">
          <section className="file-action-dialog" role="dialog" aria-modal="true" aria-labelledby="file-delete-title">
            <header>
              <span className="eyebrow">{t("workspace.actions.delete")}</span>
              <h2 id="file-delete-title">{deleteTitle}</h2>
            </header>

            <p className="file-action-copy">{deleteBody}</p>
            <footer>
              <button type="button" className="secondary-button" onClick={closeActionDialog} disabled={operationSubmitting}>
                {t("common.actions.cancel")}
              </button>
              <button type="button" className="danger-button" onClick={() => void submitDelete()} disabled={operationSubmitting} aria-busy={operationSubmitting || undefined}>
                {operationSubmitting
                  ? t("common.actions.saving")
                  : t("workspace.batch.confirmDelete")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {transferState ? (
        <div className="file-action-backdrop" role="presentation">
          <form
            className="file-action-dialog transfer-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-transfer-title"
            onSubmit={(event) => void submitTransfer(event)}
          >
            <header>
              <span className="eyebrow">
                {transferState.operation === "move" ? t("workspace.actions.move") : t("workspace.actions.copy")}
              </span>
              <h2 id="file-transfer-title">{transferState.entry.name}</h2>
            </header>

            <div className="file-transfer-route" aria-label={t("workspace.actions.transferPreview")}>
              <span>{selectedStoragePool ? poolRelativePath(transferState.entry.path, selectedStoragePool.path) : transferState.entry.path}</span>
              <FolderInput aria-hidden="true" size={15} />
              <strong>{transferTargetPath || t("workspace.actions.chooseFolder")}</strong>
            </div>

            <label className="file-action-field">
              <span>{t("workspace.actions.destinationFolder")}</span>
              <input
                autoFocus
                value={transferTargetDirectory}
                onChange={(event) => setTransferTargetDirectory(event.target.value)}
                placeholder="."
                aria-describedby="file-transfer-hint"
              />
            </label>

            <p id="file-transfer-hint" className="file-action-hint">
              {t("workspace.actions.transferHint")}
            </p>
            <footer>
              <button type="button" className="secondary-button" onClick={closeActionDialog} disabled={operationSubmitting}>
                {t("common.actions.cancel")}
              </button>
              <button type="submit" className="primary-button" disabled={operationSubmitting || transferTargetInvalid} aria-busy={operationSubmitting || undefined}>
                {operationSubmitting
                  ? t("common.actions.saving")
                  : transferState.operation === "move"
                    ? t("workspace.actions.requestMove")
                    : t("workspace.actions.requestCopy")}
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      {batchMoveEntries && selectedStoragePool ? (
        <StorageFilePickerDialog
          pools={[selectedStoragePool]}
          initialPoolId={selectedStoragePool.id}
          locale={locale}
          mode="directory"
          directoryPurpose="fileMove"
          initialPath={currentPath}
          boundaryPath={selectedStoragePool.path}
          directorySelectionDisabled={(path) => isInvalidFileMoveDestination(batchMoveEntries, path)}
          directorySelectionDisabledReason={t("workspace.batch.invalidDestination")}
          onCancel={() => {
            if (!operationSubmitting) setBatchMoveEntries(null);
          }}
          onSelect={(selection) => void submitBatchMove(selection.path)}
        />
      ) : null}

    </section>
  );
}

function isArchiveFileName(name: string): boolean {
  return /\.(?:zip|tar|gz|tgz|rar)$/iu.test(name);
}

function triggerBrowserDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function poolRelativePath(pathname: string, poolPath: string): string {
  if (pathname === poolPath) {
    return ".";
  }
  const prefix = `${poolPath}/`;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) || "." : pathname;
}

function gitFileStatusCode(status: NonNullable<FileEntry["gitStatus"]>): string {
  switch (status) {
    case "tracked":
      return "T";
    case "staged":
      return "S";
    case "modified":
      return "M";
    case "untracked":
      return "U";
    case "conflicted":
      return "C";
  }
}
