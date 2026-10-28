import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { FileOperationProposal, FileOperationRecord, StorageWorkspace } from "@cyberos/shared";
import { isPathInside, resolveSafeExistingPath, toRootRelative, PathSafetyError } from "./path-safety.js";

const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;

export type ArchiveKind = "zip" | "tar" | "gzip" | "rar";

export function archiveKindForPath(filePath: string): ArchiveKind | null {
  const fileName = path.basename(filePath).toLocaleLowerCase();
  if (fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz")) {
    return "tar";
  }
  if (fileName.endsWith(".zip")) {
    return "zip";
  }
  if (fileName.endsWith(".tar")) {
    return "tar";
  }
  if (fileName.endsWith(".gz")) {
    return "gzip";
  }
  if (fileName.endsWith(".rar")) {
    return "rar";
  }
  return null;
}

export function defaultExtractionTarget(filePath: string, kind = archiveKindForPath(filePath)): string | null {
  if (!kind) {
    return null;
  }
  const fileName = path.basename(filePath);
  const stem = kind === "tar" && fileName.toLocaleLowerCase().endsWith(".tar.gz")
    ? fileName.slice(0, -7)
    : kind === "tar" && fileName.toLocaleLowerCase().endsWith(".tgz")
      ? fileName.slice(0, -4)
      : fileName.slice(0, -path.extname(fileName).length);
  return path.join(path.dirname(filePath), stem || "extracted");
}

export interface AppliedMutation {
  proposal: FileOperationProposal;
  sourcePath: string | null;
  targetPath: string | null;
  metadata: Record<string, unknown>;
}

export interface RolledBackMutation {
  operation: FileOperationRecord["operation"];
  sourcePath: string | null;
  targetPath: string | null;
  metadata: Record<string, unknown>;
}

export async function applyFileMutation(
  root: StorageWorkspace,
  proposal: FileOperationProposal,
  trashRootPath: string
): Promise<AppliedMutation> {
  switch (proposal.operation) {
    case "mkdir":
      return applyMkdir(root, proposal);
    case "move":
    case "rename":
      return applyMove(root, proposal);
    case "copy":
      return applyCopy(root, proposal);
    case "trash":
      return applyTrash(root, proposal, trashRootPath);
    case "edit":
      return applyEditAuthorization(root, proposal);
    case "extract":
      return applyExtract(root, proposal);
    case "restore":
      throw new Error("Restore must use restoreTrashEntry with a persisted trash entry");
    case "tag":
      if (!proposal.sourcePath || !proposal.tag) {
        throw new Error("tag requires sourcePath and tag");
      }
      {
        const source = await resolveSafeExistingPath(root.path, proposal.sourcePath);
        return {
          proposal,
          sourcePath: source.relativePath,
          targetPath: proposal.tag,
          metadata: { tag: proposal.tag, absoluteSourcePath: source.realPath }
        };
      }
    case "upload":
    case "download":
      throw new Error("Upload mutations are applied directly and do not use applyFileMutation");
    default:
      throw new Error(`Unsupported file mutation operation: ${proposal.operation}`);
  }
}

export async function restoreTrashPath(
  root: StorageWorkspace,
  input: { storagePoolId: string; trashPath: string; originalPath: string }
): Promise<AppliedMutation> {
  const trash = await resolveSafeExistingPath(path.dirname(input.trashPath), path.basename(input.trashPath));
  const target = await resolveSafeTargetPath(root.path, input.originalPath);
  // The target may not exist yet, so lexical containment alone cannot detect a
  // parent symlink that would redirect the restore outside the storage pool.
  await assertNoSymlinkPathSegments(target.rootRealPath, path.dirname(target.absolutePath));
  await assertTargetDoesNotExist(target.absolutePath);
  await mkdir(path.dirname(target.absolutePath), { recursive: true });
  await movePath(trash.realPath, target.absolutePath);

  return {
    proposal: {
      operation: "restore",
      storagePoolId: input.storagePoolId,
      sourcePath: input.trashPath,
      targetPath: target.relativePath,
      risk: "medium",
      reversible: true,
      summary: `Restore ${input.originalPath}`
    },
    sourcePath: input.trashPath,
    targetPath: target.relativePath,
    metadata: { restoredTo: target.absolutePath }
  };
}

