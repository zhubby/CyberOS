import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  dockerSettingsToForm,
  modelSettingsToForm,
  settingsSectionState,
  type SettingsSection
} from "./settings.js";

describe("settings helpers", () => {
  it("treats saved Docker settings as configured even when disabled", () => {
    const section: SettingsSection = {
      id: "docker",
      group: "administration"
    };

    expect(settingsSectionState(section, null, null)).toBe("missing");
    expect(
      settingsSectionState(section, null, {
        enabled: false,
        socketPath: "/var/run/docker.sock",
        composeCommand: "docker",
        operationTimeoutMs: 120_000,
        consoleShells: ["/bin/sh", "/bin/bash"],
        updatedAt: "2026-01-01T00:00:00.000Z"
      })
    ).toBe("ready");
  });

  it("hydrates Docker form defaults from the runtime config", () => {
    expect(dockerSettingsToForm(null)).toMatchObject({
      enabled: false,
      socketPath: "/var/run/docker.sock",
      composeCommand: "docker",
      operationTimeoutMs: String(120_000),
      consoleShells: "/bin/sh, /bin/bash",
    });
  });

  it("hydrates model provider form defaults without a display name", () => {
    expect(modelSettingsToForm(null)).toMatchObject({
      providerName: "openai",
      baseUrl: "",
      model: "",
      apiKey: "",
      clearApiKey: false
    });
  });

  it("reports the running version in the dedicated settings section", () => {
    const section: SettingsSection = {
      id: "version",
      group: "cyberos"
    };
    const buildInfo = {
      version: "0.2.0",
      commitSha: "0123456789abcdef",
      commitShortSha: "0123456789ab",
      tag: "v0.2.0",
      branch: "main",
      builtAt: "2026-09-14T08:00:00.000Z",
      source: "release" as const,
      dirty: false,
      reproducible: false
    };
    expect(settingsSectionState(section, null, null, buildInfo)).toBe("ready");
    expect(settingsSectionState(section, null, null, null)).toBe("missing");
  });

  it("reflects photo library scan state in the settings navigation", () => {
    const section: SettingsSection = {
      id: "photos",
      group: "workspace"
    };
    const photoStatus = {
      state: "processing" as const,
      total: 24,
      failed: 0,
      scanned: 30,
      processed: 24,
      currentPath: "Photo/2026",
      phase: "processing" as const,
      error: null,
      errorCode: null,
      retryCount: 0,
      nextRetryAt: null,
      updatedAt: "2026-09-24T00:01:00.000Z"
    };
    expect(settingsSectionState(section, null, null, null, null, photoStatus)).toBe("loading");
    expect(settingsSectionState(section, null, null, null, null, {
      ...photoStatus,
      state: "unconfigured"
    })).toBe("missing");
  });

  it("does not expose the deleted security section", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).not.toContain("security");
  });

  it("groups wireless and Bluetooth settings under devices", () => {
    expect(SETTINGS_SECTIONS.filter((section) => section.group === "devices").map((section) => section.id))
      .toEqual(["wireless", "bluetooth"]);
  });
});
