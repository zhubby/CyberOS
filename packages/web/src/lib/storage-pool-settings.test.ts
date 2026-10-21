import { describe, expect, it } from "vitest";
import {
  readStoredStoragePoolId,
  STORAGE_POOL_STORAGE_KEY,
  writeStoredStoragePoolId
} from "./storage-pool-settings.js";

describe("storage pool settings helpers", () => {
  it("persists and restores the last storage pool", () => {
    const storage = createMemoryStorage();

    writeStoredStoragePoolId("pool-2", storage);

    expect(storage.getItem(STORAGE_POOL_STORAGE_KEY)).toBe("pool-2");
    expect(readStoredStoragePoolId(storage)).toBe("pool-2");
  });

  it("ignores empty values and unavailable storage", () => {
    const storage = createMemoryStorage();
    writeStoredStoragePoolId("", storage);
    expect(storage.getItem(STORAGE_POOL_STORAGE_KEY)).toBeNull();

    const unavailableStorage = {
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: () => { throw new Error("storage unavailable"); }
    };
    expect(readStoredStoragePoolId(unavailableStorage)).toBe("");
    expect(() => writeStoredStoragePoolId("pool-1", unavailableStorage)).not.toThrow();
  });
});

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}
