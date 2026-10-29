import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCyberOsRuntime,
  DEFAULT_MONITORING_CONFIG,
  loadBootstrap,
  loadCyberOsRuntime
} from "./config.js";

describe("CyberOS bootstrap", () => {
  it("uses an isolated workspace root and safe runtime constants by default", () => {
    const bootstrap = loadBootstrap({}, process.cwd());
    const runtime = createCyberOsRuntime(bootstrap);

    expect(bootstrap.environment).toBe("development");
    expect(bootstrap.paths.rootDir).toBe(path.join(process.cwd(), ".cyberos", "dev-root"));
    expect(bootstrap.api).toEqual({ host: "127.0.0.1", port: 3010, allowedOrigins: [] });
    expect(runtime.hostd.socketPath).toBe("/run/cyberos/hostd.sock");
    expect(runtime.terminal.socketPath).toBe("/run/cyberos/terminald.sock");
    expect(runtime.mcp.piTokenFile).toBe(path.join(bootstrap.paths.stateDir, "mcp", "pi.token"));
    expect(runtime.backup.passwordFile).toBe(
      path.join(bootstrap.paths.stateDir, "secrets", "backup", "restic-password")
    );
    expect(runtime.monitoring).toEqual(DEFAULT_MONITORING_CONFIG);
  });

  it("accepts only bootstrap environment values", () => {
    const runtime = loadCyberOsRuntime({
      CYBEROS_ENVIRONMENT: "development",
      CYBEROS_ROOT: "/tmp/cyberos-test",
      CYBEROS_API_HOST: "::1",
      CYBEROS_API_PORT: "4010",
      CYBEROS_ALLOWED_ORIGINS: "http://127.0.0.1:5173,http://localhost:5173"
    }, process.cwd());

    expect(runtime.paths.rootDir).toBe("/tmp/cyberos-test");
    expect(runtime.api).toEqual({
      host: "::1",
      port: 4010,
      allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"]
    });
  });

  it("rejects removed application configuration environment values", () => {
    expect(() => loadBootstrap({ CYBEROS_DOCKER_ENABLED: "1" }, process.cwd()))
      .toThrow("configure this feature in CyberOS settings");
    expect(() => loadBootstrap({ CYBEROS_MONITORING_ENABLED: "0" }, process.cwd()))
      .toThrow("configure this feature in CyberOS settings");
  });

  it("enforces the production root and loopback API boundary", () => {
    expect(() => loadBootstrap({
      CYBEROS_ENVIRONMENT: "production",
      CYBEROS_ROOT: "/tmp/cyberos"
    }, process.cwd())).toThrow("Production CyberOS root must be /cyberos");
    expect(() => loadBootstrap({ CYBEROS_API_HOST: "0.0.0.0" }, process.cwd()))
      .toThrow("must bind to a loopback host");
    expect(() => loadBootstrap({ CYBEROS_API_PORT: "70000" }, process.cwd()))
      .toThrow("between 1 and 65535");
  });
});
