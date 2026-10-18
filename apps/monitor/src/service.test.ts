import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@zos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createMonitorRuntime } from "./service.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("createMonitorRuntime", () => {
  it("stays active but idle when monitoring is disabled", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-monitor-disabled-"));
    const config = loadConfig({
      ZOS_CONFIG: path.join(tempDir, "missing.toml"),
      ZOS_ROOT: path.join(tempDir, "root"),
      ZOS_MONITORING_ENABLED: "0"
    } as NodeJS.ProcessEnv, tempDir);

    const runtime = createMonitorRuntime(config);
    expect(runtime.state).toBe("disabled");
    runtime.start();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});
