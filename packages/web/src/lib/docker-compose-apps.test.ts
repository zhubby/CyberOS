import { describe, expect, it } from "vitest";
import {
  dockerComposeAppForm,
  dockerComposeAppFormError,
  dockerComposeCreateEnvironment,
  dockerComposeProjectKey,
  dockerComposeUpdateEnvironment,
  initialDockerComposeAppForm
} from "./docker-compose-apps.js";

describe("Docker Compose App form helpers", () => {
  it("generates a stable safe project key from the display name", () => {
    expect(dockerComposeProjectKey("  Media Server  ")).toBe("media-server");
    expect(dockerComposeProjectKey("照片服务")).toBe("app");
  });

  it("preserves configured values only for update rows left blank", () => {
    const rows = [
      { key: "TOKEN", value: "", valueConfigured: true, originalKey: "TOKEN", valueChanged: false },
      { key: "PORT", value: "8080", valueConfigured: true, originalKey: "PORT", valueChanged: true },
      { key: "EMPTY", value: "", valueConfigured: false, originalKey: null, valueChanged: false }
    ];
    expect(dockerComposeUpdateEnvironment(rows)).toEqual([
      { key: "TOKEN" },
      { key: "PORT", value: "8080" },
      { key: "EMPTY", value: "" }
    ]);
    expect(dockerComposeCreateEnvironment(rows)).toEqual([
      { key: "TOKEN", value: "" },
      { key: "PORT", value: "8080" },
      { key: "EMPTY", value: "" }
    ]);
  });

  it("hydrates secret summaries without exposing a value", () => {
    const form = dockerComposeAppForm({
      id: "app-1",
      name: "Media",
      projectKey: "media",
      managedPath: "/cyberos/apps/media",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: [{ key: "TOKEN", valueConfigured: true }],
      services: ["app"],
      warnings: [],
      risk: "medium",
      revision: "revision-1",
      deployedRevision: null,
      needsDeploy: true,
      containerCount: 0,
      runningCount: 0,
      status: "configured",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z"
    });
    expect(form.environment).toEqual([{
      key: "TOKEN",
      value: "",
      valueConfigured: true,
      originalKey: "TOKEN",
      valueChanged: false
    }]);
  });

  it("validates project keys, duplicate variables, and reserved variables", () => {
    const form = initialDockerComposeAppForm();
    form.name = "Media";
    form.projectKey = "Media App";
    expect(dockerComposeAppFormError(form)).toBe("projectKey");
    form.projectKey = "media";
    form.environment = [
      { key: "PORT", value: "1", valueConfigured: false, originalKey: null, valueChanged: true },
      { key: "PORT", value: "2", valueConfigured: false, originalKey: null, valueChanged: true }
    ];
    expect(dockerComposeAppFormError(form)).toBe("environmentDuplicate");
    form.environment = [{ key: "COMPOSE_FILE", value: "elsewhere.yaml", valueConfigured: false, originalKey: null, valueChanged: true }];
    expect(dockerComposeAppFormError(form)).toBe("environmentKey");
  });

  it("distinguishes preserving a configured value from replacing it with an empty value", () => {
    expect(dockerComposeUpdateEnvironment([
      { key: "TOKEN", value: "", valueConfigured: true, originalKey: "TOKEN", valueChanged: true }
    ])).toEqual([{ key: "TOKEN", value: "" }]);

    const form = initialDockerComposeAppForm();
    form.name = "Media";
    form.projectKey = "media";
    form.environment = [{
      key: "RENAMED_TOKEN",
      value: "",
      valueConfigured: true,
      originalKey: "TOKEN",
      valueChanged: false
    }];
    expect(dockerComposeAppFormError(form)).toBe("environmentValue");
  });
});
