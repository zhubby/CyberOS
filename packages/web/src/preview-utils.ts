import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import properties from "highlight.js/lib/languages/properties";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import Papa from "papaparse";

export type StructuredPreviewKind = "markdown" | "table" | null;
export type DelimitedPreviewDelimiter = "," | "\t";

export interface TextPreviewDescriptor {
  language: string | null;
  languageLabel: string;
  structuredKind: StructuredPreviewKind;
  delimiter: DelimitedPreviewDelimiter | null;
}

export interface HighlightedSource {
  html: string;
  language: string;
}

export interface DelimitedTablePreview {
  headers: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
}

export type MarkdownLinkTarget =
  | { kind: "workspace"; path: string }
  | { kind: "document" }
  | { kind: "external" }
  | { kind: "invalid" };

const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 40;

const EXTENSION_DESCRIPTORS = new Map<string, TextPreviewDescriptor>([
  [".bash", codeDescriptor("bash", "Shell")],
  [".c", codeDescriptor("c", "C")],
  [".cc", codeDescriptor("cpp", "C++")],
  [".cfg", codeDescriptor("ini", "Config")],
  [".conf", codeDescriptor("ini", "Config")],
  [".cpp", codeDescriptor("cpp", "C++")],
  [".cjs", codeDescriptor("javascript", "JavaScript")],
  [".css", codeDescriptor("css", "CSS")],
  [".csv", tableDescriptor(",", "CSV")],
  [".env", codeDescriptor("properties", "ENV")],
  [".go", codeDescriptor("go", "Go")],
  [".h", codeDescriptor("c", "C")],
  [".hpp", codeDescriptor("cpp", "C++")],
  [".htm", codeDescriptor("xml", "HTML")],
  [".html", codeDescriptor("xml", "HTML")],
  [".ini", codeDescriptor("ini", "INI")],
  [".java", codeDescriptor("java", "Java")],
  [".js", codeDescriptor("javascript", "JavaScript")],
  [".json", codeDescriptor("json", "JSON")],
  [".jsonc", codeDescriptor("json", "JSONC")],
  [".jsx", codeDescriptor("javascript", "JSX")],
  [".log", codeDescriptor("plaintext", "Log")],
  [".markdown", markdownDescriptor()],
  [".md", markdownDescriptor()],
  [".mdx", markdownDescriptor("MDX")],
  [".mjs", codeDescriptor("javascript", "JavaScript")],
  [".properties", codeDescriptor("properties", "Properties")],
  [".py", codeDescriptor("python", "Python")],
  [".rb", codeDescriptor("ruby", "Ruby")],
  [".rs", codeDescriptor("rust", "Rust")],
  [".sh", codeDescriptor("bash", "Shell")],
  [".sql", codeDescriptor("sql", "SQL")],
  [".toml", codeDescriptor("ini", "TOML")],
  [".ts", codeDescriptor("typescript", "TypeScript")],
  [".tsx", codeDescriptor("typescript", "TSX")],
  [".tsv", tableDescriptor("\t", "TSV")],
  [".txt", codeDescriptor("plaintext", "Text")],
  [".xml", codeDescriptor("xml", "XML")],
  [".yaml", codeDescriptor("yaml", "YAML")],
  [".yml", codeDescriptor("yaml", "YAML")],
  [".zsh", codeDescriptor("bash", "Shell")]
]);

const SPECIAL_FILE_DESCRIPTORS = new Map<string, TextPreviewDescriptor>([
  [".bash_profile", codeDescriptor("bash", "Shell")],
  [".bashrc", codeDescriptor("bash", "Shell")],
  [".dockerignore", codeDescriptor("plaintext", "Text")],
  [".env", codeDescriptor("properties", "ENV")],
  [".gitignore", codeDescriptor("plaintext", "Text")],
  [".npmrc", codeDescriptor("ini", "Config")],
  [".profile", codeDescriptor("bash", "Shell")],
  [".zprofile", codeDescriptor("bash", "Shell")],
  [".zshrc", codeDescriptor("bash", "Shell")],
  ["bsdmakefile", codeDescriptor("makefile", "Makefile")],
  ["dockerfile", codeDescriptor("dockerfile", "Dockerfile")],
  ["gnumakefile", codeDescriptor("makefile", "Makefile")],
  ["makefile", codeDescriptor("makefile", "Makefile")]
]);

registerHighlightLanguages();

