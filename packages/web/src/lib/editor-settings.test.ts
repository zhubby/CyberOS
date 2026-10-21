import { describe, expect, it } from "vitest";
import {
  CODE_FONT_SETTINGS_STORAGE_KEY,
  DEFAULT_CODE_FONT_FAMILY_ID,
  DEFAULT_CODE_FONT_SIZE_PX,
  MAX_CODE_FONT_SIZE_PX,
  MIN_CODE_FONT_SIZE_PX,
  clampCodeFontSizePx,
  codeFontFamilyValue,
  normalizeCodeFontSettings,
  readStoredCodeFontSettings,
  writeStoredCodeFontSettings
} from "./editor-settings.js";

describe("editor settings helpers", () => {
  it("clamps code font sizes to a compact editor range", () => {
    expect(clampCodeFontSizePx(0)).toBe(MIN_CODE_FONT_SIZE_PX);
    expect(clampCodeFontSizePx(Number.NaN)).toBe(DEFAULT_CODE_FONT_SIZE_PX);
    expect(clampCodeFontSizePx(MAX_CODE_FONT_SIZE_PX * 2)).toBe(MAX_CODE_FONT_SIZE_PX);
    expect(clampCodeFontSizePx(12.24)).toBe(12);
    expect(clampCodeFontSizePx(12.26)).toBe(12.5);
  });

  it("normalizes unsupported font settings", () => {
    expect(normalizeCodeFontSettings({ familyId: "missing", fontSizePx: 99 })).toEqual({
      familyId: DEFAULT_CODE_FONT_FAMILY_ID,
      fontSizePx: MAX_CODE_FONT_SIZE_PX
    });
  });

  it("resolves font family values with a safe fallback", () => {
    expect(codeFontFamilyValue("missing")).toContain("ui-monospace");
  });

  it("reads and writes persisted code font settings", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      }
    };

    expect(readStoredCodeFontSettings(storage)).toEqual({
      familyId: DEFAULT_CODE_FONT_FAMILY_ID,
      fontSizePx: DEFAULT_CODE_FONT_SIZE_PX
    });

    writeStoredCodeFontSettings({ familyId: "menlo", fontSizePx: 13.5 }, storage);
    expect(values.get(CODE_FONT_SETTINGS_STORAGE_KEY)).toBe(JSON.stringify({ familyId: "menlo", fontSizePx: 13.5 }));
    expect(readStoredCodeFontSettings(storage)).toEqual({ familyId: "menlo", fontSizePx: 13.5 });

    values.set(CODE_FONT_SETTINGS_STORAGE_KEY, "bad");
    expect(readStoredCodeFontSettings(storage)).toEqual({
      familyId: DEFAULT_CODE_FONT_FAMILY_ID,
      fontSizePx: DEFAULT_CODE_FONT_SIZE_PX
    });
  });

  it("keeps session-only behavior when storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      }
    };

    expect(readStoredCodeFontSettings(storage)).toEqual({
      familyId: DEFAULT_CODE_FONT_FAMILY_ID,
      fontSizePx: DEFAULT_CODE_FONT_SIZE_PX
    });
    expect(() => writeStoredCodeFontSettings({ familyId: "menlo", fontSizePx: 12 }, storage)).not.toThrow();
  });
});
