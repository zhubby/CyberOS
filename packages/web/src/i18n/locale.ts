export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export const LANGUAGE_STORAGE_KEY = "zos:language";

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LanguagePreference = "system" | SupportedLocale;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function resolveSupportedLocale(candidates: string | readonly string[] | null | undefined): SupportedLocale {
  const candidateList = Array.isArray(candidates) ? candidates : candidates ? [candidates] : [];
  for (const candidate of candidateList) {
    const locale = normalizeLocale(candidate);
    if (locale) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

export function normalizeLanguagePreference(value: string | null | undefined): LanguagePreference {
  if (value === "system" || value === "en" || value === "zh-CN") {
    return value;
  }
  return "system";
}

export function readStoredLanguagePreference(storage = browserStorage()): LanguagePreference {
  try {
    return normalizeLanguagePreference(storage?.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeStoredLanguagePreference(preference: LanguagePreference, storage = browserStorage()): void {
  if (!storage) {
    return;
  }
  try {
    if (preference === "system") {
      storage.removeItem(LANGUAGE_STORAGE_KEY);
      return;
    }
    storage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // Language switching still works for the current session when persistence is unavailable.
  }
}

export function resolveInitialLocale(
  storage = browserStorage(),
  browserLanguages = browserLanguageCandidates()
): SupportedLocale {
  const preference = readStoredLanguagePreference(storage);
  return preference === "system" ? resolveSupportedLocale(browserLanguages) : preference;
}

export function resolveBrowserLocale(): SupportedLocale {
  return resolveSupportedLocale(browserLanguageCandidates());
}

export function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
  return value === "en" || value === "zh-CN";
}

function normalizeLocale(candidate: string): SupportedLocale | null {
  const value = candidate.trim().replace(/_/g, "-").toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "en" || value.startsWith("en-")) {
    return "en";
  }
  if (value === "zh" || value === "zh-cn" || value === "zh-sg" || value === "zh-hans" || value.startsWith("zh-hans-")) {
    return "zh-CN";
  }
  return null;
}

function browserLanguageCandidates(): string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  return navigator.languages?.length ? [...navigator.languages] : [navigator.language].filter(Boolean);
}

function browserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.localStorage;
}
