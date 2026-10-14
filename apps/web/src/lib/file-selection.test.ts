import { describe, expect, it } from "vitest";
import { fileDownloadMode, isInvalidFileMoveDestination, reconcileFileSelection, updateFileSelection } from "./file-selection.js";

const paths = ["pool/a.txt", "pool/b.txt", "pool/c", "pool/d.txt"];

describe("file selection", () => {
  it("toggles individual paths without disturbing the rest of the selection", () => {
    expect([...updateFileSelection(new Set([paths[0]!]), paths, paths[2]!, paths[0]!, "toggle")])
      .toEqual([paths[0], paths[2]]);
    expect([...updateFileSelection(new Set([paths[0]!, paths[2]!]), paths, paths[0]!, paths[2]!, "toggle")])
      .toEqual([paths[2]]);
  });

  it("selects an inclusive range in visible order", () => {
    expect([...updateFileSelection(new Set([paths[0]!]), paths, paths[3]!, paths[1]!, "range")])
      .toEqual([paths[1], paths[2], paths[3]]);
  });

  it("falls back to the target when the range anchor is no longer visible", () => {
    expect([...updateFileSelection(new Set([paths[0]!]), paths, paths[2]!, "pool/missing", "range")])
      .toEqual([paths[2]]);
  });

  it("preserves only paths that still exist after a refresh", () => {
    expect([...reconcileFileSelection(new Set(paths), new Set([paths[0]!, paths[3]!]))])
      .toEqual([paths[0], paths[3]]);
  });

  it("rejects moving entries onto themselves or directories into their descendants", () => {
    const entries = [
      { path: "pool/report.txt", name: "report.txt", kind: "file" as const },
      { path: "pool/projects", name: "projects", kind: "directory" as const }
    ];

    expect(isInvalidFileMoveDestination(entries, "pool")).toBe(true);
    expect(isInvalidFileMoveDestination(entries, "pool/projects/archive")).toBe(true);
    expect(isInvalidFileMoveDestination(entries, "pool/archive")).toBe(false);
  });

  it("downloads one file directly and archives folders or multiple items", () => {
    expect(fileDownloadMode([{ kind: "file" }])).toBe("direct");
    expect(fileDownloadMode([{ kind: "directory" }])).toBe("archive");
    expect(fileDownloadMode([{ kind: "file" }, { kind: "file" }])).toBe("archive");
  });
});
