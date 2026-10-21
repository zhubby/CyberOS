import { describe, expect, it } from "vitest";
import { collectDockerDaemonStatus, normalizeDockerDaemonState, parseDockerDaemonStatus } from "./docker-daemon.js";

describe("Docker daemon status", () => {
  it.each([
    ["loaded", "active", "running", "success", "running"],
    ["loaded", "reloading", "reload", "success", "running"],
    ["loaded", "activating", "start", "success", "starting"],
    ["loaded", "deactivating", "stop-sigterm", "success", "stopping"],
    ["loaded", "inactive", "dead", "success", "stopped"],
    ["loaded", "failed", "failed", "exit-code", "failed"],
    ["not-found", "inactive", "dead", "success", "not_installed"]
  ] as const)("normalizes %s/%s/%s/%s as %s", (load, active, sub, result, expected) => {
    expect(normalizeDockerDaemonState(load, active, sub, result)).toBe(expected);
  });

  it("preserves machine-readable systemd properties", () => {
    expect(
      parseDockerDaemonStatus("LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\n")
    ).toMatchObject({
      state: "running",
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      result: "success"
    });
  });

  it("returns a failed collection state without exposing command output", async () => {
    const status = await collectDockerDaemonStatus({
      async run() {
        throw new Error("systemctl secret output");
      }
    });
    expect(status).toMatchObject({ state: "failed", result: "collection-error" });
    expect(JSON.stringify(status)).not.toContain("secret");
  });
});