export async function rollbackFileMutation(
  root: StorageWorkspace,
  operation: FileOperationRecord,
  trashRootPath: string
): Promise<RolledBackMutation> {
  if (operation.status !== "applied") {
    throw new Error("Only applied operations can be rolled back");
  }

  switch (operation.operation) {
    case "move":
    case "rename":
      return rollbackMove(root, operation);
    case "copy":
    case "mkdir":
    case "restore":
    case "upload":
    case "download":
      return rollbackByTrashingTarget(root, operation, trashRootPath);
    case "trash":
      throw new Error("Trash rollback must restore the persisted trash entry");
    case "edit":
      throw new Error("Edit operations cannot be rolled back");
    case "extract":
      return rollbackByTrashingTarget(root, operation, trashRootPath);
    case "tag":
      return {
        operation: "tag",
        sourcePath: operation.sourcePath,
        targetPath: operation.targetPath,
        metadata: {
          rollbackOf: operation.id,
          noFilesystemChange: true
        }
      };
  }
}

export async function resolveSafeTargetPath(
  rootPath: string,
  requestedPath: string
): Promise<{ rootRealPath: string; absolutePath: string; relativePath: string }> {
  if (!requestedPath || path.isAbsolute(requestedPath)) {
    throw new PathSafetyError("Mutation target must be a relative path inside the storage pool");
  }

  const root = await resolveSafeExistingPath(rootPath, ".");
  const absolutePath = path.resolve(root.rootRealPath, requestedPath);
  if (!isPathInside(root.rootRealPath, absolutePath)) {
    throw new PathSafetyError("Mutation target escapes the storage pool");
  }

  const parentPath = path.dirname(absolutePath);
  if (!isPathInside(root.rootRealPath, parentPath)) {
    throw new PathSafetyError("Mutation target parent escapes the storage pool");
  }

  return {
    rootRealPath: root.rootRealPath,
    absolutePath,
    relativePath: toRootRelative(root.rootRealPath, absolutePath)
  };
}

export function trashPathFor(
  trashRootPath: string,
  storagePoolId: string,
  sourcePath: string,
  requestedId?: string
): { id: string; relativeTrashPath: string; absoluteTrashPath: string } {
  const id = requestedId ?? randomUUID();
  const basename = path.basename(sourcePath);
  const relativeTrashPath = path.join(storagePoolId, `${id}-${basename}`);
  return {
    id,
    relativeTrashPath,
    absoluteTrashPath: path.join(trashRootPath, relativeTrashPath)
  };
}

async function applyMkdir(root: StorageWorkspace, proposal: FileOperationProposal): Promise<AppliedMutation> {
  if (!proposal.targetPath) {
    throw new Error("mkdir requires targetPath");
  }

  const target = await resolveSafeTargetPath(root.path, proposal.targetPath);
  await assertNoSymlinkPathSegments(target.rootRealPath, path.dirname(target.absolutePath));
  await mkdir(target.absolutePath, { recursive: false });
  return {
    proposal,
    sourcePath: null,
    targetPath: target.relativePath,
    metadata: { absoluteTargetPath: target.absolutePath }
  };
}

async function applyMove(root: StorageWorkspace, proposal: FileOperationProposal): Promise<AppliedMutation> {
  if (!proposal.sourcePath || !proposal.targetPath) {
    throw new Error(`${proposal.operation} requires sourcePath and targetPath`);
  }

  const source = await resolveSafeExistingPath(root.path, proposal.sourcePath);
  const target = await resolveSafeTargetPath(root.path, proposal.targetPath);
  await assertTransferDestinationIsValid(source, target.absolutePath);
  await assertTargetDoesNotExist(target.absolutePath);
  await mkdir(path.dirname(target.absolutePath), { recursive: true });
  await movePath(source.realPath, target.absolutePath);
  return {
    proposal,
    sourcePath: source.relativePath,
    targetPath: target.relativePath,
    metadata: {
      absoluteSourcePath: source.realPath,
      absoluteTargetPath: target.absolutePath
    }
  };
}

