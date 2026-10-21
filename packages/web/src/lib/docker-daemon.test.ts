import { describe, expect, it } from "vitest";
import { dockerDaemonTone, parseDockerDaemonEvent, validateDockerDaemonJson } from "./docker-daemon.js";

describe("Docker daemon UI helpers", () => {
  it("accepts only JSON objects", () => {
    expect(validateDockerDaemonJson('{"live-restore":true}')).toEqual({ valid: true, reason: null });
    expect(validateDockerDaemonJson("{")).toEqual({ valid: false, reason: "syntax" });
    expect(validateDockerDaemonJson("[]")).toEqual({ valid: false, reason: "object" });
    expect(validateDockerDaemonJson("null")).toEqual({ valid: false, reason: "object" });
  });

  it("maps daemon states to operational tones", () => {
    expect(dockerDaemonTone("running")).toBe("ready");
    expect(dockerDaemonTone("starting")).toBe("warning");
    expect(dockerDaemonTone("failed")).toBe("warning");
    expect(dockerDaemonTone("stopped")).toBe("offline");
    expect(dockerDaemonTone("not_installed")).toBe("offline");
  });

  it("parses typed SSE payloads and rejects malformed events", () => {
    expect(
      parseDockerDaemonEvent(
        JSON.stringify({
          state: "running",
          loadState: "loaded",
          activeState: "active",
          subState: "running",
          result: "success",
          collectedAt: "2026-09-16T00:00:00.000Z"
        })
      )
    ).toMatchObject({ state: "running", activeState: "active" });
    expect(parseDockerDaemonEvent('{"state":"ready"}')).toBeNull();
    expect(parseDockerDaemonEvent("not json")).toBeNull();
  });
});
