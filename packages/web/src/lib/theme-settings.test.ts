import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  normalizeThemePreference,
  readStoredThemePreference,
  resolveThemePreference,
  writeStoredThemePreference
} from "./theme-settings.js";

describe("theme settings helpers", () => {
  it("defaults unsupported and missing preferences to light", () => {
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference("sepia")).toBe("light");
    expect(normalizeThemePreference(null)).toBe("light");
  });

  it("resolves explicit preferences before the system theme", () => {
    expect(resolveThemePreference("system", "light")).toBe("light");
    expect(resolveThemePreference("system", "dark")).toBe("dark");
    expect(resolveThemePreference("light", "dark")).toBe("light");
    expect(resolveThemePreference("dark", "light")).toBe("dark");
  });

  it("persists explicit and system preferences", () => {
    const storage = createMemoryStorage();

    writeStoredThemePreference("light", storage);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readStoredThemePreference(storage)).toBe("light");

    writeStoredThemePreference("system", storage);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(readStoredThemePreference(storage)).toBe("system");
  });

  it("falls back to system behavior when storage is unavailable", () => {
    const storage = createThrowingStorage();

    expect(readStoredThemePreference(storage)).toBe("light");
    expect(() => writeStoredThemePreference("dark", storage)).not.toThrow();
    expect(() => writeStoredThemePreference("system", storage)).not.toThrow();
  });
});

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

function createThrowingStorage() {
  return {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
    removeItem: () => {
      throw new Error("storage unavailable");
    }
  };
}