export function describeTextPreview(fileName: string, mimeType: string): TextPreviewDescriptor {
  const baseName = getBaseName(fileName);
  const lowerName = baseName.toLocaleLowerCase();

  if (lowerName.startsWith("dockerfile.")) {
    return codeDescriptor("dockerfile", "Dockerfile");
  }
  if (lowerName.startsWith("makefile.")) {
    return codeDescriptor("makefile", "Makefile");
  }
  if (lowerName.startsWith(".env.")) {
    return codeDescriptor("properties", "ENV");
  }

  const special = SPECIAL_FILE_DESCRIPTORS.get(lowerName);
  if (special) {
    return special;
  }

  const extension = getExtension(lowerName);
  const descriptor = EXTENSION_DESCRIPTORS.get(extension);
  if (descriptor) {
    return descriptor;
  }

  if (mimeType === "text/csv") {
    return tableDescriptor(",", "CSV");
  }
  if (mimeType.startsWith("text/")) {
    return codeDescriptor("plaintext", "Text");
  }

  return codeDescriptor(null, "Text");
}

export function highlightSource(source: string, language: string | null): HighlightedSource {
  const normalizedLanguage = language && hljs.getLanguage(language) ? language : "plaintext";
  if (normalizedLanguage === "plaintext") {
    return {
      html: escapeHtml(source),
      language: normalizedLanguage
    };
  }

  try {
    return {
      html: hljs.highlight(source, {
        language: normalizedLanguage,
        ignoreIllegals: true
      }).value,
      language: normalizedLanguage
    };
  } catch {
    return {
      html: escapeHtml(source),
      language: "plaintext"
    };
  }
}

export function resolveMarkdownLink(currentFilePath: string, href: string | undefined): MarkdownLinkTarget {
  const rawHref = href?.trim() ?? "";
  if (!rawHref) {
    return { kind: "invalid" };
  }
  if (rawHref.startsWith("#") || rawHref.startsWith("?")) {
    return { kind: "document" };
  }
  if (rawHref.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(rawHref)) {
    return { kind: "external" };
  }

  const encodedPath = rawHref.split(/[?#]/u, 1)[0] ?? "";
  let linkPath: string;
  try {
    linkPath = decodeURIComponent(encodedPath).replace(/\\/g, "/");
  } catch {
    return { kind: "invalid" };
  }

  const segments = linkPath.startsWith("/")
    ? []
    : currentFilePath
        .replace(/\\/g, "/")
        .split("/")
        .filter(Boolean)
        .slice(0, -1);

  for (const segment of linkPath.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (!segments.length) {
        return { kind: "invalid" };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return {
    kind: "workspace",
    path: segments.join("/") || "."
  };
}

export function parseDelimitedTablePreview(
  source: string,
  delimiter: DelimitedPreviewDelimiter,
  maxRows = MAX_TABLE_ROWS,
  maxColumns = MAX_TABLE_COLUMNS,
  fallbackHeaderLabel: (index: number) => string = defaultFallbackHeaderLabel
): DelimitedTablePreview | null {
  const parsed = Papa.parse<string[]>(source, {
    delimiter,
    skipEmptyLines: "greedy"
  });

  if (parsed.errors.length > 0) {
    return null;
  }

  const parsedRows = parsed.data.filter((row): row is string[] => Array.isArray(row) && row.some((cell) => cell.length > 0));
  const headerRow = parsedRows[0];
  if (!headerRow) {
    return null;
  }

  const totalColumns = Math.max(...parsedRows.map((row) => row.length));
  if (totalColumns === 0) {
    return null;
  }

  const displayColumnCount = Math.min(totalColumns, maxColumns);
  const dataRows = parsedRows.slice(1);

  return {
    headers: normalizeDelimitedRow(headerRow, displayColumnCount).map((cell, index) => cell.trim() || fallbackHeaderLabel(index + 1)),
    rows: dataRows.slice(0, maxRows).map((row) => normalizeDelimitedRow(row, displayColumnCount)),
    totalRows: dataRows.length,
    totalColumns,
    truncatedRows: dataRows.length > maxRows,
    truncatedColumns: totalColumns > maxColumns
  };
}

function registerHighlightLanguages() {
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("c", c);
  hljs.registerLanguage("cpp", cpp);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("dockerfile", dockerfile);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("ini", ini);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("makefile", makefile);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("plaintext", plaintext);
  hljs.registerLanguage("properties", properties);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("ruby", ruby);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerAliases(["html"], { languageName: "xml" });
}

function normalizeDelimitedRow(row: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
}

function codeDescriptor(language: string | null, languageLabel: string): TextPreviewDescriptor {
  return {
    language,
    languageLabel,
    structuredKind: null,
    delimiter: null
  };
}

function markdownDescriptor(languageLabel = "Markdown"): TextPreviewDescriptor {
  return {
    language: "markdown",
    languageLabel,
    structuredKind: "markdown",
    delimiter: null
  };
}

function tableDescriptor(delimiter: DelimitedPreviewDelimiter, languageLabel: string): TextPreviewDescriptor {
  return {
    language: "plaintext",
    languageLabel,
    structuredKind: "table",
    delimiter
  };
}

function defaultFallbackHeaderLabel(index: number): string {
  return `Column ${index}`;
}

function getBaseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex) : "";
}

function escapeHtml(source: string): string {
  return source.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
