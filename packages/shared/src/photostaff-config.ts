export const PHOTOSTAFF_DATA_DIRECTORY_NAME = "photostaff";
export const PHOTOSTAFF_BASE_MAP_DIRECTORY_NAME = "maps";
export const PHOTOSTAFF_BASE_MAP_NAME = "Natural Earth II";
export const PHOTOSTAFF_BASE_MAP_VERSION = "3.2.0";
export const PHOTOSTAFF_BASE_MAP_FILE_NAME = "natural-earth-ii-3.2.0.pmtiles";
export const PHOTOSTAFF_BASE_MAP_RELEASE_URL =
  "https://github.com/zhubby/ZOS/releases/download/map-natural-earth-ii-3.2.0/natural-earth-ii-3.2.0-raster.pmtiles";
export const PHOTOSTAFF_BASE_MAP_SIZE_BYTES = 23_141_432;
export const PHOTOSTAFF_BASE_MAP_SHA256 = "a9b54608526b54ef348862b15c43d0e79a9b491ad573ccbc121202d2f196f1ba";
export const PHOTOSTAFF_BASE_MAP_ATTRIBUTION = "Made with Natural Earth";
export const PHOTOSTAFF_MAX_FILE_SIZE_BYTES = 512 * 1024 * 1024;
export const PHOTOSTAFF_THUMBNAIL_SIZE_PX = 512;
export const PHOTOSTAFF_PREVIEW_MAX_EDGE_PX = 2048;
export const PHOTOSTAFF_METADATA_SCHEMA_VERSION = 2;
export const PHOTOSTAFF_METADATA_MAX_LEAVES = 4096;
export const PHOTOSTAFF_METADATA_MAX_SCALAR_BYTES = 64 * 1024;
export const PHOTOSTAFF_METADATA_MAX_JSON_BYTES = 512 * 1024;
export const PHOTOSTAFF_METADATA_MAX_DEPTH = 16;
export const PHOTOSTAFF_XMP_MAX_FILE_SIZE_BYTES = 16 * 1024 * 1024;
export const PHOTOSTAFF_DEFAULT_PROCESSING_CONCURRENCY = 1;
export const PHOTOSTAFF_DEFAULT_SCAN_INTERVAL_MS = 30 * 60 * 1_000;
export const PHOTOSTAFF_DEFAULT_MAX_AUTO_RETRIES = 5;
export const PHOTOSTAFF_DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
export const PHOTOSTAFF_DEFAULT_RETRY_MAX_DELAY_MS = 300_000;
export const PHOTOSTAFF_DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const PHOTOSTAFF_DEFAULT_MAX_INTERMEDIATE_BYTES = 2 * 1024 ** 3;
export const PHOTOSTAFF_DEFAULT_MIN_FREE_SPACE_BYTES = 0;
export const PHOTOSTAFF_DEFAULT_MAX_DECODED_PIXELS = 268_402_689;
export const PHOTOSTAFF_DERIVATIVE_SCHEMA_VERSION = 1;
export const PHOTOSTAFF_XMP_EXTENSION = ".xmp";
export const PHOTOSTAFF_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif"
] as const;

export const PHOTOSTAFF_VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm",
  ".mpeg",
  ".mpg"
] as const;

export const PHOTOSTAFF_RAW_EXTENSIONS = [
  ".cr2",
  ".cr3",
  ".crw",
  ".nef",
  ".nrw",
  ".arw",
  ".srf",
  ".sr2",
  ".dng",
  ".raf",
  ".orf",
  ".rw2",
  ".pef",
  ".rwl",
  ".3fr",
  ".x3f",
  ".erf",
  ".kdc",
  ".mos",
  ".mrw",
  ".bay"
] as const;

export const PHOTOSTAFF_SUPPORTED_EXTENSIONS = [
  ...PHOTOSTAFF_IMAGE_EXTENSIONS,
  ...PHOTOSTAFF_VIDEO_EXTENSIONS,
  ...PHOTOSTAFF_RAW_EXTENSIONS
] as const;

export const PHOTOSTAFF_UPLOAD_EXTENSIONS = [
  ...PHOTOSTAFF_SUPPORTED_EXTENSIONS,
  PHOTOSTAFF_XMP_EXTENSION
] as const;

export type PhotostaffMediaKind = "image" | "video" | "raw";
export type PhotoMediaKind = PhotostaffMediaKind;

const PHOTOSTAFF_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".cr2": "image/x-canon-cr2",
  ".cr3": "image/x-canon-cr3",
  ".crw": "image/x-canon-crw",
  ".nef": "image/x-nikon-nef",
  ".nrw": "image/x-nikon-nrw",
  ".arw": "image/x-sony-arw",
  ".srf": "image/x-sony-srf",
  ".sr2": "image/x-sony-sr2",
  ".dng": "image/x-adobe-dng",
  ".raf": "image/x-fuji-raf",
  ".orf": "image/x-olympus-orf",
  ".rw2": "image/x-panasonic-rw2",
  ".pef": "image/x-pentax-pef",
  ".rwl": "image/x-leica-rwl",
  ".3fr": "image/x-hasselblad-3fr",
  ".x3f": "image/x-sigma-x3f",
  ".erf": "image/x-epson-erf",
  ".kdc": "image/x-kodak-kdc",
  ".mos": "image/x-mamiya-mos",
  ".mrw": "image/x-minolta-mrw",
  ".bay": "image/x-kodak-bay"
};

const PHOTOSTAFF_IMAGE_EXTENSION_SET = new Set<string>(PHOTOSTAFF_IMAGE_EXTENSIONS);
const PHOTOSTAFF_VIDEO_EXTENSION_SET = new Set<string>(PHOTOSTAFF_VIDEO_EXTENSIONS);
const PHOTOSTAFF_RAW_EXTENSION_SET = new Set<string>(PHOTOSTAFF_RAW_EXTENSIONS);

export function photostaffExtension(fileName: string): string {
  const name = fileName.trim().toLowerCase();
  const separator = name.lastIndexOf(".");
  return separator >= 0 ? name.slice(separator) : "";
}

export function photostaffMediaKind(fileName: string): PhotostaffMediaKind | null {
  const extension = photostaffExtension(fileName);
  if (PHOTOSTAFF_IMAGE_EXTENSION_SET.has(extension)) return "image";
  if (PHOTOSTAFF_VIDEO_EXTENSION_SET.has(extension)) return "video";
  if (PHOTOSTAFF_RAW_EXTENSION_SET.has(extension)) return "raw";
  return null;
}

export function photostaffMimeType(fileName: string): string | null {
  return PHOTOSTAFF_MIME_TYPES[photostaffExtension(fileName)] ?? null;
}

export const photoExtension = photostaffExtension;
export const photoMediaKind = photostaffMediaKind;
export const photoMimeType = photostaffMimeType;
