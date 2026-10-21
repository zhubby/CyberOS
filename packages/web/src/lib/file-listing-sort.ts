import type { FileEntry } from "../api.js";

export type FileSortDirection = "asc" | "desc";
export type FileSortKey = "name" | "modifiedAt" | "sizeBytes";

export interface FileSortState {
  key: FileSortKey;
  direction: FileSortDirection;
}

export function sortEntries(entries: FileEntry[], sort: FileSortState = { key: "name", direction: "asc" }): FileEntry[] {
  const directionFactor = sort.direction === "asc" ? 1 : -1;

  return [...entries].sort((left, right) => {
    const primaryComparison = compareEntriesByKey(left, right, sort.key);
    if (primaryComparison !== 0) {
      return primaryComparison * directionFactor;
    }

    const nameComparison = compareStrings(left.name, right.name);
    if (nameComparison !== 0) {
      return nameComparison;
    }

    return compareStrings(left.path, right.path);
  });
}

export function sortEntriesByModifiedAt(entries: FileEntry[], direction: FileSortDirection = "desc"): FileEntry[] {
  return sortEntries(entries, { key: "modifiedAt", direction });
}

function compareEntriesByKey(left: FileEntry, right: FileEntry, key: FileSortKey): number {
  if (key === "name") {
    return compareNames(left.name, right.name);
  }

  if (key === "sizeBytes") {
    return compareNumbers(getSortableSizeBytes(left), getSortableSizeBytes(right));
  }

  return compareStrings(left.modifiedAt, right.modifiedAt);
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    sensitivity: "base",
    numeric: true
  });
}

function getSortableSizeBytes(entry: FileEntry): number {
  return entry.kind === "directory" ? 0 : entry.sizeBytes;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
