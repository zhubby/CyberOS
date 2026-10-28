import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { ModelProviderSettingsRecord } from "@cyberos/shared";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capabilityPendingRunId,
  getPiTurnFailure,
  mapPiAssistantMessageEnd,
  piAgentToolNames,
  projectPiSessionEntry,
  publicPiSessionFile,
  redactPiToolArgs,
  registerConfiguredProvider,
  startPiCancellationMonitor
} from "./pi-agent.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-pi-agent-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Pi agent provider configuration", () => {
  it("registers custom Anthropic-compatible models configured with a base URL", async () => {
    const modelRuntime = await createModelRuntime();
    const settings = modelProviderSettings({
      providerName: "anthropic",
      baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
      model: "qwen3.8-max"
    });

    expect(modelRuntime.getModel("anthropic", "qwen3.8-max")).toBeUndefined();

    registerConfiguredProvider(modelRuntime, settings);

    expect(modelRuntime.getModel("anthropic", "qwen3.8-max")).toMatchObject({
      provider: "anthropic",
      id: "qwen3.8-max",
      name: "qwen3.8-max",
      baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
      api: "anthropic-messages",
      input: ["text"],
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 16384
    });
  });

  it("registers custom OpenAI-compatible models configured with a base URL", async () => {
    const modelRuntime = await createModelRuntime();
    const settings = modelProviderSettings({
      providerName: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-model"
    });

    registerConfiguredProvider(modelRuntime, settings);

    expect(modelRuntime.getModel("openai", "local-model")).toMatchObject({
      provider: "openai",
      id: "local-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions"
    });
  });
});

describe("Pi agent response handling", () => {
  it("projects persisted Pi entries with stable source identities", async () => {
    const emit = vi.fn(async () => undefined);
    await projectPiSessionEntry({
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-10-27T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Inspecting files" },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "notes.txt" } }
        ],
        stopReason: "toolUse"
      }
    } as Parameters<typeof projectPiSessionEntry>[0], emit);
    await projectPiSessionEntry({
      type: "message",
      id: "tool-result-1",
      parentId: "assistant-1",
      timestamp: "2026-10-27T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "hello" }],
        isError: false,
        timestamp: 0
      }
    } as Parameters<typeof projectPiSessionEntry>[0], emit);

    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "tool_execution_start",
      sourceId: "tool:tool-1:start"
    }));
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "agent.message",
      sourceId: "entry:assistant-1:assistant",
      payload: expect.objectContaining({ content: "Inspecting files" })
    }));
    expect(emit).toHaveBeenNthCalledWith(3, expect.objectContaining({
      type: "tool_execution_end",
      sourceId: "tool:tool-1:end"
    }));
  });

  it("never exposes the host path of a Pi transcript in public events or stats", () => {
    expect(publicPiSessionFile("/cyberos/state/pi-sessions/session-1.jsonl")).toBe("session-1.jsonl");
    expect(publicPiSessionFile(null)).toBeNull();
  });

  it("maps assistant message_end provider errors and successful text", () => {
    const onAssistantMessage = vi.fn();
    const onAssistantFailure = vi.fn();
    const callbacks = { onAssistantMessage, onAssistantFailure };

    mapPiAssistantMessageEnd({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "400: data_inspection_failed"
    } as unknown as Parameters<typeof mapPiAssistantMessageEnd>[0], callbacks);

    expect(onAssistantFailure).toHaveBeenCalledWith("400: data_inspection_failed");
    expect(onAssistantMessage).not.toHaveBeenCalled();

    mapPiAssistantMessageEnd({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop"
    } as unknown as Parameters<typeof mapPiAssistantMessageEnd>[0], callbacks);

    expect(onAssistantMessage).toHaveBeenCalledWith("Done");
    expect(onAssistantFailure).toHaveBeenCalledTimes(1);
  });

  it("uses a fallback error and rejects empty terminal responses", () => {
    const onAssistantFailure = vi.fn();

    mapPiAssistantMessageEnd({
      role: "assistant",
      content: [],
      stopReason: "error"
    } as unknown as Parameters<typeof mapPiAssistantMessageEnd>[0], {
      onAssistantMessage: vi.fn(),
      onAssistantFailure
    });

    expect(onAssistantFailure).toHaveBeenCalledWith("Agent provider stopped with error");
    expect(getPiTurnFailure(null, "")).toBe("Agent provider returned an empty response");
    expect(getPiTurnFailure("Provider unavailable", "")).toBe("Provider unavailable");
    expect(getPiTurnFailure(null, "Done")).toBeNull();
  });
});

