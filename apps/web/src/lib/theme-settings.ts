export const THEME_STORAGE_KEY = "zos:theme";
export const RESOLVED_THEMES = ["light", "dark"] as const;

export type ResolvedTheme = (typeof RESOLVED_THEMES)[number];
export type ThemePreference = "system" | ResolvedTheme;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function normalizeThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemTheme = readSystemTheme()
): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}

export function readStoredThemePreference(storage = browserStorage()): ThemePreference {
  try {
    return normalizeThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeStoredThemePreference(preference: ThemePreference, storage = browserStorage()): void {
  if (!storage) {
    return;
  }

  try {
    if (preference === "system") {
      storage.removeItem(THEME_STORAGE_KEY);
      return;
    }
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme switching still works for the current session when persistence is unavailable.
  }
}

export function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function browserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.localStorage;
}
