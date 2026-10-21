import { describe, expect, it } from "vitest";
import { describeTextPreview, highlightSource, parseDelimitedTablePreview, resolveMarkdownLink } from "./preview-utils.js";

describe("preview utilities", () => {
  it("detects common code and structured text preview types from file names", () => {
    expect(describeTextPreview("App.tsx", "text/plain")).toMatchObject({
      language: "typescript",
      languageLabel: "TSX",
      structuredKind: null
    });
    expect(describeTextPreview("README.md", "text/plain")).toMatchObject({
      language: "markdown",
      languageLabel: "Markdown",
      structuredKind: "markdown"
    });
    expect(describeTextPreview("data.tsv", "text/plain")).toMatchObject({
      languageLabel: "TSV",
      structuredKind: "table",
      delimiter: "\t"
    });
  });

  it("detects special text file names without relying on extensions", () => {
    expect(describeTextPreview("Dockerfile", "text/plain")).toMatchObject({
      language: "dockerfile",
      languageLabel: "Dockerfile"
    });
    expect(describeTextPreview("Dockerfile.dev", "text/plain")).toMatchObject({
      language: "dockerfile",
      languageLabel: "Dockerfile"
    });
    expect(describeTextPreview("Makefile", "text/plain")).toMatchObject({
      language: "makefile",
      languageLabel: "Makefile"
    });
    expect(describeTextPreview(".env.local", "text/plain")).toMatchObject({
      language: "properties",
      languageLabel: "ENV"
    });
    expect(describeTextPreview("config.toml", "text/plain")).toMatchObject({
      language: "ini",
      languageLabel: "TOML"
    });
  });

  it("renders highlighted source and escapes fallback content", () => {
    expect(highlightSource("const value = 1;", "typescript").html).toContain("hljs-keyword");
    expect(highlightSource("<script>alert('x')</script>", "unknown").html).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"
    );
  });

  it("resolves Markdown file links relative to the current preview", () => {
    expect(resolveMarkdownLink("docs/guide/README.md", "./setup.md")).toEqual({
      kind: "workspace",
      path: "docs/guide/setup.md"
    });
    expect(resolveMarkdownLink("docs/guide/README.md", "../AGENTS.md#rules")).toEqual({
      kind: "workspace",
      path: "docs/AGENTS.md"
    });
    expect(resolveMarkdownLink("docs/guide/README.md", "/LICENSE")).toEqual({
      kind: "workspace",
      path: "LICENSE"
    });
    expect(resolveMarkdownLink("docs/guide/README.md", "assets/My%20File.pdf")).toEqual({
      kind: "workspace",
      path: "docs/guide/assets/My File.pdf"
    });
  });

  it("keeps web and document links out of workspace path handling", () => {
    expect(resolveMarkdownLink("README.md", "https://example.com/docs")).toEqual({ kind: "external" });
    expect(resolveMarkdownLink("README.md", "mailto:hello@example.com")).toEqual({ kind: "external" });
    expect(resolveMarkdownLink("README.md", "#install")).toEqual({ kind: "document" });
    expect(resolveMarkdownLink("README.md", "?mode=source")).toEqual({ kind: "document" });
  });

  it("rejects invalid and root-escaping Markdown links", () => {
    expect(resolveMarkdownLink("README.md", "../secret.txt")).toEqual({ kind: "invalid" });
    expect(resolveMarkdownLink("README.md", "%E0%A4%A")).toEqual({ kind: "invalid" });
    expect(resolveMarkdownLink("README.md", " ")).toEqual({ kind: "invalid" });
  });

  it("parses and truncates delimited table previews", () => {
    const source = [
      Array.from({ length: 42 }, (_, index) => `h${index + 1}`).join(","),
      Array.from({ length: 42 }, (_, index) => `a${index + 1}`).join(","),
      Array.from({ length: 42 }, (_, index) => `b${index + 1}`).join(",")
    ].join("\n");

    const preview = parseDelimitedTablePreview(source, ",", 1, 40);

    expect(preview).toMatchObject({
      totalRows: 2,
      totalColumns: 42,
      truncatedRows: true,
      truncatedColumns: true
    });
    expect(preview?.headers).toHaveLength(40);
    expect(preview?.rows).toHaveLength(1);
    expect(preview?.rows[0]?.[0]).toBe("a1");
  });

  it("returns null for empty or invalid delimited content", () => {
    expect(parseDelimitedTablePreview("", ",")).toBeNull();
    expect(parseDelimitedTablePreview('name,role\n"unterminated', ",")).toBeNull();
  });
});
