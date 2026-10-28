export const CODE_FONT_SETTINGS_STORAGE_KEY = "cyberos:code-font-settings";
export const DEFAULT_CODE_FONT_FAMILY_ID = "system";
export const DEFAULT_CODE_FONT_SIZE_PX = 12;
export const MIN_CODE_FONT_SIZE_PX = 10;
export const MAX_CODE_FONT_SIZE_PX = 16;

export interface CodeFontSettings {
  familyId: string;
  fontSizePx: number;
}

export interface CodeFontOption {
  id: string;
  label: string;
  family: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CODE_FONT_OPTIONS: CodeFontOption[] = [
  {
    id: "system",
    label: "System Mono",
    family: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", monospace"
  },
  {
    id: "sf-mono",
    label: "SF Mono",
    family: "\"SFMono-Regular\", \"SF Mono\", Menlo, Monaco, Consolas, monospace"
  },
  {
    id: "menlo",
    label: "Menlo",
    family: "Menlo, Monaco, Consolas, \"Liberation Mono\", monospace"
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    family: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, monospace"
  },
  {
    id: "fira-code",
    label: "Fira Code",
    family: "\"Fira Code\", ui-monospace, SFMono-Regular, Menlo, monospace"
  },
  {
    id: "cascadia-code",
    label: "Cascadia Code",
    family: "\"Cascadia Code\", ui-monospace, SFMono-Regular, Menlo, monospace"
  }
];

function browserStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function defaultCodeFontSettings(): CodeFontSettings {
  return {
    familyId: DEFAULT_CODE_FONT_FAMILY_ID,
    fontSizePx: DEFAULT_CODE_FONT_SIZE_PX
  };
}

export function clampCodeFontSizePx(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CODE_FONT_SIZE_PX;
  }

  const rounded = Math.round(value * 2) / 2;
  return Math.min(Math.max(rounded, MIN_CODE_FONT_SIZE_PX), MAX_CODE_FONT_SIZE_PX);
}

export function normalizeCodeFontSettings(input: Partial<CodeFontSettings> | null | undefined): CodeFontSettings {
  const requestedFamilyId = input?.familyId;
  const familyId =
    requestedFamilyId && CODE_FONT_OPTIONS.some((option) => option.id === requestedFamilyId)
      ? requestedFamilyId
      : DEFAULT_CODE_FONT_FAMILY_ID;

  return {
    familyId,
    fontSizePx: clampCodeFontSizePx(Number(input?.fontSizePx ?? DEFAULT_CODE_FONT_SIZE_PX))
  };
}

export function codeFontFamilyValue(familyId: string): string {
  return CODE_FONT_OPTIONS.find((option) => option.id === familyId)?.family ?? CODE_FONT_OPTIONS[0]!.family;
}

export function readStoredCodeFontSettings(storage: StorageLike | null = browserStorage()): CodeFontSettings {
  try {
    const raw = storage?.getItem(CODE_FONT_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return defaultCodeFontSettings();
    }
    return normalizeCodeFontSettings(JSON.parse(raw) as Partial<CodeFontSettings>);
  } catch {
    return defaultCodeFontSettings();
  }
}

export function writeStoredCodeFontSettings(
  value: CodeFontSettings,
  storage: StorageLike | null = browserStorage()
): void {
  try {
    storage?.setItem(CODE_FONT_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeCodeFontSettings(value)));
  } catch {
    // The current session can still apply the updated font settings when storage is unavailable.
  }
}
