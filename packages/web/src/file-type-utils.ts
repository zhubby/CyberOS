export type FileVisualKind =
  | "archive"
  | "audio"
  | "blocked"
  | "code"
  | "config"
  | "database"
  | "directory"
  | "document"
  | "font"
  | "image"
  | "json"
  | "markdown"
  | "other"
  | "package"
  | "pdf"
  | "secure"
  | "shell"
  | "spreadsheet"
  | "symlink"
  | "text"
  | "video";

export interface FileVisualInput {
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
  isSafe: boolean;
}

export interface FileVisualDescriptor {
  kind: FileVisualKind;
}

export const FILE_TYPE_LABELS = {
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
} as const satisfies Record<FileVisualKind, string>;

export function isHiddenName(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".heic", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);
const ARCHIVE_EXTENSIONS = new Set([".7z", ".bz2", ".dmg", ".gz", ".iso", ".rar", ".tar", ".tgz", ".xz", ".zip"]);
const SPREADSHEET_EXTENSIONS = new Set([".csv", ".numbers", ".ods", ".tsv", ".xls", ".xlsx"]);
const DOCUMENT_EXTENSIONS = new Set([".doc", ".docx", ".odt", ".pages", ".rtf"]);
const MARKDOWN_EXTENSIONS = new Set([".markdown", ".md", ".mdx"]);
const JSON_EXTENSIONS = new Set([".json", ".jsonc"]);
const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3", ".sql"]);
const FONT_EXTENSIONS = new Set([".eot", ".otf", ".ttf", ".woff", ".woff2"]);
const SECURE_EXTENSIONS = new Set([".cer", ".crt", ".key", ".p12", ".pem", ".pfx"]);
const SHELL_EXTENSIONS = new Set([".bash", ".bat", ".cmd", ".fish", ".ps1", ".sh", ".zsh"]);
const CONFIG_EXTENSIONS = new Set([
  ".cfg",
  ".conf",
  ".editorconfig",
  ".env",
  ".ini",
  ".lock",
  ".npmrc",
  ".properties",
  ".toml",
  ".yaml",
  ".yml"
]);
const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".ex",
  ".exs",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".less",
  ".lua",
  ".mjs",
  ".php",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scala",
  ".scss",
  ".swift",
  ".ts",
  ".tsx",
  ".xml"
]);

const PACKAGE_FILE_NAMES = new Set([
  "bun.lockb",
  "cargo.lock",
  "cargo.toml",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]);

const CONFIG_FILE_NAMES = new Set([
  ".dockerignore",
  ".env",
  ".eslintignore",
  ".eslintrc",
  ".gitignore",
  ".npmrc",
  ".prettierignore",
  ".prettierrc",
  "dockerfile",
  "makefile"
]);

export function describeFileVisual(input: FileVisualInput): FileVisualDescriptor {
  if (!input.isSafe) {
    return { kind: "blocked" };
  }
  if (input.kind === "directory") {
    return { kind: "directory" };
  }
  if (input.kind === "symlink") {
    return { kind: "symlink" };
  }
  if (input.kind !== "file") {
    return { kind: "other" };
  }

  const lowerName = input.name.toLocaleLowerCase();
  if (PACKAGE_FILE_NAMES.has(lowerName)) {
    return { kind: "package" };
  }
  if (CONFIG_FILE_NAMES.has(lowerName) || lowerName.startsWith(".env.") || lowerName.startsWith("dockerfile.") || lowerName.startsWith("makefile.")) {
    return { kind: "config" };
  }

  const extension = getExtension(lowerName);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return { kind: "image" };
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return { kind: "audio" };
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { kind: "video" };
  }
  if (extension === ".pdf") {
    return { kind: "pdf" };
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return { kind: "archive" };
  }
  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return { kind: "spreadsheet" };
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return { kind: "document" };
  }
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return { kind: "markdown" };
  }
  if (JSON_EXTENSIONS.has(extension)) {
    return { kind: "json" };
  }
  if (DATABASE_EXTENSIONS.has(extension)) {
    return { kind: "database" };
  }
  if (FONT_EXTENSIONS.has(extension)) {
    return { kind: "font" };
  }
  if (SECURE_EXTENSIONS.has(extension)) {
    return { kind: "secure" };
  }
  if (SHELL_EXTENSIONS.has(extension)) {
    return { kind: "shell" };
  }
  if (CONFIG_EXTENSIONS.has(extension)) {
    return { kind: "config" };
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return { kind: "code" };
  }
  if (extension === ".log") {
    return { kind: "text" };
  }
  if (extension === ".txt" || extension === ".text") {
    return { kind: "text" };
  }

  return { kind: "other" };
}

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex) : "";
}
