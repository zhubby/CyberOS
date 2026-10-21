import { describe, expect, it } from "vitest";
import { describeFileVisual, FILE_TYPE_LABELS, isHiddenName } from "./file-type-utils.js";

describe("file type utilities", () => {
  it("classifies entry safety and non-file kinds first", () => {
    expect(describeFileVisual({ name: "private.txt", kind: "file", isSafe: false })).toEqual({
      kind: "blocked"
    });
    expect(describeFileVisual({ name: "src", kind: "directory", isSafe: true })).toEqual({
      kind: "directory"
    });
    expect(describeFileVisual({ name: "latest", kind: "symlink", isSafe: true })).toEqual({
      kind: "symlink"
    });
  });

  it("classifies common source and structured text files", () => {
    expect(describeFileVisual({ name: "App.tsx", kind: "file", isSafe: true })).toMatchObject({ kind: "code" });
    expect(describeFileVisual({ name: "README.md", kind: "file", isSafe: true })).toMatchObject({
      kind: "markdown"
    });
    expect(describeFileVisual({ name: "package.json", kind: "file", isSafe: true })).toMatchObject({
      kind: "package"
    });
    expect(describeFileVisual({ name: "data.csv", kind: "file", isSafe: true })).toMatchObject({
      kind: "spreadsheet"
    });
  });

  it("classifies media, database, archive, and secure files", () => {
    expect(describeFileVisual({ name: "photostaff.webp", kind: "file", isSafe: true })).toMatchObject({ kind: "image" });
    expect(describeFileVisual({ name: "clip.mov", kind: "file", isSafe: true })).toMatchObject({ kind: "video" });
    expect(describeFileVisual({ name: "mix.flac", kind: "file", isSafe: true })).toMatchObject({ kind: "audio" });
    expect(describeFileVisual({ name: "zos.sqlite", kind: "file", isSafe: true })).toMatchObject({ kind: "database" });
    expect(describeFileVisual({ name: "backup.tar", kind: "file", isSafe: true })).toMatchObject({ kind: "archive" });
    expect(describeFileVisual({ name: "server.key", kind: "file", isSafe: true })).toMatchObject({ kind: "secure" });
  });

  it("classifies special extensionless config files", () => {
    expect(describeFileVisual({ name: "Dockerfile.dev", kind: "file", isSafe: true })).toMatchObject({
      kind: "config"
    });
    expect(describeFileVisual({ name: "Makefile", kind: "file", isSafe: true })).toMatchObject({
      kind: "config"
    });
    expect(describeFileVisual({ name: ".env.local", kind: "file", isSafe: true })).toMatchObject({
      kind: "config"
    });
  });

  it("detects hidden dot-prefixed names", () => {
    expect(isHiddenName(".env")).toBe(true);
    expect(isHiddenName(".git")).toBe(true);
    expect(isHiddenName("README.md")).toBe(false);
    expect(isHiddenName(".")).toBe(false);
    expect(isHiddenName("..")).toBe(false);
  });

  it("uses stable English labels for every file type", () => {
    expect(FILE_TYPE_LABELS).toEqual({
      archive: "archive",
      audio: "audio",
      blocked: "blocked",
      code: "code",
      config: "config",
      database: "database",
      directory: "folder",
      document: "document",
      font: "font",
      image: "image",
      json: "JSON",
      markdown: "markdown",
      other: "file",
      package: "package",
      pdf: "PDF",
      secure: "secret",
      shell: "script",
      spreadsheet: "table",
      symlink: "link",
      text: "text",
      video: "video"
    });
  });
});
