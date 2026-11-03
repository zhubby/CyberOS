import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./check-node-version.mjs", import.meta.url));

describe("Node.js runtime minimum", () => {
  it.each(["22.19.0", "v22.19.0", "22.23.2", "24.0.0"])("accepts supported runtime %s", (version) => {
    const result = spawnSync(process.execPath, [script, version], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["20.19.0", "22.12.0", "22.18.9", "22.19", "22.19.0-rc.1", "invalid"])("rejects unsupported runtime %s", (version) => {
    const result = spawnSync(process.execPath, [script, version], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Node.js 22.19.0 or newer is required");
  });
});
