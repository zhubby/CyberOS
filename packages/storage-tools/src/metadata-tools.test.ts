import { describe, expect, it } from "vitest";
import { inferMimeType, inferPreviewKind } from "./metadata-tools.js";

describe("metadata tools", () => {
  it("treats common source and structured text files as text previewable", () => {
    for (const filePath of [
      "README.markdown",
      "notes.mdx",
      "settings.jsonc",
      "data.tsv",
      "config.toml",
      "page.xml",
      "service.conf",
      "app.properties"
    ]) {
      expect(inferMimeType(filePath)).toBe("text/plain");
      expect(inferPreviewKind(inferMimeType(filePath))).toBe("text");
    }
  });

  it("treats special extensionless config files as text previewable", () => {
    for (const filePath of ["Dockerfile", "Dockerfile.dev", "Makefile", "Makefile.local", ".env.local", ".gitignore"]) {
      expect(inferMimeType(filePath)).toBe("text/plain");
      expect(inferPreviewKind(inferMimeType(filePath))).toBe("text");
    }
  });

  it("keeps existing non-text preview kinds unchanged", () => {
    expect(inferPreviewKind(inferMimeType("photo.png"))).toBe("image");
    expect(inferPreviewKind(inferMimeType("movie.mp4"))).toBe("video");
    expect(inferPreviewKind(inferMimeType("document.pdf"))).toBe("pdf");
    expect(inferPreviewKind(inferMimeType("archive.zip"))).toBe("unsupported");
  });

  it("recognizes video containers that require transcoding", () => {
    for (const filePath of ["movie.avi", "movie.m4v", "movie.mkv", "movie.mpeg", "movie.mpg"]) {
      expect(inferPreviewKind(inferMimeType(filePath))).toBe("video");
    }
  });

  it("recognizes modern Office documents as dedicated preview kinds", () => {
    expect(inferMimeType("report.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(inferMimeType("budget.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    expect(inferMimeType("roadmap.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    expect(inferPreviewKind(inferMimeType("report.docx"))).toBe("document");
    expect(inferPreviewKind(inferMimeType("budget.xlsx"))).toBe("spreadsheet");
    expect(inferPreviewKind(inferMimeType("roadmap.pptx"))).toBe("presentation");
  });

  it("allows generic octet-stream files to use text preview", () => {
    expect(inferMimeType("unknown.bin")).toBe("application/octet-stream");
    expect(inferPreviewKind(inferMimeType("unknown.bin"))).toBe("text");
  });
});