async function applyCopy(root: StorageWorkspace, proposal: FileOperationProposal): Promise<AppliedMutation> {
  if (!proposal.sourcePath || !proposal.targetPath) {
    throw new Error("copy requires sourcePath and targetPath");
  }

  const source = await resolveSafeExistingPath(root.path, proposal.sourcePath);
  const target = await resolveSafeTargetPath(root.path, proposal.targetPath);
  await assertTransferDestinationIsValid(source, target.absolutePath);
  await assertTargetDoesNotExist(target.absolutePath);
  await mkdir(path.dirname(target.absolutePath), { recursive: true });
  await cp(source.realPath, target.absolutePath, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  return {
    proposal,
    sourcePath: source.relativePath,
    targetPath: target.relativePath,
    metadata: {
      absoluteSourcePath: source.realPath,
      absoluteTargetPath: target.absolutePath
    }
  };
}

async function applyEditAuthorization(
  root: StorageWorkspace,
  proposal: FileOperationProposal
): Promise<AppliedMutation> {
  if (!proposal.sourcePath) {
    throw new Error("edit requires sourcePath");
  }

  const source = await resolveSafeExistingPath(root.path, proposal.sourcePath);
  const sourceLinkStat = await lstat(source.absolutePath);
  if (sourceLinkStat.isSymbolicLink()) {
    throw new Error("Refusing to edit through a symlink");
  }

  const sourceStat = await stat(source.realPath);
  if (!sourceStat.isFile()) {
    throw new Error("Edit target must be a file");
  }

  return {
    proposal,
    sourcePath: source.relativePath,
    targetPath: null,
    metadata: {
      absoluteSourcePath: source.realPath,
      authorizationOnly: true
    }
  };
}

async function applyTrash(
  root: StorageWorkspace,
  proposal: FileOperationProposal,
  trashRootPath: string
): Promise<AppliedMutation> {
  if (!proposal.sourcePath) {
    throw new Error("trash requires sourcePath");
  }

  const source = await resolveSafeExistingPath(root.path, proposal.sourcePath);
  const trash = trashPathFor(trashRootPath, proposal.storagePoolId, source.relativePath, proposal.trashEntryId);
  await assertTargetDoesNotExist(trash.absoluteTrashPath);
  await mkdir(path.dirname(trash.absoluteTrashPath), { recursive: true });
  await movePath(source.realPath, trash.absoluteTrashPath);
  return {
    proposal: {
      ...proposal,
      trashEntryId: trash.id,
      targetPath: trash.relativeTrashPath
    },
    sourcePath: source.relativePath,
    targetPath: trash.relativeTrashPath,
    metadata: {
      trashEntryId: trash.id,
      absoluteTrashPath: trash.absoluteTrashPath
    }
  };
}

async function applyExtract(root: StorageWorkspace, proposal: FileOperationProposal): Promise<AppliedMutation> {
  if (!proposal.sourcePath || !proposal.targetPath) {
    throw new Error("extract requires sourcePath and targetPath");
  }

  const kind = archiveKindForPath(proposal.sourcePath);
  if (!kind) {
    throw new Error("Unsupported archive format");
  }
  const source = await resolveSafeExistingPath(root.path, proposal.sourcePath);
  const sourceLinkStat = await lstat(source.absolutePath);
  if (sourceLinkStat.isSymbolicLink()) {
    throw new Error("Refusing to extract through a symlink");
  }
  const sourceStat = await stat(source.realPath);
  if (!sourceStat.isFile()) {
    throw new Error("Archive source must be a file");
  }

  const target = await resolveSafeTargetPath(root.path, proposal.targetPath);
  await assertNoSymlinkPathSegments(source.rootRealPath, path.dirname(target.absolutePath));
  await assertTargetDoesNotExist(target.absolutePath);

  if (kind === "gzip") {
    await extractGzipFile(source.realPath, target.absolutePath);
  } else {
    await extractArchiveDirectory(kind, source.realPath, target.absolutePath);
  }

  return {
    proposal,
    sourcePath: source.relativePath,
    targetPath: target.relativePath,
    metadata: {
      absoluteSourcePath: source.realPath,
      absoluteTargetPath: target.absolutePath,
      archiveKind: kind
    }
  };
}

async function extractArchiveDirectory(kind: ArchiveKind, sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: false });
  try {
    const entries = await listArchiveEntries(kind, sourcePath);
    validateArchiveEntries(entries);
    if (kind === "zip") {
      await runCommand("unzip", ["-q", "-n", sourcePath, "-d", targetPath]);
    } else if (kind === "tar") {
      await runCommand("tar", ["-xkf", sourcePath, "-C", targetPath, "--no-same-owner", "--no-same-permissions"]);
    } else {
      try {
        await runCommand("bsdtar", ["-xkf", sourcePath, "-C", targetPath, "--no-same-owner", "--no-same-permissions", "--safe-writes"]);
      } catch (error) {
        if (!isCommandNotFoundOrUnsupported(error)) {
          throw error;
        }
        await runCommand("unrar", ["x", sourcePath, `${targetPath}${path.sep}`]);
      }
    }
    await validateExtractedTree(targetPath);
  } catch (error) {
    await rm(targetPath, { recursive: true, force: true });
    throw error;
  }
}

