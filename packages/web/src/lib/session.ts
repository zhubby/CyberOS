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
  storagePoolId: string,
  targetSession: Session | SessionSummary
): Promise<LoadedSessionEntries> {
  try {
    const listing = await getFiles(storagePoolId, targetSession.currentPath);
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
    const listing = await getFiles(storagePoolId, resetSession.currentPath);
    return {
      session: resetSession,
      entries: listing.entries,
      git: listing.git,
      didResetPath: true
    };
  }
}

export async function loadFileListingForView(
  storagePoolId: string,
  currentPath: string,
  query: string
): Promise<FileListing> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return getFiles(storagePoolId, currentPath);
  }

  const result = await searchFiles(storagePoolId, currentPath, trimmedQuery);
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

export function sessionTitle(session: SessionSummary, workspaceFallback = "Workspace agent"): string {
  const source = session.firstMessage ?? session.lastMessage ?? (session.currentPath === "." ? workspaceFallback : session.currentPath);
  return source.length > 34 ? `${source.slice(0, 31)}...` : source;
}
