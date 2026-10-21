import { describe, expect, it } from "vitest";
import {
  LANGUAGE_STORAGE_KEY,
  readStoredLanguagePreference,
  resolveInitialLocale,
  resolveSupportedLocale,
  writeStoredLanguagePreference
} from "./locale.js";

describe("locale resolution", () => {
  it("maps supported English and simplified Chinese browser locales", () => {
    expect(resolveSupportedLocale(["fr-FR", "en-US"])).toBe("en");
    expect(resolveSupportedLocale("zh-CN")).toBe("zh-CN");
    expect(resolveSupportedLocale("zh-Hans")).toBe("zh-CN");
    expect(resolveSupportedLocale("zh-SG")).toBe("zh-CN");
    expect(resolveSupportedLocale("zh")).toBe("zh-CN");
  });

  it("falls back to English for unsupported and traditional Chinese locales", () => {
    expect(resolveSupportedLocale("zh-TW")).toBe("en");
    expect(resolveSupportedLocale("zh-Hant")).toBe("en");
    expect(resolveSupportedLocale(["fr-FR", "de-DE"])).toBe("en");
    expect(resolveSupportedLocale(null)).toBe("en");
  });

  it("uses stored language preference before browser languages", () => {
    const storage = createMemoryStorage({ [LANGUAGE_STORAGE_KEY]: "zh-CN" });

    expect(resolveInitialLocale(storage, ["en-US"])).toBe("zh-CN");
  });

  it("ignores invalid stored preferences and follows browser languages", () => {
    const storage = createMemoryStorage({ [LANGUAGE_STORAGE_KEY]: "es" });

    expect(readStoredLanguagePreference(storage)).toBe("system");
    expect(resolveInitialLocale(storage, ["zh-Hans"])).toBe("zh-CN");
  });

  it("removes the override for system default and persists explicit preferences", () => {
    const storage = createMemoryStorage();

    writeStoredLanguagePreference("zh-CN", storage);
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");

    writeStoredLanguagePreference("system", storage);
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it("falls back to session-only behavior when storage is unavailable", () => {
    const storage = createThrowingStorage();

    expect(readStoredLanguagePreference(storage)).toBe("system");
    expect(() => writeStoredLanguagePreference("zh-CN", storage)).not.toThrow();
    expect(() => writeStoredLanguagePreference("system", storage)).not.toThrow();
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
