import { spawn } from "node:child_process";
import { mkdir, lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  isPathInside,
  listDir,
  readText,
  resolveSafeExistingPath,
  resolveSafeTargetPath,
  searchFiles,
  toRootRelative
} from "@zos/nas-tools";
import type {
  AgentProviderSessionRecord,
  AgentSessionRecord,
  ApprovalStatus,
  ModelProviderSettingsRecord,
  ModelProviderName,
  NasRootRecord,
  PendingApprovalRecord,
  PiToolCallApproval,
  PiToolName,
  PiToolPolicySettingsRecord,
  PhotostaffMetadataDetail,
  PhotostaffQueryPage,
  PhotostaffQueryRequest
} from "@zos/shared";

export interface PiAgentEmitEvent {
  type:
    | "agent.started"
    | "agent.message"
    | "agent.completed"
    | "agent.failed"
    | "tool_call.started"
    | "tool_call.completed"
    | "tool_call.failed"
    | "approval.pending";
  payload: Record<string, unknown>;
}

export interface PiAgentTurnResult {
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  error?: string;
}

export interface PiAgentInput {
  session: AgentSessionRecord;
  root: NasRootRecord;
  message: string;
  dataDir: string;
  modelSettings: ModelProviderSettingsRecord;
  toolPolicy: PiToolPolicySettingsRecord;
  providerSession: AgentProviderSessionRecord | null;
  emit: (event: PiAgentEmitEvent) => void | Promise<void>;
  isCancelled?: () => boolean;
  saveProviderSession: (session: {
    providerSessionId: string;
    sessionFile: string | null;
    providerName: ModelProviderName;
    model: string;
    settingsSnapshot: Record<string, unknown>;
  }) => void | Promise<void>;
  createToolApproval: (approval: PiToolCallApproval) => Promise<PendingApprovalRecord>;
  getApprovalStatus: (approvalId: string) => Promise<ApprovalStatus | null> | ApprovalStatus | null;
  markWaitingForApproval?: () => void | Promise<void>;
  photostaffTools?: PhotostaffAgentToolService;
  runner?: PiAgentRunner;
}

export interface PhotostaffAgentToolService {
  searchPhotostaff: (request: PhotostaffQueryRequest) => Promise<PhotostaffQueryPage>;
  getPhotostaffMetadata: (assetId: string) => Promise<PhotostaffMetadataDetail | null>;
}

export type PiAgentRunner = (input: PiAgentRuntimeInput) => Promise<PiAgentTurnResult>;

export interface PiAgentRuntimeInput {
  session: AgentSessionRecord;
  root: NasRootRecord;
  message: string;
  dataDir: string;
  modelSettings: ModelProviderSettingsRecord;
  toolPolicy: PiToolPolicySettingsRecord;
  providerSession: AgentProviderSessionRecord | null;
  emit: (event: PiAgentEmitEvent) => void | Promise<void>;
  isCancelled: () => boolean;
  saveProviderSession: PiAgentInput["saveProviderSession"];
  createToolApproval: PiAgentInput["createToolApproval"];
  getApprovalStatus: PiAgentInput["getApprovalStatus"];
  markWaitingForApproval?: PiAgentInput["markWaitingForApproval"];
  photostaffTools?: PhotostaffAgentToolService;
}

type TextToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

const ALL_PI_TOOL_NAMES: PiToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const APPROVAL_POLL_MS = 500;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
type PiProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
type PiProviderApi = NonNullable<PiProviderConfig["api"]>;

export async function runPiAgentTurn(input: PiAgentInput): Promise<PiAgentTurnResult> {
  const runtimeInput: PiAgentRuntimeInput = {
    ...input,
    isCancelled: input.isCancelled ?? (() => false)
  };
  return (input.runner ?? runPiSdkAgentTurn)(runtimeInput);
}

export function registerConfiguredProvider(
  modelRuntime: ModelRuntime,
  settings: ModelProviderSettingsRecord
): void {
  if (!settings.baseUrl) {
    return;
  }

  if (settings.model && !modelRuntime.getModel(settings.providerName, settings.model)) {
    modelRuntime.registerProvider(settings.providerName, {
      baseUrl: settings.baseUrl,
      api: providerApi(settings.providerName),
      models: [configuredProviderModel(settings)]
    });
    return;
  }

  modelRuntime.registerProvider(settings.providerName, {
    baseUrl: settings.baseUrl
  });
}