describe("Pi agent cancellation", () => {
  it("aborts an active turn once when its job becomes cancelled", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const abort = vi.fn(async () => undefined);
      const stop = startPiCancellationMonitor({
        isCancelled: () => cancelled,
        abort,
        intervalMs: 10
      });

      await vi.advanceTimersByTimeAsync(20);
      expect(abort).not.toHaveBeenCalled();

      cancelled = true;
      await vi.advanceTimersByTimeAsync(10);
      expect(abort).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(abort).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Pi MCP run continuation", () => {
  it("recognizes pending runs from direct and codemode MCP results", () => {
    const capabilityResult = {
      schemaVersion: "1.0",
      data: { state: "waiting_approval" },
      runId: "8092a6ca-b703-4863-88aa-78f2d911cc4a"
    };
    expect(capabilityPendingRunId({ structuredContent: capabilityResult })).toBe(capabilityResult.runId);
    expect(capabilityPendingRunId({ structuredContent: { structuredContent: capabilityResult } })).toBe(capabilityResult.runId);
    expect(capabilityPendingRunId({
      structuredContent: { ...capabilityResult, data: { state: "succeeded" } }
    })).toBeNull();
  });

  it("redacts secrets and URL credentials from durable tool events", () => {
    expect(redactPiToolArgs({
      request: {
        url: "https://user:password@example.test/file?token=secret",
        registryToken: "secret"
      }
    })).toEqual({
      request: {
        url: "https://example.test/file",
        registryToken: "[redacted]"
      }
    });
  });
});

describe("Pi MCP tool selection", () => {
  it("filters dynamically registered MCP tools to the CyberOS server and resource helpers", async () => {
    const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never" });
    const resourceLoader = new DefaultResourceLoader({
      cwd: tempDir,
      agentDir: path.join(tempDir, "pi-agent"),
      settingsManager,
      noExtensions: true,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            for (const tool of [
              stubTool("mcp__cyberos__cyberos_files_read", "direct"),
              stubTool("mcp__cyberos__cyberos_apps_inspect", "codemode"),
              stubTool("mcp__external__danger", "direct"),
              stubTool("mcp__external__lookup", "codemode"),
              stubTool("list_mcp_resources", "direct"),
              stubTool("list_mcp_resource_templates", "direct"),
              stubTool("read_mcp_resource", "direct")
            ]) {
              pi.registerTool(tool);
            }
          });
        }
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: tempDir,
      tools: piAgentToolNames({ mcpEnabled: true }),
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(tempDir)
    });

    try {
      await session.bindExtensions({});

      const activeTools = session.getActiveToolNames();
      const callableTools = session.getCallableToolNames();
      expect(activeTools).toContain("mcp__cyberos__cyberos_files_read");
      expect(activeTools).not.toContain("mcp__cyberos__cyberos_apps_inspect");
      expect(callableTools).toContain("mcp__cyberos__cyberos_apps_inspect");
      expect(callableTools).not.toContain("mcp__external__danger");
      expect(callableTools).not.toContain("mcp__external__lookup");
      expect(callableTools).toEqual(expect.arrayContaining([
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource"
      ]));
      for (const toolName of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
        expect(activeTools).not.toContain(toolName);
      }
    } finally {
      session.dispose();
    }
  });

  it("selects the exact MCP allowlist without a direct-tool fallback", () => {
    expect(piAgentToolNames({ mcpEnabled: false })).toEqual([]);

    expect(piAgentToolNames({ mcpEnabled: true })).toEqual([
      "codemode",
      "tool_search",
      "mcp__cyberos__*",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource"
    ]);
  });
});

async function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(tempDir, "auth.json"),
    modelsPath: null
  });
}

function modelProviderSettings(
  overrides: Partial<ModelProviderSettingsRecord>
): ModelProviderSettingsRecord {
  return {
    generation: 1,
    providerName: "openai",
    baseUrl: null,
    model: "",
    apiKey: "secret-token",
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

function stubTool(name: string, exposure: "direct" | "codemode"): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    exposure,
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      details: undefined
    })
  };
}
