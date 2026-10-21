export type UploadStatus = "queued" | "uploading" | "completed" | "failed" | "cancelled";

export interface UploadSource {
  file: File;
  relativePath: string;
}

export interface UploadItemState {
  id: string;
  file: File;
  name: string;
  relativePath: string;
  targetPath: string;
  sizeBytes: number;
  uploadedBytes: number;
  status: UploadStatus;
  error: string | null;
}

export interface UploadBatchState {
  id: string;
  rootId: string;
  storagePoolId: string;
  targetPath: string;
  createdAt: string;
  status: UploadStatus;
  items: UploadItemState[];
  currentItemId: string | null;
  error: string | null;
}

export function isUploadBatchActive(batch: UploadBatchState): boolean {
  return batch.status === "queued" || batch.status === "uploading";
}

export function pruneUploadBatchHistory(
  batches: UploadBatchState[],
  maxRecentTerminalBatches: number
): UploadBatchState[] {
  if (maxRecentTerminalBatches < 0) {
    throw new Error("Upload batch history limit cannot be negative");
  }

  const terminalBatches = batches
    .filter((batch) => !isUploadBatchActive(batch))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (terminalBatches.length <= maxRecentTerminalBatches) {
    return batches;
  }

  const retainedIds = new Set(terminalBatches.slice(0, maxRecentTerminalBatches).map((batch) => batch.id));
  return batches.filter((batch) => isUploadBatchActive(batch) || retainedIds.has(batch.id));
}

export function normalizeUploadRelativePath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/").trim();
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    throw new Error("Upload paths cannot escape the selected folder");
  }
  if (!segments.length) {
    throw new Error("Upload path is required");
  }

  return segments.join("/");
}

export function normalizeNasPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/").trim();
  if (!normalized || normalized === ".") {
    return ".";
  }

  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    throw new Error("Upload target cannot escape the selected root");
  }

  return segments.length ? segments.join("/") : ".";
}

export function joinNasPath(basePath: string, relativePath: string): string {
  const normalizedBase = normalizeNasPath(basePath);
  const normalizedRelative = normalizeUploadRelativePath(relativePath);

  if (normalizedBase === ".") {
    return normalizedRelative;
  }

  return `${normalizedBase}/${normalizedRelative}`;
}

export function collectUploadSourcesFromFileList(files: FileList | readonly File[]): UploadSource[] {
  return Array.from(files, (file) => ({
    file,
    relativePath: normalizeUploadRelativePath(getUploadRelativePath(file))
  }));
}

export async function collectUploadSourcesFromDataTransfer(dataTransfer: DataTransfer): Promise<UploadSource[]> {
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length) {
    const sources = await Promise.all(items.map((item) => collectUploadSourcesFromDataTransferItem(item)));
    const flattened = sources.flat();
    if (flattened.length) {
      return flattened;
    }
  }

  return collectUploadSourcesFromFileList(dataTransfer.files);
}

export function createUploadBatch(input: {
  id: string;
  rootId: string;
  storagePoolId: string;
  currentPath: string;
  sources: UploadSource[];
}): UploadBatchState {
  if (!input.sources.length) {
    throw new Error("No files selected for upload");
  }

  const targetPath = normalizeNasPath(input.currentPath);
  return {
    id: input.id,
    rootId: input.rootId,
    storagePoolId: input.storagePoolId,
    targetPath,
    createdAt: new Date().toISOString(),
    status: "queued",
    items: input.sources.map((source, index) => {
      const relativePath = normalizeUploadRelativePath(source.relativePath);
      return {
        id: `${input.id}:${index}`,
        file: source.file,
        name: relativePath.split("/").pop() ?? source.file.name,
        relativePath,
        targetPath: joinNasPath(targetPath, relativePath),
        sizeBytes: source.file.size,
        uploadedBytes: 0,
        status: "queued",
        error: null
      };
    }),
    currentItemId: `${input.id}:0`,
    error: null
  };
}

export function updateUploadBatch(
  batches: UploadBatchState[],
  batchId: string,
  updater: (batch: UploadBatchState) => UploadBatchState
): UploadBatchState[] {
  return batches.map((batch) => (batch.id === batchId ? updater(batch) : batch));
}

export function removeUploadBatch(batches: UploadBatchState[], batchId: string): UploadBatchState[] {
  return batches.filter((batch) => batch.id !== batchId);
}

export function updateUploadBatchItem(
  batch: UploadBatchState,
  itemId: string,
  updater: (item: UploadItemState) => UploadItemState
): UploadBatchState {
  return {
    ...batch,
    items: batch.items.map((item) => (item.id === itemId ? updater(item) : item))
  };
}

async function collectUploadSourcesFromDataTransferItem(item: DataTransferItem): Promise<UploadSource[]> {
  const entry = getDataTransferItemEntry(item);
  if (entry) {
    return await collectUploadSourcesFromEntry(entry, "");
  }

  const file = item.getAsFile();
  if (!file) {
    return [];
  }

  return [
    {
      file,
      relativePath: normalizeUploadRelativePath(getUploadRelativePath(file))
    }
  ];
}

async function collectUploadSourcesFromEntry(entry: UploadFileSystemEntry, prefix: string): Promise<UploadSource[]> {
  if (entry.isFile) {
    const file = await readFileFromEntry(entry as UploadFileEntry);
    const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
    return [
      {
        file,
        relativePath: normalizeUploadRelativePath(relativePath)
      }
    ];
  }

  if (entry.isDirectory) {
    const directory = entry as UploadDirectoryEntry;
    const nextPrefix = prefix ? `${prefix}/${directory.name}` : directory.name;
    const children = await readAllDirectoryEntries(directory.createReader());
    const nested = await Promise.all(children.map((child) => collectUploadSourcesFromEntry(child, nextPrefix)));
    return nested.flat();
  }

  return [];
}

async function readAllDirectoryEntries(reader: UploadDirectoryReader): Promise<UploadFileSystemEntry[]> {
  const entries: UploadFileSystemEntry[] = [];
  while (true) {
    // The callback API returns chunks until an empty list signals completion.
    const chunk = await new Promise<UploadFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!chunk.length) {
      break;
    }
    entries.push(...chunk);
  }

  return entries;
}

function getUploadRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function getDataTransferItemEntry(item: DataTransferItem): UploadFileSystemEntry | null {
  const typedItem = item as DataTransferItem & {
    webkitGetAsEntry?: () => UploadFileSystemEntry | null;
  };
  return typedItem.webkitGetAsEntry?.() ?? null;
}

function readFileFromEntry(entry: UploadFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

interface UploadFileSystemEntry {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
}

interface UploadFileEntry extends UploadFileSystemEntry {
  readonly isFile: true;
  readonly isDirectory: false;
  file: (success: (file: File) => void, error?: (error: DOMException) => void) => void;
}

interface UploadDirectoryReader {
  readEntries: (success: (entries: UploadFileSystemEntry[]) => void, error?: (error: DOMException) => void) => void;
}

interface UploadDirectoryEntry extends UploadFileSystemEntry {
  readonly isFile: false;
  readonly isDirectory: true;
  createReader: () => UploadDirectoryReader;
}