function providerApi(providerName: ModelProviderName): PiProviderApi {
  return providerName === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function configuredProviderModel(settings: ModelProviderSettingsRecord): NonNullable<PiProviderConfig["models"]>[number] {
  return {
    id: settings.model,
    name: settings.model,
    api: providerApi(settings.providerName),
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128000,
    maxTokens: 16384
  };
}

async function runPiSdkAgentTurn(input: PiAgentRuntimeInput): Promise<PiAgentTurnResult> {
  let latestAssistantText = "";
  let started = false;

  try {
    if (!input.modelSettings.apiKey) {
      throw new Error(`Pi API key is not configured for provider "${input.modelSettings.providerName}"`);
    }
    if (input.isCancelled()) {
      return { status: "cancelled" };
    }

    const piSessionDir = path.join(input.dataDir, "pi-sessions");
    const piAgentDir = path.join(input.dataDir, "pi-agent");
    await mkdir(piSessionDir, { recursive: true });
    await mkdir(piAgentDir, { recursive: true });

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(piAgentDir, "auth.json"),
      modelsPath: null
    });
    registerConfiguredProvider(modelRuntime, input.modelSettings);
    await modelRuntime.setRuntimeApiKey(input.modelSettings.providerName, input.modelSettings.apiKey);

    const model = input.modelSettings.model
      ? modelRuntime.getModel(input.modelSettings.providerName, input.modelSettings.model)
      : undefined;
    if (input.modelSettings.model && !model) {
      throw new Error(
        `Pi model "${input.modelSettings.model}" is not available for provider "${input.modelSettings.providerName}". Set a Base URL when using a custom model ID.`
      );
    }

    const sessionManager =
      input.providerSession?.sessionFile
        ? SessionManager.open(input.providerSession.sessionFile, piSessionDir, input.root.path)
        : SessionManager.create(input.root.path, piSessionDir, { id: input.session.id });
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: input.modelSettings.providerName,
      ...(input.modelSettings.model ? { defaultModel: input.modelSettings.model } : {}),
      defaultProjectTrust: "never"
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.root.path,
      agentDir: piAgentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      appendSystemPrompt: [
        [
          "You are running inside ZOS.",
          "All filesystem access must go through ZOS tools and stay inside the configured NAS root.",
          "Use bash, edit, and write only when needed; ZOS will ask the user for approval before executing them."
        ].join("\n")
      ]
    });
    await resourceLoader.reload();

    const { session: piSession } = await createAgentSession({
      cwd: input.root.path,
      agentDir: piAgentDir,
      modelRuntime,
      ...(model ? { model } : {}),
      tools: ALL_PI_TOOL_NAMES,
      customTools: createZosPiTools(input),
      resourceLoader,
      settingsManager,
      sessionManager
    });

    await input.saveProviderSession({
      providerSessionId: piSession.sessionId,
      sessionFile: piSession.sessionFile ?? null,
      providerName: input.modelSettings.providerName,
      model: input.modelSettings.model,
      settingsSnapshot: settingsSnapshot(input.modelSettings)
    });

    const unsubscribe = piSession.subscribe((event) => {
      void mapPiEvent(event, input.emit, {
        onStarted: () => {
          started = true;
        },
        onAssistantMessage: (content) => {
          latestAssistantText = content;
        }
      });
    });

    try {
      await piSession.prompt(input.message);
      await piSession.waitForIdle();
    } finally {
      unsubscribe();
      piSession.dispose();
    }

    if (input.isCancelled()) {
      return { status: "cancelled" };
    }
    if (latestAssistantText) {
      await input.emit({
        type: "agent.message",
        payload: {
          role: "assistant",
          content: latestAssistantText
        }
      });
    }
    await input.emit({
      type: "agent.completed",
      payload: {
        provider: "pi",
        providerSessionId: piSession.sessionId,
        sessionFile: piSession.sessionFile ?? null,
        summary: latestAssistantText
      }
    });
    return {
      status: "completed",
      summary: latestAssistantText
    };
  } catch (error) {
    if (input.isCancelled()) {
      return { status: "cancelled" };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!started) {
      await input.emit({
        type: "agent.started",
        payload: {
          provider: "pi"
        }
      });
    }
    await input.emit({
      type: "agent.failed",
      payload: {
        provider: "pi",
        error: message
      }
    });
    return {
      status: "failed",
      error: message
    };
  }
}

