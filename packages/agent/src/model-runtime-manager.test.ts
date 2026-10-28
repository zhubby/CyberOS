import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentProviderSessionRecord, ModelProviderSettingsRecord } from "@cyberos/shared";
import { describe, expect, it, vi } from "vitest";
import { ModelRuntimeManager, resolveRuntimeSettings } from "./model-runtime-manager.js";

describe("ModelRuntimeManager", () => {
  it("creates at most one runtime for a generation and applies the current credential", async () => {
    const runtime = fakeRuntime({ authenticated: true });
    const createRuntime = vi.fn(async () => runtime);
    const manager = new ModelRuntimeManager("/tmp/cyberos-agent", createRuntime);
    const settings = modelSettings({ generation: 3, apiKey: "current-secret", model: "model-3" });

    const [first, second] = await Promise.all([
      manager.get(settings, null),
      manager.get(settings, null)
    ]);

    expect(first).toBe(second);
    expect(first).toMatchObject({ generation: 3, settings });
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("openai", "current-secret");
    expect(manager.size).toBe(1);
  });

  it("keeps an existing session on its saved generation without borrowing new credentials", async () => {
    const runtime = fakeRuntime({ authenticated: false });
    const manager = new ModelRuntimeManager("/tmp/cyberos-agent", async () => runtime);
    const current = modelSettings({ generation: 4, apiKey: "new-secret", model: "current-model" });
    const providerSession = savedSession({
      runtimeGeneration: 2,
      runtimeModel: "old-model",
      settingsSnapshot: {
        generation: 2,
        baseUrl: null,
        updatedAt: "2026-10-20T00:00:00.000Z"
      }
    });

    expect(resolveRuntimeSettings(current, providerSession)).toMatchObject({
      generation: 2,
      providerName: "openai",
      model: "old-model",
      apiKey: null
    });
    await expect(manager.get(current, providerSession)).rejects.toThrow(
      "Runtime generation 2 no longer has credentials"
    );
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("isolates legacy sessions that share a generation but use different models", async () => {
    const runtimes = [fakeRuntime({ authenticated: true }), fakeRuntime({ authenticated: true })];
    let runtimeIndex = 0;
    const createRuntime = vi.fn(async () => runtimes[runtimeIndex++] as ModelRuntime);
    const manager = new ModelRuntimeManager("/tmp/cyberos-agent", createRuntime);
    const current = modelSettings({ generation: 2, model: "current-model" });

    const first = await manager.get(current, savedSession({
      runtimeGeneration: 1,
      runtimeModel: "legacy-a"
    }));
    const second = await manager.get(current, savedSession({
      sessionId: "session-2",
      runtimeGeneration: 1,
      runtimeModel: "legacy-b"
    }));

    expect(first).not.toBe(second);
    expect(first.model).toMatchObject({ id: "legacy-a" });
    expect(second.model).toMatchObject({ id: "legacy-b" });
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(manager.size).toBe(2);
  });
});

function fakeRuntime(input: { authenticated: boolean }): ModelRuntime {
  return {
    registerProvider: vi.fn(),
    getModel: vi.fn((provider: string, model: string) => ({ provider, id: model })),
    setRuntimeApiKey: vi.fn(async () => undefined),
    hasConfiguredAuth: vi.fn(() => input.authenticated)
  } as unknown as ModelRuntime;
}

function modelSettings(overrides: Partial<ModelProviderSettingsRecord> = {}): ModelProviderSettingsRecord {
  return {
    generation: 1,
    providerName: "openai",
    baseUrl: null,
    model: "model-1",
    apiKey: "secret",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...overrides
  };
}

function savedSession(overrides: Partial<AgentProviderSessionRecord> = {}): AgentProviderSessionRecord {
  return {
    sessionId: "session-1",
    providerSessionId: "pi-session-1",
    sessionFile: "/tmp/session.jsonl",
    providerName: "openai",
    model: "old-model",
    settingsSnapshot: {},
    runtimeGeneration: 1,
    runtimeProvider: "openai",
    runtimeModel: "old-model",
    projectionCursor: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...overrides
  };
}
