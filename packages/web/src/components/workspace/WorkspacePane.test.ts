import { describe, expect, it } from "vitest";
import { isPathWithinStoragePool } from "../../App.js";
import {
  defaultWorkspaceSearchOptions,
  hasWorkspaceSearchFilters,
  storagePoolRootDepth,
  storagePoolStateKey
} from "./WorkspacePane.js";

describe("isPathWithinStoragePool", () => {
  it("allows nested paths when the pool is mounted at the storage pool", () => {
    expect(isPathWithinStoragePool("docs/readme.txt", ".")).toBe(true);
    expect(isPathWithinStoragePool("../outside.txt", ".")).toBe(false);
  });

  it("keeps nested pool paths inside their mountpoint", () => {
    expect(isPathWithinStoragePool("pool/docs", "pool")).toBe(true);
    expect(isPathWithinStoragePool("pool-old/docs", "pool")).toBe(false);
    expect(isPathWithinStoragePool("pool/../outside", "pool")).toBe(false);
  });
});

describe("workspace search options", () => {
  it("treats the default relevance sort as an unfiltered file listing", () => {
    expect(hasWorkspaceSearchFilters(defaultWorkspaceSearchOptions())).toBe(false);
  });

  it("detects file type, boundary, and sort filters", () => {
    const defaults = defaultWorkspaceSearchOptions();
    expect(hasWorkspaceSearchFilters({ ...defaults, fileType: "pdf" })).toBe(true);
    expect(hasWorkspaceSearchFilters({ ...defaults, sizeMin: "1024" })).toBe(true);
    expect(hasWorkspaceSearchFilters({ ...defaults, sort: { field: "mtime", direction: "desc" } })).toBe(true);
  });
});

describe("storage pool HUD status", () => {
  it("maps every pool state to a localized status key", () => {
    expect(["ready", "warning", "offline", "unknown"].map((status) =>
      storagePoolStateKey(status as Parameters<typeof storagePoolStateKey>[0])
    )).toEqual([
      "workspace.storagePoolStates.ready",
      "workspace.storagePoolStates.warning",
      "workspace.storagePoolStates.offline",
      "workspace.storagePoolStates.unknown"
    ]);
  });

  it("keeps root-relative breadcrumbs visible for the canonical pool path", () => {
    expect(storagePoolRootDepth(".")).toBe(0);
    expect(storagePoolRootDepth("pool/nested")).toBe(2);
  });
});
