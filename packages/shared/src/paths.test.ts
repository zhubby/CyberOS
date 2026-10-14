import { describe, expect, it } from "vitest";
import { assertPathInside, isPathInside, resolveZosPaths } from "./paths.js";

describe("ZOS paths", () => {
  it("derives every persistent production path from /zos", () => {
    expect(resolveZosPaths("/zos")).toEqual({
      rootDir: "/zos",
      configDir: "/zos/config",
      stateDir: "/zos/state",
      logsDir: "/zos/logs",
      homeDir: "/zos/home",
      dataRoot: "/zos/data",
      backupRoot: "/zos/data/backup",
      appsRoot: "/zos/apps",
      isoRoot: "/zos/iso",
      vmRoot: "/zos/vm",
      deployRoot: "/zos/deploy",
      systemBackupsDir: "/zos/system-backups",
      databasePath: "/zos/state/zos.sqlite",
      defaultDataRoot: "/zos/data/primary",
      hostdStateDir: "/zos/state/hostd",
      networkManagerStateDir: "/zos/state/hostd/network-manager",
      dockerStateDir: "/zos/state/hostd/docker-daemon",
      termuxHome: "/zos/home/termux",
      vodPlayerStateDir: "/zos/state/vod-player",
      runDir: "/run/zos"
    });
  });

  it("rejects relative roots and the filesystem root", () => {
    expect(() => resolveZosPaths(".zos/dev-root")).toThrow("absolute non-root directory");
    expect(() => resolveZosPaths("/")).toThrow("absolute non-root directory");
  });

  it("checks containment without accepting sibling prefixes", () => {
    expect(isPathInside("/zos/data/primary/file", "/zos/data")).toBe(true);
    expect(isPathInside("/zos/database/file", "/zos/data")).toBe(false);
    expect(assertPathInside("/zos/state/cache", "/zos/state", "cache")).toBe("/zos/state/cache");
    expect(() => assertPathInside("/zos/logs/cache", "/zos/state", "cache")).toThrow(
      "cache must be inside /zos/state"
    );
  });
});
