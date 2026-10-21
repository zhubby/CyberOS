import { describe, expect, it } from "vitest";
import { DEFAULT_SPLIT_WIDTH, SPLIT_WIDTH_STORAGE_KEY, clampSplitWidth, readStoredSplitWidth, writeStoredSplitWidth } from "./layout.js";

describe("layout helpers", () => {
  it("clamps split width to the chat minimum and remaining workspace width", () => {
    expect(clampSplitWidth(500, 1440)).toBe(560);
    expect(clampSplitWidth(900, 1200)).toBe(740);
    expect(clampSplitWidth(650, 1600)).toBe(650);
    expect(clampSplitWidth(900, 900)).toBe(560);
  });

  it("reads and writes persisted split width through the existing storage key", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      }
    };

    expect(readStoredSplitWidth(storage, 1600)).toBe(DEFAULT_SPLIT_WIDTH);
    writeStoredSplitWidth(720, storage);
    expect(values.get(SPLIT_WIDTH_STORAGE_KEY)).toBe("720");
    expect(readStoredSplitWidth(storage, 1600)).toBe(720);
    values.set(SPLIT_WIDTH_STORAGE_KEY, "bad");
    expect(readStoredSplitWidth(storage, 1600)).toBe(DEFAULT_SPLIT_WIDTH);
  });
});
