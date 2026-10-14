import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelProviderSettingsRecord, PhotostaffMetadataDetail, PhotostaffQueryPage } from "@zos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhotostaffAgentTools, registerConfiguredProvider } from "./pi-agent.js";

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
