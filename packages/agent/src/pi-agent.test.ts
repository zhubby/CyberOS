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
import type { ModelProviderSettingsRecord, PhotostaffMetadataDetail, PhotostaffQueryPage } from "@zos/shared";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capabilityPendingRunId,
  createPhotostaffAgentTools,
  getPiTurnFailure,
  mapPiAssistantMessageEnd,
  piAgentToolNames,
  previewPiToolArgs,
  redactPiToolArgs,
  registerConfiguredProvider,
  startPiCancellationMonitor
} from "./pi-agent.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-pi-agent-"));
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

  it("redacts secrets and complete legacy mutation payloads from durable events", () => {
    expect(redactPiToolArgs("bash", {
      command: "curl -H 'Authorization: Bearer secret' https://example.test",
      env: { API_KEY: "secret", LANG: "en_US.UTF-8" }
    })).toEqual({
      command: "[59 byte command redacted]",
      env: { API_KEY: "[redacted]", LANG: "en_US.UTF-8" }
    });
    expect(redactPiToolArgs("write", { path: "notes.txt", content: "private content" })).toEqual({
      path: "notes.txt",
      content: "[15 bytes]"
    });
    expect(redactPiToolArgs("zos.downloads.manage-propose", {
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

  it("keeps approval previews reviewable while redacting common secrets", () => {
    expect(previewPiToolArgs("bash", {
      command: "API_KEY=secret;printf ok && curl --token 'hidden' -H 'Authorization: Bearer bearer-secret' https://user:password@example.test/path?token=secret;printf done",
      env: { PASSWORD: "secret", LANG: "en_US.UTF-8" }
    })).toEqual({
      command: "API_KEY=[redacted];printf ok && curl --token [redacted] -H 'Authorization: Bearer [redacted]' https://example.test/path;printf done",
      env: { PASSWORD: "[redacted]", LANG: "en_US.UTF-8" }
    });
    expect(previewPiToolArgs("write", {
      path: "notes.txt",
      content: "title=Review me\npassword: private"
    })).toEqual({
      path: "notes.txt",
      content: "title=Review me\npassword: [redacted]",
      contentBytes: 33
    });
    expect(previewPiToolArgs("edit", {
      path: "notes.txt",
      edits: [{ oldText: "before", newText: "after" }]
    })).toEqual({
      path: "notes.txt",
      edits: [{ oldText: "before", newText: "after" }],
      editCount: 1
    });
  });
});

describe("Pi MCP tool selection", () => {
  it("filters dynamically registered MCP tools to the ZOS server and resource helpers", async () => {
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
              stubTool("mcp__zos__zos_files_read", "direct"),
              stubTool("mcp__zos__zos_apps_inspect", "codemode"),
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
      tools: piAgentToolNames({
        mcpEnabled: true,
        legacyToolsEnabled: false,
        photostaffToolsEnabled: false
      }),
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(tempDir)
    });

    try {
      await session.bindExtensions({});

      const activeTools = session.getActiveToolNames();
      const callableTools = session.getCallableToolNames();
      expect(activeTools).toContain("mcp__zos__zos_files_read");
      expect(activeTools).not.toContain("mcp__zos__zos_apps_inspect");
      expect(callableTools).toContain("mcp__zos__zos_apps_inspect");
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

  it("selects exact tool allowlists for MCP, legacy, and Photostaff modes", () => {
    expect(piAgentToolNames({
      mcpEnabled: false,
      legacyToolsEnabled: false,
      photostaffToolsEnabled: false
    })).toEqual([]);

    expect(piAgentToolNames({
      mcpEnabled: true,
      legacyToolsEnabled: false,
      photostaffToolsEnabled: false
    })).toEqual([
      "codemode",
      "tool_search",
      "mcp__zos__*",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource"
    ]);

    expect(piAgentToolNames({
      mcpEnabled: false,
      legacyToolsEnabled: true,
      photostaffToolsEnabled: false
    })).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);

    expect(piAgentToolNames({
      mcpEnabled: false,
      legacyToolsEnabled: true,
      photostaffToolsEnabled: true
    })).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "search_photostaff",
      "get_photostaff_metadata"
    ]);
  });
});

describe("photostaff agent tools", () => {
  it("exposes structured read-only tools and strips sensitive metadata defensively", async () => {
    const page: PhotostaffQueryPage = {
      photostaff: [{
        id: "photostaff-1",
        rootId: "root-1",
        storagePoolId: "pool-1",
        path: "Photostaff/photostaff-1.jpg",
        name: "photostaff-1.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 100,
        mtimeMs: 0,
        contentHash: "hash-1",
        width: 100,
        height: 100,
        orientation: 1,
        takenAt: "2026-01-01T00:00:00.000Z",
        takenAtSource: "exif",
        thumbnailKey: null,
        previewKey: null,
        status: "ready",
        error: null,
        errorCode: null,
        errorRetryable: false,
        derivativeSchemaVersion: 1,
        indexedAt: "2026-01-01T00:00:00.000Z",
        metadata: null,
        keywords: [],
        distanceMeters: 321.5
      }],
      nextCursor: null,
      total: 1,
      facets: null,
      metadataIndex: { schemaVersion: 1, total: 0, indexed: 0, partial: 0, pending: 0 }
    };
    const detail: PhotostaffMetadataDetail = {
      assetId: "photostaff-1",
      summary: null,
      keywords: ["Travel"],
      groups: {
        exif: { ISO: [800], GPSLatitude: [31.23], BodySerialNumber: ["secret"] },
        gps: { longitude: [121.47] },
        xmp: { title: ["Shanghai"], contactEmail: ["private@example.com"] }
      },
      sensitiveGroups: { exif: { GPSLongitude: [121.47] } },
      sensitiveOmitted: false,
      warnings: []
    };
    const searchPhotostaff = vi.fn(async () => page);
    const tools = createPhotostaffAgentTools({
      searchPhotostaff,
      getPhotostaffMetadata: async () => detail
    }) as unknown as Array<{
      name: string;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    }>;

    expect(tools.map((tool) => tool.name)).toEqual(["search_photostaff", "get_photostaff_metadata"]);
    const searchOutput = await tools.find((tool) => tool.name === "search_photostaff")!.execute("call-0", {
      filters: { location: { kind: "near", latitude: 31.23, longitude: 121.47, radiusMeters: 1_000 } },
      limit: 100
    });
    expect(searchPhotostaff).toHaveBeenCalledWith(expect.objectContaining({
      filters: { location: { kind: "near", latitude: 31.23, longitude: 121.47, radiusMeters: 1_000 } },
      includeFacets: false,
      limit: 25
    }));
    expect(searchOutput.content[0]?.text).toContain('"total": 1');
    expect(searchOutput.content[0]?.text).not.toContain("distanceMeters");

    const invalidDistance = await tools.find((tool) => tool.name === "search_photostaff")!.execute("call-distance", {
      sort: { field: "distance", direction: "asc" }
    });
    expect(invalidDistance.content[0]?.text).toContain("nearby location filter");
    expect(searchPhotostaff).toHaveBeenCalledTimes(1);

    const output = await tools.find((tool) => tool.name === "get_photostaff_metadata")!.execute("call-1", { assetId: "photostaff-1" });
    expect(output.content[0]?.text).toContain("Shanghai");
    expect(output.content[0]?.text).not.toMatch(/31\.23|121\.47|secret|private@example/u);
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