function createZosPiTools(input: PiAgentRuntimeInput): ToolDefinition[] {
  const read = createReadToolDefinition(input.root.path);
  const bash = createBashToolDefinition(input.root.path);
  const edit = createEditToolDefinition(input.root.path);
  const write = createWriteToolDefinition(input.root.path);
  const grep = createGrepToolDefinition(input.root.path);
  const find = createFindToolDefinition(input.root.path);
  const ls = createLsToolDefinition(input.root.path);

  const readTool = {
      ...read,
      execute: async (_toolCallId: string, params: Parameters<typeof read.execute>[1]) => {
        if (input.toolPolicy.read === "disabled") {
          return textResult("ZOS policy denied read.");
        }
        const preview = await readText(input.root, params.path, MAX_TOOL_OUTPUT_BYTES);
        const content = sliceLines(preview.content, params.offset, params.limit);
        return textResult(content + (preview.truncated ? "\n\n[Output truncated]" : ""), {
          truncation: preview.truncated ? { truncated: true } : undefined
        });
      }
    } as typeof read;
  const lsTool = {
      ...ls,
      execute: async (_toolCallId: string, params: Parameters<typeof ls.execute>[1]) => {
        if (input.toolPolicy.ls === "disabled") {
          return textResult("ZOS policy denied ls.");
        }
        const entries = await listDir(input.root, params.path ?? ".");
        const limit = params.limit ?? 100;
        return textResult(
          entries
            .slice(0, limit)
            .map((entry) => `${entry.kind.padEnd(9)} ${entry.path}`)
            .join("\n") || "(empty)",
          {
            entryLimitReached: entries.length > limit ? limit : undefined
          }
        );
      }
    } as typeof ls;
  const findTool = {
      ...find,
      execute: async (_toolCallId: string, params: Parameters<typeof find.execute>[1]) => {
        if (input.toolPolicy.find === "disabled") {
          return textResult("ZOS policy denied find.");
        }
        const query = params.pattern.replaceAll("*", "").trim() || params.pattern;
        const matches = await searchFiles(input.root, {
          path: params.path ?? ".",
          query,
          limit: params.limit ?? 100
        });
        return textResult(matches.map((entry) => entry.path).join("\n") || "No matches.", {
          resultLimitReached: matches.length >= (params.limit ?? 100) ? params.limit ?? 100 : undefined
        });
      }
    } as typeof find;
  const grepTool = {
      ...grep,
      execute: async (_toolCallId: string, params: Parameters<typeof grep.execute>[1]) => {
        if (input.toolPolicy.grep === "disabled") {
          return textResult("ZOS policy denied grep.");
        }
        const matches = await grepNasRoot(input.root, {
          pattern: params.pattern,
          path: params.path ?? ".",
          ignoreCase: Boolean(params.ignoreCase),
          literal: Boolean(params.literal),
          limit: params.limit ?? 100
        });
        return textResult(matches.join("\n") || "No matches.", {
          matchLimitReached: matches.length >= (params.limit ?? 100) ? params.limit ?? 100 : undefined
        });
      }
    } as typeof grep;
  const bashTool = {
      ...bash,
      executionMode: "sequential",
      execute: async (toolCallId: string, params: Parameters<typeof bash.execute>[1]) => {
        return withApproval(input, {
          toolCallId,
          toolName: "bash",
          args: { ...params },
          risk: commandRisk(params.command),
          summary: `Run shell command: ${params.command}`,
          execute: async () => {
            const cwd = await resolveSafeExistingPath(input.root.path, ".");
            const result = await runBash(params.command, cwd.realPath, params.timeout);
            return textResult(result.output, {
              fullOutputPath: undefined
            });
          }
        });
      }
    } as typeof bash;
  const editTool = {
      ...edit,
      executionMode: "sequential",
      execute: async (toolCallId: string, params: Parameters<typeof edit.execute>[1]) => {
        if (!params.edits.length) {
          return textResult("No edits were provided.");
        }
        const preview = await buildEditPreview(input.root, params.path, params.edits);
        return withApproval(input, {
          toolCallId,
          toolName: "edit",
          args: { ...params },
          risk: params.edits.length > 3 ? "high" : "medium",
          summary: `Edit ${preview.relativePath} (${params.edits.length} replacement${params.edits.length === 1 ? "" : "s"})`,
          execute: async () => {
            const freshPreview = await buildEditPreview(input.root, params.path, params.edits);
            await writeFile(freshPreview.absolutePath, freshPreview.content, "utf8");
            return textResult(`Edited ${freshPreview.relativePath}.`, {
              diff: `Edited ${freshPreview.relativePath}`,
              patch: ""
            });
          }
        });
      }
    } as typeof edit;
  const writeTool = {
      ...write,
      executionMode: "sequential",
      execute: async (toolCallId: string, params: Parameters<typeof write.execute>[1]) => {
        const target = await assertSafeWriteTarget(input.root, params.path);
        return withApproval(input, {
          toolCallId,
          toolName: "write",
          args: { ...params },
          risk: "high",
          summary: `Write ${target.relativePath} (${Buffer.byteLength(params.content, "utf8")} bytes)`,
          execute: async () => {
            const freshTarget = await assertSafeWriteTarget(input.root, params.path);
            await mkdir(path.dirname(freshTarget.absolutePath), { recursive: true });
            await writeFile(freshTarget.absolutePath, params.content, "utf8");
            return textResult(`Wrote ${freshTarget.relativePath}.`);
          }
        });
      }
    } as typeof write;

  const photostaffTools = input.photostaffTools ? createPhotostaffAgentTools(input.photostaffTools) : [];
  return [readTool, lsTool, findTool, grepTool, ...photostaffTools, bashTool, editTool, writeTool] as unknown as ToolDefinition[];
}

