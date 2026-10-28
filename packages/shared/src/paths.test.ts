import { describe, expect, it } from "vitest";
import { assertPathInside, isPathInside, resolveCyberOsPaths } from "./paths.js";

describe("CyberOS paths", () => {
  it("derives every persistent production path from /cyberos", () => {
    expect(resolveCyberOsPaths("/cyberos")).toEqual({
      rootDir: "/cyberos",
      configDir: "/cyberos/config",
      stateDir: "/cyberos/state",
      logsDir: "/cyberos/logs",
      homeDir: "/cyberos/home",
      dataRoot: "/cyberos/data",
      backupRoot: "/cyberos/data/backup",
      appsRoot: "/cyberos/apps",
      isoRoot: "/cyberos/iso",
      vmRoot: "/cyberos/vm",
      deployRoot: "/cyberos/deploy",
      systemBackupsDir: "/cyberos/system-backups",
      databasePath: "/cyberos/state/cyberos.sqlite",
      metricsDatabasePath: "/cyberos/state/metrics.sqlite",
      defaultDataRoot: "/cyberos/data/primary",
      hostdStateDir: "/cyberos/state/hostd",
      networkManagerStateDir: "/cyberos/state/hostd/network-manager",
      dockerStateDir: "/cyberos/state/hostd/docker-daemon",
      termuxHome: "/cyberos/home/termux",
      vodPlayerStateDir: "/cyberos/state/vod-player",
      runDir: "/run/cyberos"
    });
  });

  it("rejects relative roots and the filesystem root", () => {
    expect(() => resolveCyberOsPaths(".cyberos/dev-root")).toThrow("absolute non-root directory");
    expect(() => resolveCyberOsPaths("/")).toThrow("absolute non-root directory");
  });

  it("checks containment without accepting sibling prefixes", () => {
    expect(isPathInside("/cyberos/data/primary/file", "/cyberos/data")).toBe(true);
    expect(isPathInside("/cyberos/database/file", "/cyberos/data")).toBe(false);
    expect(assertPathInside("/cyberos/state/cache", "/cyberos/state", "cache")).toBe("/cyberos/state/cache");
    expect(() => assertPathInside("/cyberos/logs/cache", "/cyberos/state", "cache")).toThrow(
      "cache must be inside /cyberos/state"
    );
  });
});
