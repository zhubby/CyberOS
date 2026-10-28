import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowUp,
  Check,
  Disc3,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { getFiles, type FileEntry } from "../../api.js";
import { formatBytes } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";

export interface StorageFilePickerPool {
  id: string;
  name: string;
  path: string;
  filesystem: string | null;
  status: "ready" | "warning" | "offline" | "unknown";
}

export interface StorageFileSelection {
  storagePoolId: string;
  path: string;
  name: string;
}

export function StorageFilePickerDialog({
  pools,
  initialPoolId,
  locale,
  mode = "iso",
  directoryPurpose = "downloads",
  initialPath,
  boundaryPath,
  directorySelectionDisabled,
  directorySelectionDisabledReason,
  onCancel,
  onSelect,
  onSelectMany,
  onRequestCreateFolder
}: {
  pools: StorageFilePickerPool[];
  initialPoolId: string;
  locale: SupportedLocale;
  mode?: "iso" | "directory" | "files";
  directoryPurpose?: "downloads" | "photoMove" | "fileMove" | "bluetoothInbox" | "mediaLibrary";
  initialPath?: string;
  boundaryPath?: string;
  directorySelectionDisabled?: (path: string) => boolean;
  directorySelectionDisabledReason?: string;
  onCancel: () => void;
  onSelect: (selection: StorageFileSelection) => void;
  onSelectMany?: (selections: StorageFileSelection[]) => void;
  onRequestCreateFolder?: (input: {
    storagePoolId: string;
    parentPath: string;
    name: string;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const availablePools = useMemo(() => pools.filter((pool) => pool.status !== "offline"), [pools]);
  const initialPool = availablePools.find((pool) => pool.id === initialPoolId) ?? availablePools[0] ?? null;
  const [selectedPoolId, setSelectedPoolId] = useState(initialPool?.id ?? "");
  const selectedPool = availablePools.find((pool) => pool.id === selectedPoolId) ?? null;
  const [currentPath, setCurrentPath] = useState(initialPath ?? initialPool?.path ?? ".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selection, setSelection] = useState<FileEntry | null>(null);
  const [multiSelection, setMultiSelection] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createFolderName, setCreateFolderName] = useState("");
  const [createFolderSubmitting, setCreateFolderSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const loadRequestId = useRef(0);
  const directoryCopy = directoryPurpose === "bluetoothInbox"
    ? {
        eyebrow: t("settings.bluetooth.inbox.location"),
        title: t("settings.bluetooth.inbox.pickerTitle"),
        description: t("settings.bluetooth.inbox.pickerDescription"),
        list: t("settings.bluetooth.inbox.pickerList"),
        empty: t("settings.bluetooth.inbox.pickerEmpty"),
        select: t("settings.bluetooth.inbox.useDirectory")
      }
    : directoryPurpose === "mediaLibrary"
      ? {
          eyebrow: t("settings.media.sourceDirectory"),
          title: t("settings.media.pickerTitle"),
          description: t("settings.media.pickerDescription"),
          list: t("settings.media.pickerList"),
          empty: t("settings.media.pickerEmpty"),
          select: t("settings.media.useDirectory")
        }
    : directoryPurpose === "photoMove"
    ? {
        eyebrow: t("workspace.photos.moveDestination"),
        title: t("workspace.photos.movePickerTitle"),
        description: t("workspace.photos.movePickerDescription"),
        list: t("workspace.photos.directoryPickerList"),
        empty: t("workspace.photos.directoryPickerEmpty"),
        select: t("workspace.photos.useMoveDestination")
      }
    : directoryPurpose === "fileMove"
      ? {
          eyebrow: t("workspace.batch.destination"),
          title: t("workspace.batch.movePickerTitle"),
          description: t("workspace.batch.movePickerDescription"),
          list: t("workspace.batch.directoryList"),
          empty: t("workspace.batch.directoryEmpty"),
          select: t("workspace.batch.useDestination")
        }
      : {
        eyebrow: t("workspace.downloads.targetDirectory"),
        title: t("workspace.downloads.directoryPickerTitle"),
        description: t("workspace.downloads.directoryPickerDescription"),
        list: t("workspace.downloads.directoryPickerList"),
        empty: t("workspace.downloads.directoryPickerEmpty"),
        select: t("workspace.downloads.selectCurrentDirectory")
      };
  const fileCopy = {
    eyebrow: t("workspace.management.virtualMachines.createIsoSource"),
    title: t("workspace.management.virtualMachines.isoPickerTitle"),
    description: t("workspace.management.virtualMachines.isoPickerDescription"),
    list: t("workspace.management.virtualMachines.isoPickerFiles"),
    empty: t("workspace.management.virtualMachines.isoPickerEmpty"),
    none: t("workspace.management.virtualMachines.isoPickerNoneSelected"),
    select: t("workspace.management.virtualMachines.isoPickerSelect")
  };
  const multiFileCopy = {
    eyebrow: t("settings.bluetooth.transfers.sendFiles"),
    title: t("settings.bluetooth.transfers.filePickerTitle"),
    description: t("settings.bluetooth.transfers.filePickerDescription"),
    list: t("settings.bluetooth.transfers.filePickerList"),
    empty: t("settings.bluetooth.transfers.filePickerEmpty"),
    none: t("settings.bluetooth.transfers.filePickerNone"),
    select: t("settings.bluetooth.transfers.filePickerSelect", { count: multiSelection.length })
  };
  const activeFileCopy = mode === "files" ? multiFileCopy : fileCopy;
  const pickerRootPath = boundaryPath && selectedPool?.id === initialPool?.id ? boundaryPath : selectedPool?.path ?? ".";
  const currentDirectoryDisabled = mode === "directory" && Boolean(directorySelectionDisabled?.(currentPath));

  const loadDirectory = useCallback(async () => {
    if (!selectedPool) {
      setEntries([]);
      return;
    }
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const listing = await getFiles(selectedPool.id, currentPath);
      if (requestId !== loadRequestId.current) return;
      setEntries(listing.entries.filter((entry) => mode === "directory"
        ? isDirectoryPickerEntry(entry)
        : mode === "files"
          ? isMultiFilePickerEntry(entry)
          : isIsoPickerEntry(entry)));
    } catch (nextError) {
      if (requestId !== loadRequestId.current) return;
      setEntries([]);
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  }, [currentPath, mode, selectedPool]);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  useEffect(() => () => {
    loadRequestId.current += 1;
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previouslyFocused?.isConnected) {
        window.requestAnimationFrame(() => previouslyFocused.focus());
      }
    };
  }, []);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);

  const breadcrumbs = selectedPool ? pickerBreadcrumbs(pickerRootPath, currentPath) : [];

  function changePool(poolId: string) {
    const pool = availablePools.find((candidate) => candidate.id === poolId);
    if (!pool) return;
    setSelectedPoolId(pool.id);
    setCurrentPath(pool.path);
    setSelection(null);
    setMultiSelection([]);
  }

  function openDirectory(path: string) {
    setCurrentPath(path);
    setSelection(null);
  }

  function confirmSelection() {
    if (!selectedPool) return;
    if (mode === "directory") {
      if (currentDirectoryDisabled) return;
      onSelect({
        storagePoolId: selectedPool.id,
        path: currentPath,
        name: currentPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? selectedPool.name
      });
      return;
    }
    if (mode === "files") {
      if (multiSelection.length === 0 || !onSelectMany) return;
      onSelectMany(multiSelection.map((entry) => ({
        storagePoolId: selectedPool.id,
        path: entry.path,
        name: entry.name
      })));
      return;
    }
    if (!selection) return;
    onSelect({
      storagePoolId: selectedPool.id,
      path: selection.path,
      name: selection.name
    });
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    ) ?? [])].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogRef.current?.focus();
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

  async function submitCreateFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createFolderName.trim();
    if (
      !selectedPool ||
      !onRequestCreateFolder ||
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      createFolderSubmitting
    ) {
      return;
    }

    setCreateFolderSubmitting(true);
    setError(null);
    try {
      await onRequestCreateFolder({
        storagePoolId: selectedPool.id,
        parentPath: currentPath,
        name
      });
      onCancel();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCreateFolderSubmitting(false);
    }
  }

  return (
    <div
      className="management-dialog-backdrop storage-file-picker-backdrop"
      role="presentation"
      onMouseDown={(event) => event.currentTarget === event.target && onCancel()}
    >
      <div
        ref={dialogRef}
        className="management-dialog storage-file-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-file-picker-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="storage-file-picker-header">
          <div className="storage-file-picker-heading">
            <span className="vm-create-icon" aria-hidden="true">{mode === "directory" ? <FolderOpen size={20} /> : mode === "files" ? <File size={20} /> : <Disc3 size={20} />}</span>
            <div>
              <span className="eyebrow">
                {mode === "directory"
                  ? directoryCopy.eyebrow
                  : activeFileCopy.eyebrow}
              </span>
              <h3 id="storage-file-picker-title">
                {mode === "directory"
                  ? directoryCopy.title
                  : activeFileCopy.title}
              </h3>
              <p>
                {mode === "directory"
                  ? directoryCopy.description
                  : activeFileCopy.description}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="management-icon-action"
            onClick={onCancel}
            aria-label={mode === "directory"
              ? t("common.actions.close")
              : t("workspace.management.virtualMachines.isoPickerClose")}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        <div className="storage-file-picker-layout">
          <aside className="storage-file-picker-pools">
            <div className="storage-file-picker-pools-heading">
              <span>{t("workspace.storagePoolLabel")}</span>
              <small>{t("workspace.selectStoragePoolBody")}</small>
            </div>
            <div className="storage-file-picker-pool-list" role="listbox" aria-label={t("workspace.storagePoolLabel")}>
              {availablePools.length === 0 ? (
                <div className="storage-file-picker-pool-empty">
                  <HardDrive aria-hidden="true" size={18} />
                  <span>{t("workspace.management.virtualMachines.isoPickerNoPools")}</span>
                </div>
              ) : (
                availablePools.map((pool) => (
                  <button
                    key={pool.id}
                    type="button"
                    className={`storage-file-picker-pool${selectedPoolId === pool.id ? " is-selected" : ""}`}
                    role="option"
                    aria-selected={selectedPoolId === pool.id}
                    onClick={() => changePool(pool.id)}
                  >
                    <span className="storage-file-picker-pool-icon"><HardDrive aria-hidden="true" size={16} /></span>
                    <span className="storage-file-picker-pool-copy">
                      <strong>{pool.name}</strong>
                      <small>{[pool.filesystem, pool.path].filter(Boolean).join(" · ")}</small>
                    </span>
                    <span className="storage-file-picker-pool-state" data-state={pool.status}>
                      {pool.status === "ready" ? t("workspace.storagePoolStates.ready") : pool.status === "warning" ? t("workspace.storagePoolStates.warning") : t("workspace.storagePoolStates.unknown")}
                    </span>
                    {selectedPoolId === pool.id ? <Check aria-hidden="true" size={14} /> : null}
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="storage-file-picker-browser">
            <div className="storage-file-picker-toolbar">
              <div className="storage-file-picker-location">
                <span>{mode === "directory" ? directoryCopy.eyebrow : activeFileCopy.list}</span>
                <nav className="storage-file-picker-breadcrumbs" aria-label={t("workspace.breadcrumbs")}>
                  {selectedPool ? (
                    <button type="button" onClick={() => openDirectory(pickerRootPath)}>
                      <HardDrive aria-hidden="true" size={13} />
                      <span>{selectedPool.name}</span>
                    </button>
                  ) : null}
                  {breadcrumbs.map((crumb) => (
                    <button key={crumb.path} type="button" onClick={() => openDirectory(crumb.path)}>
                      <span>{crumb.name}</span>
                    </button>
                  ))}
                </nav>
              </div>
              <div className="storage-file-picker-toolbar-actions">
                {mode === "directory" && onRequestCreateFolder ? (
                  createFolderOpen ? (
                    <form className="storage-file-picker-create-folder" onSubmit={(event) => void submitCreateFolder(event)}>
                      <input
                        autoFocus
                        value={createFolderName}
                        onChange={(event) => setCreateFolderName(event.target.value)}
                        placeholder={t("workspace.downloads.newFolderPlaceholder")}
                        aria-label={t("workspace.actions.folderName")}
                        disabled={createFolderSubmitting}
                      />
                      <button type="submit" disabled={createFolderSubmitting || !createFolderName.trim()} aria-busy={createFolderSubmitting || undefined} title={t("workspace.downloads.requestCreateFolder")} aria-label={t("workspace.downloads.requestCreateFolder")}>
                        {createFolderSubmitting ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : <Check aria-hidden="true" size={14} />}
                      </button>
                      <button type="button" onClick={() => { setCreateFolderOpen(false); setCreateFolderName(""); }} disabled={createFolderSubmitting} title={t("common.actions.cancel")} aria-label={t("common.actions.cancel")}>
                        <X aria-hidden="true" size={14} />
                      </button>
                    </form>
                  ) : (
                    <button type="button" className="storage-file-picker-create-folder-trigger" onClick={() => setCreateFolderOpen(true)} disabled={!selectedPool || loading} title={t("workspace.downloads.newFolder")} aria-label={t("workspace.downloads.newFolder")}>
                      <FolderPlus aria-hidden="true" size={15} />
                      <span>{t("workspace.downloads.newFolder")}</span>
                    </button>
                  )
                ) : null}
                <button
                  type="button"
                  className="storage-file-picker-up"
                  onClick={() => selectedPool && openDirectory(parentPickerPath(pickerRootPath, currentPath))}
                  disabled={!selectedPool || currentPath === pickerRootPath || loading}
                  title={t("common.actions.up")}
                  aria-label={t("common.actions.up")}
                >
                  <ArrowUp aria-hidden="true" size={15} />
                </button>
              </div>
            </div>

            <div
              className="storage-file-picker-list"
              role="listbox"
              aria-label={mode === "directory"
                ? directoryCopy.list
                : activeFileCopy.list}
            >
              {loading ? (
                <div className="storage-file-picker-state"><LoaderCircle className="is-spinning" aria-hidden="true" size={19} /><span>{t("common.states.loading")}</span></div>
              ) : error ? (
                <div className="storage-file-picker-state storage-file-picker-error">
                  <span>{error}</span>
                  <button type="button" onClick={() => void loadDirectory()}><RefreshCw aria-hidden="true" size={14} />{t("common.actions.refresh")}</button>
                </div>
              ) : !selectedPool ? (
                <div className="storage-file-picker-state"><HardDrive aria-hidden="true" size={19} /><span>{t("workspace.management.virtualMachines.isoPickerNoPools")}</span></div>
              ) : entries.length === 0 ? (
                <div className="storage-file-picker-state">
                  {mode === "directory" ? <Folder aria-hidden="true" size={19} /> : mode === "files" ? <File aria-hidden="true" size={19} /> : <Disc3 aria-hidden="true" size={19} />}
                  <span>{mode === "directory" ? directoryCopy.empty : activeFileCopy.empty}</span>
                </div>
              ) : (
                entries.map((entry) => {
                  const isDirectory = entry.kind === "directory";
                  const isSelected = mode === "files"
                    ? multiSelection.some((candidate) => candidate.path === entry.path)
                    : selection?.path === entry.path;
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className={`storage-file-picker-row${isSelected ? " is-selected" : ""}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        if (isDirectory) {
                          openDirectory(entry.path);
                        } else if (mode === "files") {
                          setMultiSelection((current) => current.some((candidate) => candidate.path === entry.path)
                            ? current.filter((candidate) => candidate.path !== entry.path)
                            : current.length >= 100 ? current : [...current, entry]);
                        } else {
                          setSelection(entry);
                        }
                      }}
                    >
                      <span className="storage-file-picker-file-icon" data-kind={isDirectory ? "directory" : "iso"}>
                        {isDirectory ? <Folder aria-hidden="true" size={17} /> : mode === "files" ? <File aria-hidden="true" size={17} /> : <Disc3 aria-hidden="true" size={17} />}
                      </span>
                      <span className="storage-file-picker-file-name">{entry.name}</span>
                      <span className="storage-file-picker-file-meta">
                        {isDirectory
                          ? mode === "directory"
                            ? t("workspace.downloads.directoryPickerFolder")
                            : t("workspace.management.virtualMachines.isoPickerFolder")
                          : formatBytes(entry.sizeBytes, locale)}
                      </span>
                      {isSelected ? <Check aria-hidden="true" size={15} /> : null}
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </div>

        <footer className="storage-file-picker-footer">
          {mode === "directory" ? (
            <span title={currentPath}>{currentPath}</span>
          ) : (
            <span title={selection?.path}>{mode === "files"
              ? multiSelection.length > 0
                ? t("settings.bluetooth.transfers.filesSelected", { count: multiSelection.length })
                : activeFileCopy.none
              : selection?.name ?? fileCopy.none}</span>
          )}
          <div>
            <button type="button" onClick={onCancel}>{t("common.actions.cancel")}</button>
            <button
              type="button"
              className="vm-create-submit"
              onClick={confirmSelection}
              disabled={currentDirectoryDisabled || (mode === "files" ? multiSelection.length === 0 : mode !== "directory" && !selection)}
              title={currentDirectoryDisabled ? directorySelectionDisabledReason : undefined}
            >
              {mode === "directory" ? directoryCopy.select : activeFileCopy.select}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function isIsoPickerEntry(entry: FileEntry): boolean {
  return entry.isSafe && (entry.kind === "directory" || (entry.kind === "file" && entry.name.toLowerCase().endsWith(".iso")));
}

export function isDirectoryPickerEntry(entry: FileEntry): boolean {
  return entry.isSafe && entry.kind === "directory";
}

export function isMultiFilePickerEntry(entry: FileEntry): boolean {
  return entry.isSafe && (entry.kind === "directory" || entry.kind === "file");
}

export function parentPickerPath(poolPath: string, currentPath: string): string {
  if (currentPath === poolPath) return poolPath;
  const separator = currentPath.includes("\\") ? "\\" : "/";
  const segments = currentPath.split(/[\\/]/u).filter(Boolean);
  segments.pop();
  const parent = segments.join(separator) || ".";
  return parent.length < poolPath.length ? poolPath : parent;
}

export function pickerBreadcrumbs(poolPath: string, currentPath: string): Array<{ name: string; path: string }> {
  if (currentPath === poolPath) return [];
  const separator = currentPath.includes("\\") ? "\\" : "/";
  const poolSegments = poolPath === "." ? [] : poolPath.split(/[\\/]/u).filter(Boolean);
  const currentSegments = currentPath.split(/[\\/]/u).filter(Boolean);
  return currentSegments.slice(poolSegments.length).map((name, index) => ({
    name,
    path: [...poolSegments, ...currentSegments.slice(poolSegments.length, poolSegments.length + index + 1)].join(separator) || "."
  }));
}