const photostaffScalarSchema = Type.Union([Type.String({ maxLength: 65_536 }), Type.Number(), Type.Boolean()]);
const photostaffRangeSchema = Type.Object({
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number())
});
const photostaffConditionSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 256 }),
  operator: Type.Union([
    Type.Literal("eq"), Type.Literal("contains"), Type.Literal("prefix"), Type.Literal("in"),
    Type.Literal("exists"), Type.Literal("not_exists"), Type.Literal("lt"), Type.Literal("lte"),
    Type.Literal("gt"), Type.Literal("gte"), Type.Literal("between")
  ]),
  value: Type.Optional(Type.Union([photostaffScalarSchema, Type.Array(photostaffScalarSchema, { maxItems: 100 })])),
  valueTo: Type.Optional(Type.Union([Type.String(), Type.Number()]))
});
const photostaffFiltersSchema = Type.Object({
  text: Type.Optional(Type.String({ maxLength: 512 })),
  capturedAt: Type.Optional(Type.Object({ from: Type.Optional(Type.String({ maxLength: 64 })), to: Type.Optional(Type.String({ maxLength: 64 })) })),
  mediaKinds: Type.Optional(Type.Array(Type.Union([Type.Literal("image"), Type.Literal("video"), Type.Literal("raw")]), { maxItems: 3 })),
  cameraModels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 100 })),
  lensModels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 100 })),
  iso: Type.Optional(photostaffRangeSchema),
  aperture: Type.Optional(photostaffRangeSchema),
  exposureTimeSeconds: Type.Optional(photostaffRangeSchema),
  focalLengthMm: Type.Optional(photostaffRangeSchema),
  rating: Type.Optional(photostaffRangeSchema),
  keywords: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 100 })),
  hasLocation: Type.Optional(Type.Boolean()),
  location: Type.Optional(Type.Union([
    Type.Object({
      kind: Type.Literal("bounds"),
      west: Type.Number({ minimum: -180, maximum: 180 }),
      south: Type.Number({ minimum: -90, maximum: 90 }),
      east: Type.Number({ minimum: -180, maximum: 180 }),
      north: Type.Number({ minimum: -90, maximum: 90 })
    }),
    Type.Object({
      kind: Type.Literal("near"),
      latitude: Type.Number({ minimum: -90, maximum: 90 }),
      longitude: Type.Number({ minimum: -180, maximum: 180 }),
      radiusMeters: Type.Number({ exclusiveMinimum: 0, maximum: 40_100_000 })
    })
  ])),
  advanced: Type.Optional(Type.Object({
    mode: Type.Union([Type.Literal("all"), Type.Literal("any")]),
    conditions: Type.Array(photostaffConditionSchema, { maxItems: 25 })
  }))
});

