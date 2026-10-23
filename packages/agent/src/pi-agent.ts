import { mkdir, lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createCodemodeExtension,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsToolDefinition,
  createMcpExtension,
  createReadToolDefinition,
  createToolSearchExtension,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type LoadedMcpConfig,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  isPathInside,
  listDir,
  readText,
  resolveSafeExistingPath,
  resolveSafeTargetPath,
  toRootRelative
} from "@zos/nas-tools";
import type {
  AgentProviderSessionRecord,
  AgentSessionRecord,
  ModelProviderSettingsRecord,
  ModelProviderName,
  NasRootRecord,
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
  status: "completed" | "failed" | "cancelled" | "waiting_approval";
  summary?: string;
  error?: string;
  runId?: string;
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
  requestCapability: (request: PiAgentCapabilityRequest) => Promise<PiAgentCapabilityExecution>;
  onCapabilityRunPending?: (runId: string, providerSessionId: string) => void | Promise<void>;
  photostaffTools?: PhotostaffAgentToolService;
  mcp?: PiMcpRuntimeSettings;
  runner?: PiAgentRunner;
}

export interface PiMcpRuntimeSettings {
  enabled: boolean;
  url: string;
  tokenFile: string;
  legacyToolsEnabled: boolean;
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
  requestCapability: PiAgentInput["requestCapability"];
  onCapabilityRunPending?: PiAgentInput["onCapabilityRunPending"];
  photostaffTools?: PhotostaffAgentToolService;
  mcp?: PiMcpRuntimeSettings;
}

export interface PiAgentCapabilityRequest {
  toolCallId: string;
  toolName: PiToolName;
  args: Record<string, unknown>;
  redactedArgs: Record<string, unknown>;
  previewArgs: Record<string, unknown>;
  risk: "low" | "medium" | "high" | "critical";
  summary: string;
  requiresConfirmation: boolean;
}

export interface PiAgentCapabilityExecution {
  data: unknown;
  runId?: string;
}

type TextToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

