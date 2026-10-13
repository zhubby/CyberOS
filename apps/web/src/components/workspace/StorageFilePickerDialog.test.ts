import { describe, expect, it } from "vitest";
import type { FileEntry } from "../../api.js";
import { isIsoPickerEntry, parentPickerPath, pickerBreadcrumbs } from "./StorageFilePickerDialog.js";

const entry = (name: string, kind: FileEntry["kind"], isSafe = true): FileEntry => ({
  name,
  path: `pool/${name}`,
  kind,
  isSafe,
  sizeBytes: 1,
  modifiedAt: new Date(0).toISOString()
});

describe("StorageFilePickerDialog helpers", () => {
  it("only exposes safe directories and ISO files", () => {
    expect(isIsoPickerEntry(entry("images", "directory"))).toBe(true);
    expect(isIsoPickerEntry(entry("installer.ISO", "file"))).toBe(true);
    expect(isIsoPickerEntry(entry("notes.txt", "file"))).toBe(false);
    expect(isIsoPickerEntry(entry("escape.iso", "symlink"))).toBe(false);
    expect(isIsoPickerEntry(entry("unsafe", "directory", false))).toBe(false);
  });

  it("keeps parent navigation inside the selected pool", () => {
    expect(parentPickerPath("pool", "pool/images/linux")).toBe("pool/images");
    expect(parentPickerPath("pool", "pool")).toBe("pool");
    expect(pickerBreadcrumbs("pool", "pool/images/linux")).toEqual([
      { name: "images", path: "pool/images" },
      { name: "linux", path: "pool/images/linux" }
    ]);
  });
});