async function extractGzipFile(sourcePath: string, targetPath: string): Promise<void> {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  const output = createWriteStream(temporaryPath, { flags: "wx" });
  let totalBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_EXTRACTED_BYTES) {
        callback(new Error("Extracted archive exceeds the size limit"));
        return;
      }
      callback(null, chunk);
    }
  });
  const child = spawn("gzip", ["-dc", sourcePath], { stdio: ["ignore", "pipe", "pipe"] });
  const childExit = waitForChild(child);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    if (!child.stdout) {
      throw new Error("Unable to start gzip extractor");
    }
    await pipeline(child.stdout, limiter, output);
    const exitCode = await childExit;
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `gzip exited with code ${exitCode}`);
    }
    await rename(temporaryPath, targetPath);
  } catch (error) {
    child.kill();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function listArchiveEntries(kind: ArchiveKind, sourcePath: string): Promise<string[]> {
  const result = kind === "zip"
    ? await runCommand("unzip", ["-Z1", sourcePath])
    : kind === "tar"
      ? await runCommand("tar", ["-tf", sourcePath])
      : await listRarEntries(sourcePath);
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

async function listRarEntries(sourcePath: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runCommand("bsdtar", ["-tf", sourcePath]);
  } catch (error) {
    if (!isCommandNotFoundOrUnsupported(error)) {
      throw error;
    }
    try {
      return await runCommand("unrar", ["lb", sourcePath]);
    } catch {
      return await runCommand("unrar", ["l", sourcePath]);
    }
  }
}

function isCommandNotFoundOrUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : String(error).toLocaleLowerCase();
  return message.includes("enoent") || message.includes("not found") || message.includes("unrecognized archive") || message.includes("unsupported");
}

export function validateArchiveEntries(entries: string[]): void {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Archive contains too many entries (limit ${MAX_ARCHIVE_ENTRIES})`);
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (!normalized || normalized.includes("\0") || path.posix.isAbsolute(normalized) || /^[a-z]:\//iu.test(normalized)) {
      throw new Error("Archive contains an unsafe absolute path");
    }
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === "..")) {
      throw new Error("Archive contains a path traversal entry");
    }
  }
}

async function validateExtractedTree(rootPath: string): Promise<void> {
  let entryCount = 0;
  let totalBytes = 0;
  const pending = [rootPath];
  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) {
      continue;
    }
    const currentStat = await lstat(currentPath);
    if (currentStat.isSymbolicLink()) {
      throw new Error("Archives containing symbolic links are not supported");
    }
    if (!isPathInside(rootPath, currentPath)) {
      throw new Error("Archive extraction escaped its destination");
    }
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Archive contains too many entries (limit ${MAX_ARCHIVE_ENTRIES})`);
    }
    if (currentStat.isFile()) {
      totalBytes += currentStat.size;
      if (totalBytes > MAX_EXTRACTED_BYTES) {
        throw new Error("Extracted archive exceeds the size limit");
      }
    } else if (currentStat.isDirectory()) {
      const children = await readdir(currentPath);
      pending.push(...children.map((child) => path.join(currentPath, child)));
    } else {
      throw new Error("Archives containing special files are not supported");
    }
  }
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(`${command} is not installed`));
        return;
      }
      reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
}