export function createPhotostaffAgentTools(service: PhotostaffAgentToolService): ToolDefinition[] {
  const searchPhotostaff = {
    name: "search_photostaff",
    label: "Search Photostaff",
    description: "Search the current ZOS photostaff library by text, camera, exposure, rating, keyword, date, location, or indexed metadata fields. Location filtering is local; results never include exact coordinates or other sensitive metadata.",
    parameters: Type.Object({
      filters: Type.Optional(photostaffFiltersSchema),
      sort: Type.Optional(Type.Object({
        field: Type.Union([
          Type.Literal("captured_at"), Type.Literal("indexed_at"), Type.Literal("name"),
          Type.Literal("size_bytes"), Type.Literal("rating"), Type.Literal("distance")
        ]),
        direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")])
      })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 }))
    }),
    execute: async (_toolCallId: string, params: PhotostaffQueryRequest) => {
      if (params.sort?.field === "distance" && params.filters?.location?.kind !== "near") {
        return textResult("Distance sorting requires a nearby location filter.");
      }
      const result = await service.searchPhotostaff({ ...params, limit: Math.min(params.limit ?? 25, 25), includeFacets: false });
      return textResult(JSON.stringify(redactPhotostaffSearchResult(result), null, 2));
    }
  };
  const getPhotostaffMetadata = {
    name: "get_photostaff_metadata",
    label: "Get photostaff metadata",
    description: "Get non-sensitive indexed metadata for one photostaff in the current ZOS photostaff library. Exact GPS, serial numbers, contact details, and person regions are always omitted.",
    parameters: Type.Object({ assetId: Type.String({ minLength: 1, maxLength: 256 }) }),
    execute: async (_toolCallId: string, params: { assetId: string }) => {
      const detail = await service.getPhotostaffMetadata(params.assetId);
      return textResult(detail ? JSON.stringify(redactPhotostaffMetadataDetail(detail), null, 2) : "Photostaff not found.");
    }
  };
  return [searchPhotostaff, getPhotostaffMetadata] as unknown as ToolDefinition[];
}

function redactPhotostaffSearchResult(result: PhotostaffQueryPage) {
  return {
    total: result.total,
    metadataIndex: result.metadataIndex,
    photostaff: result.photostaff.map((photostaff) => ({
      id: photostaff.id,
      path: photostaff.path,
      name: photostaff.name,
      mimeType: photostaff.mimeType,
      sizeBytes: photostaff.sizeBytes,
      width: photostaff.width,
      height: photostaff.height,
      takenAt: photostaff.takenAt,
      indexedAt: photostaff.indexedAt,
      keywords: photostaff.keywords,
      metadata: photostaff.metadata
    }))
  };
}

function redactPhotostaffMetadataDetail(detail: PhotostaffMetadataDetail): PhotostaffMetadataDetail {
  return {
    assetId: detail.assetId,
    summary: detail.summary,
    keywords: detail.keywords,
    groups: redactPhotostaffGroups(detail.groups),
    sensitiveOmitted: detail.sensitiveOmitted || Boolean(detail.sensitiveGroups),
    warnings: detail.warnings
  };
}

