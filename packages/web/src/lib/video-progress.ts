export const VIDEO_PROGRESS_STORAGE_PREFIX = "cyberos:video-progress:";

export interface VideoProgressIdentity {
  storagePoolId: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface StoredVideoProgress {
  positionSeconds: number;
  sizeBytes: number;
  modifiedAt: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function videoProgressStorageKey(identity: Pick<VideoProgressIdentity, "storagePoolId" | "path">): string {
  return `${VIDEO_PROGRESS_STORAGE_PREFIX}${encodeURIComponent(identity.storagePoolId)}:${encodeURIComponent(identity.path)}`;
}

export function readVideoProgress(
  identity: VideoProgressIdentity,
  storage: StorageLike | null = browserStorage()
): StoredVideoProgress | null {
  try {
    const raw = storage?.getItem(videoProgressStorageKey(identity));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StoredVideoProgress>;
    if (
      typeof parsed.positionSeconds !== "number" ||
      typeof parsed.sizeBytes !== "number" ||
      typeof parsed.modifiedAt !== "string" ||
      !Number.isFinite(parsed.positionSeconds) ||
      parsed.positionSeconds < 0 ||
      !Number.isFinite(parsed.sizeBytes) ||
      parsed.sizeBytes < 0 ||
      parsed.sizeBytes !== identity.sizeBytes ||
      parsed.modifiedAt !== identity.modifiedAt
    ) {
      return null;
    }
    return {
      positionSeconds: parsed.positionSeconds,
      sizeBytes: parsed.sizeBytes,
      modifiedAt: parsed.modifiedAt
    };
  } catch {
    return null;
  }
}

export function writeVideoProgress(
  identity: VideoProgressIdentity,
  positionSeconds: number,
  storage: StorageLike | null = browserStorage()
): void {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
    return;
  }

  try {
    storage?.setItem(
      videoProgressStorageKey(identity),
      JSON.stringify({
        positionSeconds,
        sizeBytes: identity.sizeBytes,
        modifiedAt: identity.modifiedAt
      } satisfies StoredVideoProgress)
    );
  } catch {
    // Playback remains available when browser storage is unavailable.
  }
}

export function clearVideoProgress(
  identity: Pick<VideoProgressIdentity, "storagePoolId" | "path">,
  storage: StorageLike | null = browserStorage()
): void {
  try {
    storage?.removeItem(videoProgressStorageKey(identity));
  } catch {
    // Playback remains available when browser storage is unavailable.
  }
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
