import { describe, expect, it } from "vitest";
import type { FileEntry } from "../api.js";
import { sortEntries, sortEntriesByModifiedAt } from "./file-listing-sort.js";

const entries: FileEntry[] = [
  {
    name: "zeta.txt",
    path: "zeta.txt",
    kind: "file",
    sizeBytes: 3,
    modifiedAt: "2026-08-20T12:00:00.000Z",
    isSafe: true
  },
  {
    name: "alpha.txt",
    path: "alpha.txt",
    kind: "file",
    sizeBytes: 3,
    modifiedAt: "2026-08-21T12:00:00.000Z",
    isSafe: true
  },
  {
    name: "beta.txt",
    path: "beta.txt",
    kind: "file",
    sizeBytes: 3,
    modifiedAt: "2026-08-21T12:00:00.000Z",
    isSafe: true
  },
  {
    name: "beta.txt",
    path: "nested/beta.txt",
    kind: "file",
    sizeBytes: 3,
    modifiedAt: "2026-08-21T12:00:00.000Z",
    isSafe: true
  }
];

const alphabeticalEntries: FileEntry[] = [
  {
    name: "zeta.txt",
    path: "zeta.txt",
    kind: "file",
    sizeBytes: 3,
    modifiedAt: "2026-08-22T12:00:00.000Z",
    isSafe: true
  },
  {
    name: "alpha.txt",
    path: "alpha.txt",
    kind: "file",
    sizeBytes: 3,
    modifiedAt: "2026-08-20T12:00:00.000Z",
    isSafe: true
  },
  {
    name: "beta.txt",
    path: "beta.txt",
    kind: "file",
    sizeBytes: 3,
    modifiedAt: "2026-08-21T12:00:00.000Z",
    isSafe: true
  }
];

const sizeEntries: FileEntry[] = [
  {
    name: "zeta.bin",
    path: "zeta.bin",
    kind: "file",
    sizeBytes: 512,
    modifiedAt: "2026-08-21T12:00:00.000Z",
    isSafe: true
  },
  {
    name: "large.bin",
    path: "large.bin",
    kind: "file",
    sizeBytes: 2048,
    modifiedAt: "2026-08-21T12:00:00.000Z",
    isSafe: true
  },
  {
    name: "empty.txt",
    path: "empty.txt",
    kind: "file",
    sizeBytes: 0,
    modifiedAt: "2026-08-21T12:00:00.000Z",
    isSafe: true
  },
  {
    name: "folder",
    path: "folder",
    kind: "directory",
    sizeBytes: 4096,
    modifiedAt: "2026-08-21T12:00:00.000Z",
    isSafe: true
  },
  {
    name: "alpha.bin",
    path: "alpha.bin",
    kind: "file",
    sizeBytes: 512,
    modifiedAt: "2026-08-21T12:00:00.000Z",
    isSafe: true
  }
];

describe("sortEntriesByModifiedAt", () => {
  it("sorts newest first by default", () => {
    expect(sortEntriesByModifiedAt(entries).map((entry) => entry.path)).toEqual([
      "alpha.txt",
      "beta.txt",
      "nested/beta.txt",
      "zeta.txt"
    ]);
  });

  it("sorts oldest first when requested", () => {
    expect(sortEntriesByModifiedAt(entries, "asc").map((entry) => entry.path)).toEqual([
      "zeta.txt",
      "alpha.txt",
      "beta.txt",
      "nested/beta.txt"
    ]);
  });

  it("does not mutate the original array", () => {
    const original = [...entries];
    sortEntriesByModifiedAt(entries, "desc");
    expect(entries).toEqual(original);
  });
});

describe("sortEntries", () => {
  it("sorts alphabetically by default", () => {
    expect(sortEntries(alphabeticalEntries).map((entry) => entry.path)).toEqual([
      "alpha.txt",
      "beta.txt",
      "zeta.txt"
    ]);
  });

  it("sorts largest files first by size", () => {
    expect(sortEntries(sizeEntries, { key: "sizeBytes", direction: "desc" }).map((entry) => entry.path)).toEqual([
      "large.bin",
      "alpha.bin",
      "zeta.bin",
      "empty.txt",
      "folder"
    ]);
  });

  it("sorts smallest files first by size", () => {
    expect(sortEntries(sizeEntries, { key: "sizeBytes", direction: "asc" }).map((entry) => entry.path)).toEqual([
      "empty.txt",
      "folder",
      "alpha.bin",
      "zeta.bin",
      "large.bin"
    ]);
  });

  it("does not mutate the original array", () => {
    const original = [...sizeEntries];
    sortEntries(sizeEntries, { key: "sizeBytes", direction: "asc" });
    expect(sizeEntries).toEqual(original);
  });
});
