import {
  Database,
  FileArchive,
  FileAudio,
  FileBox,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileKey2,
  FileLock2,
  FileQuestionMark,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType2,
  FileVideo,
  Folder,
  type LucideIcon
} from "lucide-react";
import type { FileVisualKind } from "../../file-type-utils.js";

export function FileTypeIcon({ kind }: { kind: FileVisualKind }) {
  const Icon = fileTypeIcon(kind);
  return <Icon className={`file-type-icon file-type-${kind}`} aria-hidden="true" size={18} />;
}

function fileTypeIcon(kind: FileVisualKind): LucideIcon {
  switch (kind) {
    case "archive":
      return FileArchive;
    case "audio":
      return FileAudio;
    case "blocked":
      return FileLock2;
    case "code":
      return FileCode2;
    case "config":
      return FileCog;
    case "database":
      return Database;
    case "directory":
      return Folder;
    case "document":
      return FileText;
    case "font":
      return FileType2;
    case "image":
      return FileImage;
    case "json":
      return FileJson2;
    case "markdown":
      return FileText;
    case "package":
      return FileBox;
    case "pdf":
      return FileText;
    case "secure":
      return FileKey2;
    case "shell":
      return FileTerminal;
    case "spreadsheet":
      return FileSpreadsheet;
    case "symlink":
      return FileSymlink;
    case "text":
      return FileText;
    case "video":
      return FileVideo;
    case "other":
      return FileQuestionMark;
  }
}