function redactPhotostaffGroups(
  groups: PhotostaffMetadataDetail["groups"]
): PhotostaffMetadataDetail["groups"] {
  const redacted: PhotostaffMetadataDetail["groups"] = {};
  const sensitiveKey = /(gps|latitude|longitude|serial|contact|email|phone|person|people|face|region)/iu;
  for (const [source, entries] of Object.entries(groups)) {
    if (source.toLocaleLowerCase("und") === "gps") continue;
    for (const [key, values] of Object.entries(entries)) {
      if (sensitiveKey.test(`${source}.${key}`)) continue;
      (redacted[source] ??= {})[key] = values;
    }
  }
  return redacted;
}

async function withApproval(
  input: PiAgentRuntimeInput,
  approval: {
    toolCallId: string;
    toolName: "bash" | "edit" | "write";
    args: Record<string, unknown>;
    risk: "low" | "medium" | "high";
    summary: string;
    execute: () => Promise<TextToolResult>;
  }
): Promise<TextToolResult> {
  if (input.toolPolicy[approval.toolName] === "disabled") {
    return textResult(`ZOS policy denied ${approval.toolName}.`);
  }

  const request = await input.createToolApproval({
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    args: redactToolArgs(approval.toolName, approval.args),
    cwd: input.root.path,
    risk: approval.risk,
    summary: approval.summary
  });
  await input.markWaitingForApproval?.();
  await input.emit({
    type: "approval.pending",
    payload: {
      approvalId: request.id,
      kind: "pi_tool_call",
      proposal: request.proposal,
      summary: approval.summary
    }
  });

  const status = await waitForApprovalDecision(input, request.id);
  if (status === "rejected") {
    return textResult(`The user rejected ${approval.toolName}: ${approval.summary}`);
  }
  if (status !== "approved") {
    return textResult(`ZOS stopped waiting for ${approval.toolName}: approval is ${status}.`);
  }

  return approval.execute();
}

async function waitForApprovalDecision(input: PiAgentRuntimeInput, approvalId: string): Promise<ApprovalStatus> {
  while (!input.isCancelled()) {
    const status = await input.getApprovalStatus(approvalId);
    if (status === null) {
      return "expired";
    }
    if (status !== "pending") {
      return status;
    }
    await sleep(APPROVAL_POLL_MS);
  }
  return "expired";
}