async function assertTargetDoesNotExist(absolutePath: string): Promise<void> {
  try {
    await stat(absolutePath);
    throw new Error("Mutation target already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function assertTransferDestinationIsValid(
  source: Awaited<ReturnType<typeof resolveSafeExistingPath>>,
  targetPath: string
): Promise<void> {
  if (source.realPath === targetPath) {
    throw new Error("Transfer target must be different from the source");
  }

  await assertNoSymlinkPathSegments(source.rootRealPath, source.absolutePath);
  await assertNoSymlinkPathSegments(source.rootRealPath, path.dirname(targetPath));

  const sourceStat = await stat(source.realPath);
  if (sourceStat.isDirectory() && isPathInside(source.realPath, path.dirname(targetPath))) {
    throw new Error("Cannot transfer a folder into itself");
  }
}

async function assertNoSymlinkPathSegments(rootRealPath: string, absolutePath: string): Promise<void> {
  const relativePath = path.relative(rootRealPath, absolutePath);
  let currentPath = rootRealPath;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      const currentStat = await lstat(currentPath);
      if (currentStat.isSymbolicLink()) {
        throw new Error("Refusing to transfer through a symlink");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

async function rollbackMove(
  root: StorageWorkspace,
  operation: FileOperationRecord
): Promise<RolledBackMutation> {
  if (!operation.sourcePath || !operation.targetPath) {
    throw new Error(`${operation.operation} rollback requires sourcePath and targetPath`);
  }

  const current = await resolveSafeExistingPath(root.path, operation.targetPath);
  const original = await resolveSafeTargetPath(root.path, operation.sourcePath);
  await assertNoSymlinkPathSegments(original.rootRealPath, path.dirname(original.absolutePath));
  await assertTargetDoesNotExist(original.absolutePath);
  await mkdir(path.dirname(original.absolutePath), { recursive: true });
  await movePath(current.realPath, original.absolutePath);

  return {
    operation: operation.operation,
    sourcePath: current.relativePath,
    targetPath: original.relativePath,
    metadata: {
      rollbackOf: operation.id,
      absoluteSourcePath: current.realPath,
      absoluteTargetPath: original.absolutePath
    }
  };
}

async function rollbackByTrashingTarget(
  root: StorageWorkspace,
  operation: FileOperationRecord,
  trashRootPath: string
): Promise<RolledBackMutation> {
  const targetPath = operation.targetPath ?? operation.sourcePath;
  if (!targetPath) {
    throw new Error(`${operation.operation} rollback requires a target path`);
  }

  const target = await resolveSafeExistingPath(root.path, targetPath);
  const storagePoolId = operation.metadata.storagePoolId;
  if (typeof storagePoolId !== "string" || !storagePoolId) {
    throw new Error(`${operation.operation} rollback is missing storage pool metadata`);
  }
  const trash = trashPathFor(trashRootPath, storagePoolId, target.relativePath);
  await mkdir(path.dirname(trash.absoluteTrashPath), { recursive: true });
  await movePath(target.realPath, trash.absoluteTrashPath);

  return {
    operation: "trash",
    sourcePath: target.relativePath,
    targetPath: trash.relativeTrashPath,
    metadata: {
      rollbackOf: operation.id,
      trashEntryId: trash.id,
      absoluteTrashPath: trash.absoluteTrashPath
    }
  };
}

async function movePath(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
  }

  const temporaryTargetPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await cp(sourcePath, temporaryTargetPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true
    });
    await rename(temporaryTargetPath, targetPath);
    try {
      await rm(sourcePath, { recursive: true });
    } catch (sourceRemovalError) {
      try {
        await rm(targetPath, { recursive: true, force: true });
      } catch (targetCleanupError) {
        throw new AggregateError(
          [sourceRemovalError, targetCleanupError],
          "Cross-device move failed and the copied target could not be cleaned up"
        );
      }
      throw sourceRemovalError;
    }
  } catch (error) {
    await rm(temporaryTargetPath, { recursive: true, force: true });
    throw error;
  }
}
