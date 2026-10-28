export const STORAGE_POOL_STORAGE_KEY = "cyberos:last-storage-pool";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readStoredStoragePoolId(storage = browserStorage()): string {
  try {
    return storage?.getItem(STORAGE_POOL_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeStoredStoragePoolId(poolId: string, storage = browserStorage()): void {
  if (!storage || !poolId) {
    return;
  }

  try {
    storage.setItem(STORAGE_POOL_STORAGE_KEY, poolId);
  } catch {
    // Pool switching still works for the current session when persistence is unavailable.
  }
}

function browserStorage(): StorageLike | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