async function mapPiEvent(
  event: AgentSessionEvent,
  emit: PiAgentRuntimeInput["emit"],
  callbacks: {
    onStarted: () => void;
    onAssistantMessage: (content: string) => void;
  }
): Promise<void> {
  if (event.type === "agent_start") {
    callbacks.onStarted();
    await emit({
      type: "agent.started",
      payload: {
        provider: "pi",
        debug: compactPiEvent(event)
      }
    });
    return;
  }
  if (event.type === "tool_execution_start") {
    await emit({
      type: "tool_call.started",
      payload: {
        id: event.toolCallId,
        name: event.toolName,
        input: event.args,
        debug: compactPiEvent(event)
      }
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    await emit({
      type: event.isError ? "tool_call.failed" : "tool_call.completed",
      payload: {
        id: event.toolCallId,
        name: event.toolName,
        output: event.result,
        debug: compactPiEvent(event)
      }
    });
    return;
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    callbacks.onAssistantMessage(extractAssistantText(event.message));
  }
}

function extractAssistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((item) => {
      if (typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text") {
        return String((item as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("")
    .trim();
}

function textResult(text: string, details: unknown = undefined): TextToolResult {
  return {
    content: [{ type: "text", text: truncateText(text) }],
    details
  };
}

function sliceLines(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n");
  const start = offset ? Math.max(0, offset - 1) : 0;
  const end = limit ? start + Math.max(0, limit) : lines.length;
  return lines.slice(start, end).join("\n");
}

async function grepNasRoot(
  root: NasRootRecord,
  input: { pattern: string; path: string; ignoreCase: boolean; literal: boolean; limit: number }
): Promise<string[]> {
  const safe = await resolveSafeExistingPath(root.path, input.path);
  const matcher = createLineMatcher(input.pattern, input.ignoreCase, input.literal);
  const matches: string[] = [];

  async function visit(absolutePath: string): Promise<void> {
    if (matches.length >= input.limit) {
      return;
    }
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) {
      return;
    }
    if (entryStat.isDirectory()) {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        await visit(path.join(absolutePath, entry.name));
        if (matches.length >= input.limit) {
          return;
        }
      }
      return;
    }
    if (!entryStat.isFile()) {
      return;
    }

    const relativePath = toRootRelative(safe.rootRealPath, absolutePath);
    const preview = await readText(root, relativePath, 256 * 1024);
    const lines = preview.content.split("\n");
    lines.forEach((line, index) => {
      if (matches.length < input.limit && matcher(line)) {
        matches.push(`${relativePath}:${index + 1}:${line}`);
      }
    });
  }

  await visit(safe.realPath);
  return matches;
}

function createLineMatcher(pattern: string, ignoreCase: boolean, literal: boolean): (line: string) => boolean {
  if (literal) {
    const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
    return (line) => (ignoreCase ? line.toLocaleLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (line) => regex.test(line);
}

async function buildEditPreview(
  root: NasRootRecord,
  requestedPath: string,
  edits: Array<{ oldText: string; newText: string }>
): Promise<{ absolutePath: string; relativePath: string; content: string }> {
  const safe = await resolveSafeExistingPath(root.path, requestedPath);
  let content = await readFile(safe.realPath, "utf8");
  for (const edit of edits) {
    if (!edit.oldText) {
      throw new Error("edit oldText cannot be empty");
    }
    if (!content.includes(edit.oldText)) {
      throw new Error(`edit oldText was not found in ${safe.relativePath}`);
    }
    content = content.replace(edit.oldText, edit.newText);
  }
  return {
    absolutePath: safe.realPath,
    relativePath: safe.relativePath,
    content
  };
}

async function assertSafeWriteTarget(
  root: NasRootRecord,
  requestedPath: string
): Promise<{ absolutePath: string; relativePath: string }> {
  const target = await resolveSafeTargetPath(root.path, requestedPath);
  await assertClosestExistingParentInside(target.rootRealPath, target.absolutePath);
  try {
    const targetStat = await lstat(target.absolutePath);
    if (targetStat.isSymbolicLink()) {
      throw new Error("Refusing to write through a symlink");
    }
    const targetRealPath = await realpath(target.absolutePath);
    if (!isPathInside(target.rootRealPath, targetRealPath)) {
      throw new Error("Mutation target escapes the configured NAS root");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return {
    absolutePath: target.absolutePath,
    relativePath: target.relativePath
  };
}

async function assertClosestExistingParentInside(rootRealPath: string, absolutePath: string): Promise<void> {
  let current = path.dirname(absolutePath);
  while (current && current !== path.dirname(current)) {
    try {
      const currentRealPath = await realpath(current);
      if (!isPathInside(rootRealPath, currentRealPath)) {
        throw new Error("Mutation target parent escapes the configured NAS root");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      current = path.dirname(current);
    }
  }
  throw new Error("Mutation target parent does not exist inside the NAS root");
}

async function runBash(command: string, cwd: string, timeout?: number): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timeoutMs = timeout && timeout > 0 ? timeout : 120_000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      output = truncateText(output);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      output = truncateText(output);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        output: `exitCode=${exitCode ?? "killed"}\n${output}`
      });
    });
  });
}

function commandRisk(command: string): "low" | "medium" | "high" {
  return /\b(rm|mv|cp|chmod|chown|sudo|curl|wget|ssh|scp|dd|mkfs|mount|umount)\b/.test(command)
    ? "high"
    : "medium";
}

function redactToolArgs(toolName: PiToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== "write" || typeof args.content !== "string") {
    return args;
  }
  return {
    ...args,
    content: `[${Buffer.byteLength(args.content, "utf8")} bytes]`
  };
}

function settingsSnapshot(settings: ModelProviderSettingsRecord): Record<string, unknown> {
  return {
    providerName: settings.providerName,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKeyConfigured: Boolean(settings.apiKey),
    updatedAt: settings.updatedAt
  };
}

function compactPiEvent(event: AgentSessionEvent): Record<string, unknown> {
  return {
    type: event.type
  };
}

function truncateText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_TOOL_OUTPUT_BYTES) {
    return text;
  }
  return `${text.slice(0, MAX_TOOL_OUTPUT_BYTES)}\n\n[Output truncated]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
