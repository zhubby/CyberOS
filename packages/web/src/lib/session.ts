import {
  getFiles,
  searchFiles,
  updateSessionPath,
  type FileEntry,
  type FileListing,
  type Session,
  type SessionSummary
} from "../api.js";

export interface LoadedSessionEntries {
  session: Session | SessionSummary;
  entries: FileEntry[];
  git: FileListing["git"];
  didResetPath: boolean;
}

export async function loadEntriesForSession(
  rootId: string,
  targetSession: Session | SessionSummary,
  storagePoolId?: string
): Promise<LoadedSessionEntries> {
  if (!storagePoolId) {
    return {
      session: targetSession,
      entries: [],
      git: null,
      didResetPath: false
    };
  }

  try {
    const listing = await getFiles(rootId, targetSession.currentPath, storagePoolId);
    return {
      session: targetSession,
      entries: listing.entries,
      git: listing.git,
      didResetPath: false
    };
  } catch (error) {
    if (targetSession.currentPath === "." || !isRecoverablePathError(error)) {
      throw error;
    }

    const resetSession = await updateSessionPath(targetSession.id, ".");
    const listing = await getFiles(rootId, resetSession.currentPath, storagePoolId);
    return {
      session: resetSession,
      entries: listing.entries,
      git: listing.git,
      didResetPath: true
    };
  }
}

export async function loadFileListingForView(
  rootId: string,
  currentPath: string,
  query: string,
  storagePoolId: string
): Promise<FileListing> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return getFiles(rootId, currentPath, storagePoolId);
  }

  const result = await searchFiles(rootId, currentPath, trimmedQuery, storagePoolId);
  return {
    entries: result.files,
    git: result.git
  };
}

export async function syncSessionPath(
  targetSession: Session | SessionSummary,
  currentPath: string
): Promise<Session | SessionSummary> {
  if (targetSession.currentPath === currentPath) {
    return targetSession;
  }

  return updateSessionPath(targetSession.id, currentPath);
}

export function isRecoverablePathError(error: unknown): boolean {
  return error instanceof Error && (error.message === "Path not found" || error.message === "Path is not accessible");
}

export function sessionTitle(session: SessionSummary, rootFallback = "Root agent"): string {
  const source = session.firstMessage ?? session.lastMessage ?? (session.currentPath === "." ? rootFallback : session.currentPath);
  return source.length > 34 ? `${source.slice(0, 31)}...` : source;
}
