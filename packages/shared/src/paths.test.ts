import { describe, expect, it } from "vitest";
import { assertPathInside, isPathInside, resolveCyberOsPaths } from "./paths.js";

describe("CyberOS paths", () => {
  it("derives every persistent production path from /cyberos", () => {
    expect(resolveCyberOsPaths("/cyberos")).toEqual({
      rootDir: "/cyberos",
      stateDir: "/cyberos/state",
      secretsDir: "/cyberos/state/secrets",
      backupSecretsDir: "/cyberos/state/secrets/backup",
      backupPasswordPath: "/cyberos/state/secrets/backup/restic-password",
      shareSecretsDir: "/cyberos/state/secrets/share",
      sharePasswordPath: "/cyberos/state/secrets/share/account-password",
      mcpSecretsDir: "/cyberos/state/secrets/mcp",
      mcpStateDir: "/cyberos/state/mcp",
      mcpTokenPath: "/cyberos/state/mcp/pi.token",
      piAgentStateDir: "/cyberos/state/pi-agent",
      piSkillsDir: "/cyberos/state/pi-agent/skills",
      tvStateDir: "/cyberos/state/tv",
      tvEnabledMarker: "/cyberos/state/tv/enabled",
      logsDir: "/cyberos/logs",
      homeDir: "/cyberos/home",
      dataRoot: "/cyberos/data",
      backupRoot: "/cyberos/backup",
      appsRoot: "/cyberos/apps",
      isoRoot: "/cyberos/iso",
      vmRoot: "/cyberos/vm",
      deployRoot: "/cyberos/deploy",
      systemBackupsDir: "/cyberos/system-backups",
      databasePath: "/cyberos/state/cyberos.sqlite",
      metricsDatabasePath: "/cyberos/state/metrics.sqlite",
      hostdStateDir: "/cyberos/state/hostd",
      networkManagerStateDir: "/cyberos/state/hostd/network-manager",
      dockerStateDir: "/cyberos/state/hostd/docker-daemon",
      terminalHome: "/cyberos/home/terminal",
      vodPlayerStateDir: "/cyberos/state/vod-player",
      runDir: "/run/cyberos"
    });
  });

  it("rejects relative roots and the filesystem root", () => {
    expect(() => resolveCyberOsPaths(".cyberos/dev-root")).toThrow("absolute non-root directory");
    expect(() => resolveCyberOsPaths("/")).toThrow("absolute non-root directory");
  });

  it("checks containment without accepting sibling prefixes", () => {
    expect(isPathInside("/cyberos/data/pool-1/file", "/cyberos/data")).toBe(true);
    expect(isPathInside("/cyberos/database/file", "/cyberos/data")).toBe(false);
    expect(assertPathInside("/cyberos/state/cache", "/cyberos/state", "cache")).toBe("/cyberos/state/cache");
    expect(() => assertPathInside("/cyberos/logs/cache", "/cyberos/state", "cache")).toThrow(
      "cache must be inside /cyberos/state"
    );
  });
});
