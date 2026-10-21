import { describe, expect, it } from "vitest";
import { isPathWithinStoragePool } from "../../App.js";
import { defaultWorkspaceSearchOptions, hasWorkspaceSearchFilters } from "./WorkspacePane.js";

describe("isPathWithinStoragePool", () => {
  it("allows nested paths when the pool is mounted at the NAS root", () => {
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

  it("detects category, extraction, boundary, and sort filters", () => {
    const defaults = defaultWorkspaceSearchOptions();
    expect(hasWorkspaceSearchFilters({ ...defaults, categories: ["pdf"] })).toBe(true);
    expect(hasWorkspaceSearchFilters({ ...defaults, extractionStatuses: ["stale"] })).toBe(true);
    expect(hasWorkspaceSearchFilters({ ...defaults, sizeMin: "1024" })).toBe(true);
    expect(hasWorkspaceSearchFilters({ ...defaults, sort: { field: "mtime", direction: "desc" } })).toBe(true);
  });
});