const LEGACY_PI_TOOL_NAMES: PiToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const PHOTOSTAFF_TOOL_NAMES = ["search_photostaff", "get_photostaff_metadata"] as const;
const DIRECT_MCP_TOOLS = [
  "zos.catalog.get",
  "zos.system.status",
  "zos.roots.list",
  "zos.files.list",
  "zos.files.stat",
  "zos.files.read",
  "zos.files.search",
  "zos.files.mutate",
  "zos.runs.get"
] as const;
const MCP_RESOURCE_TOOL_NAMES = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource"
] as const;
const ZOS_MCP_SERVER_NAME = "zos";
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const PI_CANCELLATION_POLL_MS = 100;
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
  let assistantFailure: string | null = null;
  let started = false;
  const pendingRunIds = new Set<string>();
  let abortRequested = false;
  let eventError: unknown = null;
  let eventChain = Promise.resolve();

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
    const mcpConfig = input.mcp?.enabled ? await loadControlledPiMcpConfig(input.mcp) : null;
    const legacyToolsEnabled = !input.mcp?.enabled || input.mcp.legacyToolsEnabled;
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.root.path,
      agentDir: piAgentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: mcpConfig ? [
        createCodemodeExtension({ mode: "on", models: false }),
        createToolSearchExtension(),
        createMcpExtension({
          loadConfig: () => mcpConfig,
          updateConfig: () => undefined,
          logPath: path.join(piAgentDir, "mcp.log"),
          startupWaitMs: 10_000
        })
      ] : [],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      appendSystemPrompt: [
        [
          "You are running inside ZOS.",
          "Use the ZOS MCP server for NAS and system capabilities. Paths are always relative to a selected NAS root.",
          "Mutating capabilities return durable runs and require approval in the first-party ZOS UI.",
          "Never request or include passwords, API keys, Wi-Fi secrets, registry tokens, or host absolute paths."
        ].join("\n")
      ]
    });
    await resourceLoader.reload();

    const { session: piSession } = await createAgentSession({
      cwd: input.root.path,
      agentDir: piAgentDir,
      modelRuntime,
      ...(model ? { model } : {}),
      tools: piAgentToolNames({
        mcpEnabled: mcpConfig !== null,
        legacyToolsEnabled,
        photostaffToolsEnabled: input.photostaffTools !== undefined
      }),
      customTools: legacyToolsEnabled ? createZosPiTools(input) : [],
      resourceLoader,
      settingsManager,
      sessionManager
    });

    const providerSession = {
      providerSessionId: piSession.sessionId,
      sessionFile: piSession.sessionFile ?? null,
      providerName: input.modelSettings.providerName,
      model: input.modelSettings.model,
      settingsSnapshot: settingsSnapshot(input.modelSettings)
    };
    await input.saveProviderSession(providerSession);

    const requestAbort = async () => {
      if (abortRequested) return;
      abortRequested = true;
      await piSession.abort();
    };

    const unsubscribe = piSession.subscribe((event) => {
      eventChain = eventChain
        .then(() => mapPiEvent(event, input.emit, {
          onStarted: () => {
            started = true;
          },
          onAssistantMessage: (content) => {
            latestAssistantText = content;
            assistantFailure = null;
          },
          onAssistantFailure: (error) => {
            latestAssistantText = "";
            assistantFailure = error;
          },
          onCapabilityRunPending: async (runId) => {
            if (pendingRunIds.has(runId)) return;
            await input.onCapabilityRunPending?.(runId, piSession.sessionId);
            pendingRunIds.add(runId);
            await requestAbort();
            await input.emit({
              type: "approval.pending",
              payload: { kind: "capability_run", runId }
            });
          }
        }))
        .catch((error: unknown) => {
          eventError ??= error;
        });
    });
    const stopCancellationMonitor = startPiCancellationMonitor({
      isCancelled: input.isCancelled,
      abort: requestAbort,
      onError: (error) => {
        eventError ??= error;
      }
    });

    try {
      await piSession.bindExtensions({});
      if (input.isCancelled()) await requestAbort();
      else await piSession.prompt(input.message);
      await piSession.waitForIdle();
      await eventChain;
      if (eventError) throw eventError;
    } finally {
      stopCancellationMonitor();
      unsubscribe();
      await eventChain;
      piSession.dispose();
    }

    if (input.isCancelled()) {
      return { status: "cancelled" };
    }
    const pendingRunId = pendingRunIds.values().next().value as string | undefined;
    if (pendingRunId) {
      return { status: "waiting_approval", runId: pendingRunId };
    }
    const turnFailure = getPiTurnFailure(assistantFailure, latestAssistantText);
    if (turnFailure) throw new Error(turnFailure);
    await input.saveProviderSession(providerSession);
    await input.emit({
      type: "agent.message",
      payload: {
        role: "assistant",
        content: latestAssistantText
      }
    });
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
    const pendingRunId = pendingRunIds.values().next().value as string | undefined;
    if (pendingRunId) {
      return { status: "waiting_approval", runId: pendingRunId };
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

export function startPiCancellationMonitor(input: {
  isCancelled: () => boolean;
  abort: () => Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let abortStarted = false;
  const poll = () => {
    if (stopped || abortStarted) return;
    try {
      if (!input.isCancelled()) return;
      abortStarted = true;
      void input.abort().catch((error: unknown) => input.onError?.(error));
    } catch (error) {
      abortStarted = true;
      input.onError?.(error);
    }
  };
  const timer = setInterval(poll, input.intervalMs ?? PI_CANCELLATION_POLL_MS);
  timer.unref();
  poll();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function piAgentToolNames(options: {
  mcpEnabled: boolean;
  legacyToolsEnabled: boolean;
  photostaffToolsEnabled: boolean;
}): string[] {
  return [
    // Pi requires an MCP allowlist match before direct tools can be declared to the model.
    ...(options.mcpEnabled
      ? [
          "codemode",
          "tool_search",
          `mcp__${ZOS_MCP_SERVER_NAME}__*`,
          ...MCP_RESOURCE_TOOL_NAMES
        ]
      : []),
    ...(options.legacyToolsEnabled ? LEGACY_PI_TOOL_NAMES : []),
    ...(options.legacyToolsEnabled && options.photostaffToolsEnabled ? PHOTOSTAFF_TOOL_NAMES : [])
  ];
}

export async function loadControlledPiMcpConfig(settings: PiMcpRuntimeSettings): Promise<LoadedMcpConfig> {
  const tokenStat = await stat(settings.tokenFile);
  if (!tokenStat.isFile()) {
    throw new Error("ZOS Pi MCP token path is not a regular file");
  }
  if ((tokenStat.mode & 0o077) !== 0) {
    throw new Error("ZOS Pi MCP token file permissions must be 0600");
  }
  const token = (await readFile(settings.tokenFile, "utf8")).trim();
  if (!/^zos_mcp_[A-Za-z0-9_-]{40,}$/u.test(token)) {
    throw new Error("ZOS Pi MCP token file is invalid");
  }
  return {
    servers: [{
      name: ZOS_MCP_SERVER_NAME,
      source: "zos:internal",
      scope: "global",
      config: {
        type: "http",
        url: settings.url,
        headers: { Authorization: `Bearer ${token}` },
        exposure: "codemode",
        description: "ZOS NAS capabilities, durable runs, resources, and approval-gated proposals.",
        toolExposure: Object.fromEntries(DIRECT_MCP_TOOLS.map((name) => [name, "direct" as const]))
      }
    }],
    autoEnableCodemode: true,
    errors: []
  };
}

export function createZosPiTools(input: PiAgentRuntimeInput): ToolDefinition[] {
  const read = createReadToolDefinition(input.root.path);
  const localBash = createLocalBashOperations({ shellPath: "/bin/bash" });
  const bash = createBashToolDefinition(input.root.path, {
    exposeSessionEnvironment: false,
    operations: {
      exec: (command, cwd, options) => localBash.exec(command, cwd, {
        ...options,
        env: safeShellEnvironment(cwd)
      })
    }
  });
  const edit = createEditToolDefinition(input.root.path);
  const write = createWriteToolDefinition(input.root.path);
  const grep = createGrepToolDefinition(input.root.path);
  const find = createFindToolDefinition(input.root.path);
  const ls = createLsToolDefinition(input.root.path);

  const readTool = {
      ...read,
      execute: async (toolCallId: string, params: Parameters<typeof read.execute>[1]) =>
        withReadToolPolicy(input, {
          toolCallId,
          toolName: "read",
          args: { ...params },
          summary: `Read ${params.path}`,
          execute: async () => {
            const preview = await readText(input.root, params.path, MAX_TOOL_OUTPUT_BYTES);
            const content = sliceLines(preview.content, params.offset, params.limit);
            return textResult(content + (preview.truncated ? "\n\n[Output truncated]" : ""), {
              truncation: preview.truncated ? { truncated: true } : undefined
            });
          }
        })
    } as typeof read;
  const lsTool = {
      ...ls,
      execute: async (toolCallId: string, params: Parameters<typeof ls.execute>[1]) =>
        withReadToolPolicy(input, {
          toolCallId,
          toolName: "ls",
          args: { ...params },
          summary: `List ${params.path ?? "."}`,
          execute: async () => {
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
        })
    } as typeof ls;
  const findTool = {
      ...find,
      execute: async (toolCallId: string, params: Parameters<typeof find.execute>[1]) =>
        withReadToolPolicy(input, {
          toolCallId,
          toolName: "find",
          args: { ...params },
          summary: `Find ${params.pattern} in ${params.path ?? "."}`,
          execute: async () => {
            const limit = Math.max(1, Math.min(params.limit ?? 100, 1_000));
            const matches = await globNasRoot(input.root, params.path ?? ".", params.pattern, limit);
            return textResult(matches.join("\n") || "No matches.", {
              resultLimitReached: matches.length >= limit ? limit : undefined
            });
          }
        })
    } as typeof find;
  const grepTool = {
      ...grep,
      execute: async (toolCallId: string, params: Parameters<typeof grep.execute>[1]) =>
        withReadToolPolicy(input, {
          toolCallId,
          toolName: "grep",
          args: { ...params },
          summary: `Search text in ${params.path ?? "."}`,
          execute: async () => {
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
        })
    } as typeof grep;
  const bashTool = {
      ...bash,
      executionMode: "sequential",
      execute: async (...executeArgs: Parameters<typeof bash.execute>) => {
        const [toolCallId, params] = executeArgs;
        return withApproval(input, {
          toolCallId,
          toolName: "bash",
          args: { ...params },
          risk: "critical",
          summary: `Run an approved shell command (${Buffer.byteLength(params.command, "utf8")} bytes)`,
          execute: async () => bash.execute(...executeArgs) as Promise<TextToolResult>
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
    toolName: PiToolName;
    args: Record<string, unknown>;
    risk: "low" | "medium" | "high" | "critical";
    summary: string;
    execute: () => Promise<TextToolResult>;
  }
): Promise<TextToolResult> {
  const policy = input.toolPolicy[approval.toolName];
  if (policy === "disabled") {
    return textResult(`ZOS policy denied ${approval.toolName}.`);
  }
  if (policy === "auto") return approval.execute();

  const execution = await input.requestCapability({
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    args: approval.args,
    redactedArgs: redactPiToolArgs(approval.toolName, approval.args),
    previewArgs: previewPiToolArgs(approval.toolName, approval.args),
    risk: approval.risk,
    summary: approval.summary,
    requiresConfirmation: policy === "confirm"
  });
  return textResult(`Waiting for approval: ${approval.summary}`, execution);
}

async function withReadToolPolicy(
  input: PiAgentRuntimeInput,
  operation: {
    toolCallId: string;
    toolName: Extract<PiToolName, "read" | "grep" | "find" | "ls">;
    args: Record<string, unknown>;
    summary: string;
    execute: () => Promise<TextToolResult>;
  }
): Promise<TextToolResult> {
  const policy = input.toolPolicy[operation.toolName];
  if (policy === "disabled") return textResult(`ZOS policy denied ${operation.toolName}.`);
  return withApproval(input, { ...operation, risk: "low" });
}

async function mapPiEvent(
  event: AgentSessionEvent,
  emit: PiAgentRuntimeInput["emit"],
  callbacks: {
    onStarted: () => void;
    onAssistantMessage: (content: string) => void;
    onAssistantFailure: (error: string) => void;
    onCapabilityRunPending: (runId: string) => void | Promise<void>;
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
        input: redactPiToolArgs(event.toolName, event.args),
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
        output: redactSensitiveValue(event.result),
        debug: compactPiEvent(event)
      }
    });
    const pendingRunId = capabilityPendingRunId(event.result);
    if (pendingRunId) await callbacks.onCapabilityRunPending(pendingRunId);
    return;
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    mapPiAssistantMessageEnd(event.message, callbacks);
  }
}

export function mapPiAssistantMessageEnd(
  message: Extract<
    Extract<AgentSessionEvent, { type: "message_end" }>["message"],
    { role: "assistant" }
  >,
  callbacks: {
    onAssistantMessage: (content: string) => void;
    onAssistantFailure: (error: string) => void;
  }
): void {
  const failure = getPiAssistantFailure(message);
  if (failure) {
    callbacks.onAssistantFailure(failure);
  } else {
    callbacks.onAssistantMessage(extractAssistantText(message));
  }
}

function getPiAssistantFailure(message: {
  stopReason?: unknown;
  errorMessage?: unknown;
}): string | null {
  if (message.stopReason !== "error") return null;
  if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
    return message.errorMessage.trim();
  }
  return "Agent provider stopped with error";
}

export function getPiTurnFailure(assistantFailure: string | null, assistantText: string): string | null {
  if (assistantFailure) return assistantFailure;
  return assistantText.trim() ? null : "Agent provider returned an empty response";
}

export function capabilityPendingRunId(result: unknown): string | null {
  const candidates: unknown[] = [result];
  for (let depth = 0; depth < 8 && candidates.length; depth += 1) {
    const candidate = candidates.shift();
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const data = record.data;
    if (
      typeof record.runId === "string"
      && data !== null
      && typeof data === "object"
      && (data as Record<string, unknown>).state === "waiting_approval"
    ) {
      return record.runId;
    }
    candidates.push(record.structuredContent, record.details);
  }
  return null;
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

async function globNasRoot(
  root: NasRootRecord,
  requestedPath: string,
  pattern: string,
  limit: number
): Promise<string[]> {
  if (!pattern.trim() || pattern.includes("\0")) {
    throw new Error("find pattern must be a non-empty glob");
  }
  const safe = await resolveSafeExistingPath(root.path, requestedPath);
  const matches: string[] = [];
  const matchesPath = (relativePath: string) => {
    const normalized = relativePath.split(path.sep).join("/");
    return path.matchesGlob(normalized, pattern)
      || (!pattern.includes("/") && path.matchesGlob(path.posix.basename(normalized), pattern));
  };

  async function visit(absolutePath: string): Promise<void> {
    if (matches.length >= limit) return;
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) return;
    const relativePath = path.relative(safe.realPath, absolutePath);
    if (relativePath && matchesPath(relativePath)) {
      matches.push(relativePath.split(path.sep).join("/"));
    }
    if (!entryStat.isDirectory()) return;
    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      await visit(path.join(absolutePath, entry.name));
      if (matches.length >= limit) return;
    }
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

function safeShellEnvironment(cwd: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: cwd,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: "/tmp"
  };
  for (const name of ["LANG", "LC_ALL", "TZ"] as const) {
    const value = process.env[name];
    if (value && /^[A-Za-z0-9_+./:@-]{1,128}$/u.test(value)) environment[name] = value;
  }
  return environment;
}

export function redactPiToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSensitiveValue(args) as Record<string, unknown>;
  if (toolName === "bash" && typeof args.command === "string") {
    return {
      ...redacted,
      command: `[${Buffer.byteLength(args.command, "utf8")} byte command redacted]`
    };
  }
  if (toolName === "write" && typeof args.content === "string") {
    return {
      ...redacted,
      content: `[${Buffer.byteLength(args.content, "utf8")} bytes]`
    };
  }
  if (toolName === "edit" && Array.isArray(args.edits)) {
    return {
      ...redacted,
      edits: `[${args.edits.length} edit${args.edits.length === 1 ? "" : "s"} redacted]`
    };
  }
  return redacted;
}

const MAX_APPROVAL_PREVIEW_BYTES = 32 * 1024;
const MAX_APPROVAL_SNIPPET_BYTES = 8 * 1024;

export function previewPiToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSensitiveValue(args) as Record<string, unknown>;
  let preview: Record<string, unknown> = redacted;
  if (toolName === "bash" && typeof args.command === "string") {
    preview = {
      ...redacted,
      command: truncateApprovalPreview(redactShellPreviewText(args.command), MAX_APPROVAL_PREVIEW_BYTES)
    };
  } else if (toolName === "write" && typeof args.content === "string") {
    preview = {
      ...redacted,
      content: truncateApprovalPreview(redactPreviewText(args.content), MAX_APPROVAL_PREVIEW_BYTES),
      contentBytes: Buffer.byteLength(args.content, "utf8")
    };
  } else if (toolName === "edit" && Array.isArray(args.edits)) {
    preview = {
      ...redacted,
      edits: args.edits.slice(0, 20).map((edit) => {
        if (!edit || typeof edit !== "object") return "[invalid edit]";
        const record = edit as Record<string, unknown>;
        return {
          oldText: typeof record.oldText === "string"
            ? truncateApprovalPreview(redactPreviewText(record.oldText), MAX_APPROVAL_SNIPPET_BYTES)
            : record.oldText,
          newText: typeof record.newText === "string"
            ? truncateApprovalPreview(redactPreviewText(record.newText), MAX_APPROVAL_SNIPPET_BYTES)
            : record.newText
        };
      }),
      editCount: args.edits.length
    };
  }
  return boundApprovalPreview(preview);
}

function redactPreviewText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s'"\\]+/giu, "$1[redacted]")
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_KEY|PRIVATE_KEY|PSK))=(?:'[^']*'|"[^"]*"|[^\s]+)/giu, "$1=[redacted]")
    .replace(/(--(?:password|passphrase|secret|token|api[-_]?key|private[-_]?key|psk)(?:=|\s+))(?:'[^']*'|"[^"]*"|[^\s]+)/giu, "$1[redacted]")
    .replace(/(["']?(?:password|passphrase|secret|token|api[_-]?key|private[_-]?key|psk)["']?\s*[:=]\s*)(?:'[^']*'|"[^"]*"|[^\s,}\]]+)/giu, "$1[redacted]")
    .replace(/https?:\/\/[^\s'"<>]+/giu, (url) => redactAuditUrl(url));
}

function redactShellPreviewText(value: string): string {
  const redacted = value
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s'"\\;|&()<>]+/giu, "$1[redacted]")
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_KEY|PRIVATE_KEY|PSK))=(?:'[^']*'|"[^"]*"|[^\s;|&()<>]+)/giu, "$1=[redacted]")
    .replace(/(--(?:password|passphrase|secret|token|api[-_]?key|private[-_]?key|psk)(?:=|\s+))(?:'[^']*'|"[^"]*"|[^\s;|&()<>]+)/giu, "$1[redacted]")
    .replace(/(["']?(?:password|passphrase|secret|token|api[_-]?key|private[_-]?key|psk)["']?\s*[:=]\s*)(?:'[^']*'|"[^"]*"|[^\s,}\];|&()<>]+)/giu, "$1[redacted]");
  return redactShellPreviewUrls(redacted);
}

function redactShellPreviewUrls(value: string): string {
  return value
    .replace(/"(https?:\/\/[^"\s<>]+)"/giu, (_match, url: string) => `"${redactAuditUrl(url)}"`)
    .replace(/'(https?:\/\/[^'\s<>]+)'/giu, (_match, url: string) => `'${redactAuditUrl(url)}'`)
    .replace(/https?:\/\/[^\s'"<>;|&()]+/giu, (url) => redactAuditUrl(url));
}

function boundApprovalPreview(value: Record<string, unknown>): Record<string, unknown> {
  const formatted = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(formatted, "utf8") <= MAX_APPROVAL_PREVIEW_BYTES) return value;
  return {
    preview: truncateApprovalPreview(formatted, MAX_APPROVAL_PREVIEW_BYTES),
    truncated: true
  };
}

function truncateApprovalPreview(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n[preview truncated]";
  const bytes = Buffer.from(value, "utf8");
  return `${bytes.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix))).toString("utf8")}${suffix}`;
}

function redactSensitiveValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 12) return "[nested value redacted]";
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, seen, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular value redacted]";
  seen.add(value);
  const entries = Object.entries(value).map(([key, item]) => {
    if (isSecretField(key)) return [key, "[redacted]"];
    if (isUrlField(key) && typeof item === "string") return [key, redactAuditUrl(item)];
    return [key, redactSensitiveValue(item, seen, depth + 1)];
  });
  return Object.fromEntries(entries);
}

function isSecretField(key: string): boolean {
  const normalized = key.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  return /(^|[_-])(password|passphrase|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|psk)($|[_-])/u.test(normalized);
}

function isUrlField(key: string): boolean {
  const normalized = key.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  return normalized === "url" || normalized.endsWith("_url");
}

function redactAuditUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[configured URL]";
  }
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
