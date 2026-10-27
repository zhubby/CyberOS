import { randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createMcpExtension,
  createReadToolDefinition,
  createToolSearchExtension,
  createWriteToolDefinition,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type LoadedMcpConfig,
  type SessionEntry,
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
  AgentSessionCommandType,
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
import {
  ModelRuntimeManager,
  type ModelRuntimeBinding
} from "./model-runtime-manager.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import { PiResourcePolicy } from "./pi-resource-policy.js";

export { registerConfiguredProvider } from "./model-runtime-manager.js";

export interface PiAgentEmitEvent {
  type: import("@zos/shared").AgentEventType;
  payload: Record<string, unknown>;
  source?: "pi" | "zos";
  sourceId?: string;
  runId?: string;
  sequence?: number;
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
  workingPath: string;
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
    runtimeGeneration?: number;
    runtimeProvider?: ModelProviderName;
    runtimeModel?: string;
    projectionCursor?: string | null;
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
  workingPath: string;
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

const LEGACY_PI_TOOL_NAMES: PiToolName[] = ["read", "edit", "write", "grep", "find", "ls"];
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
const PI_PROJECTION_ROOT = "__root__";
export async function runPiAgentTurn(input: PiAgentInput): Promise<PiAgentTurnResult> {
  const runtimeInput: PiAgentRuntimeInput = {
    ...input,
    isCancelled: input.isCancelled ?? (() => false)
  };
  return (input.runner ?? runPiSdkAgentTurn)(runtimeInput);
}

export interface PiAgentCommand {
  type: Exclude<AgentSessionCommandType, "prompt">;
  payload: Record<string, unknown>;
}

type PiActiveAgentCommand = PiAgentCommand & {
  type: "steer" | "follow_up" | "abort";
};

export class PiActiveTurnUnavailableError extends Error {
  constructor(commandType: "steer" | "follow_up") {
    super(`${commandType} is waiting for the active Pi turn to start`);
    this.name = "PiActiveTurnUnavailableError";
  }
}

export async function runPiAgentCommand(
  input: Omit<PiAgentInput, "message" | "runner">,
  command: PiAgentCommand
): Promise<unknown> {
  const runtimeInput: PiAgentRuntimeInput = {
    ...input,
    message: "",
    isCancelled: input.isCancelled ?? (() => false)
  };
  let host = piAgentHosts.get(input.dataDir);
  if (!host) {
    host = new PiAgentSessionHost(input.dataDir);
    piAgentHosts.set(input.dataDir, host);
  }
  return host.command(runtimeInput, command);
}

export async function disposePiAgentHosts(): Promise<void> {
  const hosts = [...piAgentHosts.values()];
  piAgentHosts.clear();
  await Promise.all(hosts.map((host) => host.dispose()));
}

const piAgentHosts = new Map<string, PiAgentSessionHost>();

async function runPiSdkAgentTurn(input: PiAgentRuntimeInput): Promise<PiAgentTurnResult> {
  let host = piAgentHosts.get(input.dataDir);
  if (!host) {
    host = new PiAgentSessionHost(input.dataDir);
    piAgentHosts.set(input.dataDir, host);
  }
  return host.run(input);
}

interface HostedTurn {
  input: PiAgentRuntimeInput;
  runId: string;
  latestAssistantText: string;
  assistantFailure: string | null;
  started: boolean;
  pendingRunIds: Set<string>;
  abortRequested: boolean;
  eventError: unknown;
  eventChain: Promise<void>;
  sequence: number;
}

interface HostedPiSession {
  piSession: AgentSession;
  bridge: PiAgentRuntimeInput;
  runtime: ModelRuntimeBinding;
  projectionCursor: string;
  activeTurn: HostedTurn | null;
  unsubscribe: () => void;
}

export class PiAgentSessionHost {
  private readonly sessions = new AgentSessionManager<HostedPiSession>();
  private readonly loaded = new Map<string, HostedPiSession>();
  private readonly runtimes: ModelRuntimeManager;
  private readonly piSessionDir: string;
  private readonly piAgentDir: string;
  private readonly resourcePolicy = new PiResourcePolicy();

  constructor(private readonly dataDir: string) {
    this.piSessionDir = path.join(dataDir, "pi-sessions");
    this.piAgentDir = path.join(dataDir, "pi-agent");
    this.runtimes = new ModelRuntimeManager(this.piAgentDir);
  }

  async run(input: PiAgentRuntimeInput): Promise<PiAgentTurnResult> {
    if (input.isCancelled()) return { status: "cancelled" };
    const workspace = await resolveSafeExistingPath(input.root.path, input.workingPath);
    const workspaceStat = await stat(workspace.realPath);
    if (!workspaceStat.isDirectory()) throw new Error("Agent working path must be a directory");
    await mkdir(this.piSessionDir, { recursive: true });
    await mkdir(this.piAgentDir, { recursive: true });

    const runtime = await this.runtimes.get(input.modelSettings, input.providerSession);
    const fingerprint = JSON.stringify({
      workingPath: workspace.relativePath,
      runtimeGeneration: runtime.generation,
      mcp: input.mcp ?? null,
      photostaff: Boolean(input.photostaffTools),
      resourcesTrusted: input.session.piResourcesTrusted === true
    });
    return this.sessions.run({
      sessionId: input.session.id,
      fingerprint,
      create: () => this.createSession(input, workspace, runtime, fingerprint),
      execute: (hosted) => this.runTurn(hosted, input)
    });
  }

  async command(input: PiAgentRuntimeInput, command: PiAgentCommand): Promise<unknown> {
    if (isActiveAgentCommand(command)) {
      return this.runActiveCommand(input.session.id, command);
    }

    const commandInput = command.type === "set_model"
      ? this.bindInputToCurrentRuntime(input, command.payload)
      : input;
    const workspace = await resolveSafeExistingPath(commandInput.root.path, commandInput.workingPath);
    const workspaceStat = await stat(workspace.realPath);
    if (!workspaceStat.isDirectory()) throw new Error("Agent working path must be a directory");
    await mkdir(this.piSessionDir, { recursive: true });
    await mkdir(this.piAgentDir, { recursive: true });
    const runtime = await this.runtimes.get(commandInput.modelSettings, commandInput.providerSession);
    const fingerprint = JSON.stringify({
      workingPath: workspace.relativePath,
      runtimeGeneration: runtime.generation,
      mcp: commandInput.mcp ?? null,
      photostaff: Boolean(commandInput.photostaffTools),
      resourcesTrusted: commandInput.session.piResourcesTrusted === true
    });
    return this.sessions.run({
      sessionId: commandInput.session.id,
      fingerprint,
      create: () => this.createSession(commandInput, workspace, runtime, fingerprint),
      execute: (hosted) => this.runIdleCommand(hosted, commandInput, command)
    });
  }

  dispose(): Promise<void> {
    return this.sessions.disposeAll();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  private async createSession(
    input: PiAgentRuntimeInput,
    workspace: Awaited<ReturnType<typeof resolveSafeExistingPath>>,
    runtime: ModelRuntimeBinding,
    fingerprint: string
  ) {
    const sessionManager = input.providerSession?.sessionFile
      ? SessionManager.open(input.providerSession.sessionFile, this.piSessionDir, workspace.realPath)
      : SessionManager.create(workspace.realPath, this.piSessionDir, { id: input.session.id });
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: runtime.settings.providerName,
      ...(runtime.settings.model ? { defaultModel: runtime.settings.model } : {}),
      defaultProjectTrust: "never"
    });
    const mcpConfig = input.mcp?.enabled ? await loadControlledPiMcpConfig(input.mcp) : null;
    const legacyToolsEnabled = !input.mcp?.enabled || input.mcp.legacyToolsEnabled;
    const resourcePolicy = this.resourcePolicy.evaluate(input.session);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.realPath,
      agentDir: this.piAgentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: mcpConfig ? [
        createCodemodeExtension({ mode: "on", models: false }),
        createToolSearchExtension(),
        createMcpExtension({
          loadConfig: () => mcpConfig,
          updateConfig: () => undefined,
          logPath: path.join(this.piAgentDir, "mcp.log"),
          startupWaitMs: 10_000
        })
      ] : [],
      noSkills: !resourcePolicy.allowProjectSkills,
      noPromptTemplates: !resourcePolicy.allowProjectPrompts,
      noThemes: true,
      noContextFiles: !resourcePolicy.allowProjectContext,
      appendSystemPrompt: [zosSystemPrompt(workspace.relativePath)]
    });
    try {
      await resourceLoader.reload({
        resolveProjectTrust: async () => input.session.piResourcesTrusted === true
      });
    } catch {
      await input.emit({
        type: "resource_error",
        source: "pi",
        sourceId: `resource:${input.session.id}:${runtime.generation}:reload`,
        runId: `resource:${input.session.id}`,
        sequence: 1,
        payload: { resourceType: "loader", error: "Pi resources could not be loaded" }
      });
      throw new Error("Pi resources could not be loaded");
    }
    await emitResourceDiagnostics(input, resourceLoader, runtime.generation);

    const bridge = { ...input };
    const { session: piSession } = await createAgentSession({
      cwd: workspace.realPath,
      agentDir: this.piAgentDir,
      modelRuntime: runtime.runtime,
      ...(runtime.model ? { model: runtime.model } : {}),
      tools: piAgentToolNames({
        mcpEnabled: mcpConfig !== null,
        legacyToolsEnabled,
        photostaffToolsEnabled: input.photostaffTools !== undefined
      }),
      customTools: legacyToolsEnabled ? createZosPiTools(bridge) : [],
      resourceLoader,
      settingsManager,
      sessionManager
    });
    const savedProjectionCursor = input.providerSession?.projectionCursor;
    const projectionCursor = savedProjectionCursor
      ?? (input.providerSession ? piSession.sessionManager.getLeafId() ?? PI_PROJECTION_ROOT : PI_PROJECTION_ROOT);
    const hosted: HostedPiSession = {
      piSession,
      bridge,
      runtime,
      projectionCursor,
      activeTurn: null,
      unsubscribe: () => undefined
    };
    if (savedProjectionCursor || !input.providerSession) {
      await this.reconcileProjection(hosted, input);
    }
    this.loaded.set(input.session.id, hosted);
    hosted.unsubscribe = piSession.subscribe((event) => this.handleEvent(hosted, event));
    await piSession.bindExtensions({});
    await input.saveProviderSession(providerSessionSnapshot(hosted));
    return {
      sessionId: input.session.id,
      fingerprint,
      session: hosted,
      dispose: async () => {
        if (this.loaded.get(input.session.id) === hosted) this.loaded.delete(input.session.id);
        hosted.unsubscribe();
        if (!hosted.piSession.isIdle) await hosted.piSession.abort();
        hosted.piSession.dispose();
      }
    };
  }

  private async reconcileProjection(hosted: HostedPiSession, input: PiAgentRuntimeInput): Promise<void> {
    const branch = hosted.piSession.sessionManager.getBranch();
    const cursorIndex = hosted.projectionCursor === PI_PROJECTION_ROOT
      ? -1
      : branch.findIndex((entry) => entry.id === hosted.projectionCursor);
    if (cursorIndex < -1 || (cursorIndex === -1 && hosted.projectionCursor !== PI_PROJECTION_ROOT)) {
      hosted.projectionCursor = hosted.piSession.sessionManager.getLeafId() ?? PI_PROJECTION_ROOT;
      await input.emit({
        type: "resource_error",
        source: "pi",
        sourceId: `projection:${input.session.id}:cursor-missing`,
        runId: `projection:${input.session.id}`,
        payload: {
          resourceType: "session_projection",
          error: "Pi projection cursor is not on the active session branch"
        }
      });
      return;
    }

    for (const entry of branch.slice(cursorIndex + 1)) {
      await projectPiSessionEntry(entry, input.emit);
      hosted.projectionCursor = entry.id;
      await input.saveProviderSession(providerSessionSnapshot(hosted));
    }
  }

  private async runActiveCommand(sessionId: string, command: PiActiveAgentCommand): Promise<unknown> {
    const hosted = this.loaded.get(sessionId);
    if (command.type === "abort" && (!hosted?.activeTurn || !hosted.piSession.isStreaming)) {
      return { aborted: false, reason: "turn_not_started_or_already_idle" };
    }
    if (!hosted?.activeTurn || !hosted.piSession.isStreaming) {
      if (command.type === "abort") {
        return { aborted: false, reason: "turn_not_started_or_already_idle" };
      }
      throw new PiActiveTurnUnavailableError(command.type);
    }
    if (command.type === "abort") {
      await hosted.piSession.abort();
      return { aborted: true };
    }
    const content = commandContent(command.payload);
    const disposition = command.type === "steer"
      ? await hosted.piSession.steer(content, undefined, { source: "rpc" })
      : await hosted.piSession.followUp(content, undefined, { source: "rpc" });
    return { disposition };
  }

  private async runIdleCommand(
    hosted: HostedPiSession,
    input: PiAgentRuntimeInput,
    command: PiAgentCommand
  ): Promise<unknown> {
    if (input.isCancelled()) throw new Error("Agent command lease was lost");
    if (!hosted.piSession.isIdle) throw new Error(`${command.type} requires an idle Pi session`);
    Object.assign(hosted.bridge, input);
    const turn: HostedTurn = {
      input,
      runId: randomUUID(),
      latestAssistantText: "",
      assistantFailure: null,
      started: false,
      pendingRunIds: new Set(),
      abortRequested: false,
      eventError: null,
      eventChain: Promise.resolve(),
      sequence: 0
    };
    hosted.activeTurn = turn;
    const requestAbort = async () => {
      if (turn.abortRequested) return;
      turn.abortRequested = true;
      await hosted.piSession.abort();
    };
    const stopCancellationMonitor = startPiCancellationMonitor({
      isCancelled: input.isCancelled,
      abort: requestAbort,
      onError: (error) => {
        turn.eventError ??= error;
      }
    });
    try {
      let result: unknown;
      if (command.type === "compact") {
        const instructions = optionalCommandString(command.payload.instructions);
        result = await hosted.piSession.compact(instructions ?? undefined);
      } else if (command.type === "set_model") {
        const provider = requiredCommandString(command.payload.provider, "provider");
        const modelId = requiredCommandString(command.payload.model, "model");
        const model = hosted.runtime.runtime.getModel(provider, modelId);
        if (!model) throw new Error(`Pi model "${modelId}" is unavailable for provider "${provider}"`);
        await hosted.piSession.setModel(model);
        await input.saveProviderSession(providerSessionSnapshot(hosted));
        result = { provider, model: modelId, runtimeGeneration: hosted.runtime.generation };
      } else if (command.type === "set_thinking_level") {
        const level = requiredCommandString(command.payload.level, "level") as Parameters<AgentSession["setThinkingLevel"]>[0];
        if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) {
          throw new Error(`Unsupported thinking level "${level}"`);
        }
        hosted.piSession.setThinkingLevel(level);
        result = { level: hosted.piSession.thinkingLevel };
      } else if (command.type === "stats") {
        const stats = hosted.piSession.getSessionStats();
        result = {
          ...stats,
          sessionFile: publicPiSessionFile(stats.sessionFile)
        };
      } else {
        throw new Error(`Unsupported idle command "${command.type}"`);
      }
      await turn.eventChain;
      if (turn.eventError) throw turn.eventError;
      if (input.isCancelled()) throw new Error("Agent command lease was lost");
      return result;
    } finally {
      stopCancellationMonitor();
      await turn.eventChain;
      if (hosted.activeTurn === turn) hosted.activeTurn = null;
    }
  }

  private bindInputToCurrentRuntime(
    input: PiAgentRuntimeInput,
    payload: Record<string, unknown>
  ): PiAgentRuntimeInput {
    const provider = requiredCommandString(payload.provider, "provider");
    const model = requiredCommandString(payload.model, "model");
    if (provider !== input.modelSettings.providerName || model !== input.modelSettings.model) {
      throw new Error("set_model must target the currently configured provider and model");
    }
    if (!input.providerSession) return input;
    return {
      ...input,
      providerSession: {
        ...input.providerSession,
        providerName: input.modelSettings.providerName,
        model: input.modelSettings.model,
        settingsSnapshot: settingsSnapshot(input.modelSettings),
        runtimeGeneration: input.modelSettings.generation,
        runtimeProvider: input.modelSettings.providerName,
        runtimeModel: input.modelSettings.model
      }
    };
  }

  private async runTurn(hosted: HostedPiSession, input: PiAgentRuntimeInput): Promise<PiAgentTurnResult> {
    Object.assign(hosted.bridge, input);
    const turn: HostedTurn = {
      input,
      runId: randomUUID(),
      latestAssistantText: "",
      assistantFailure: null,
      started: false,
      pendingRunIds: new Set(),
      abortRequested: false,
      eventError: null,
      eventChain: Promise.resolve(),
      sequence: 0
    };
    hosted.activeTurn = turn;
    const requestAbort = async () => {
      if (turn.abortRequested) return;
      turn.abortRequested = true;
      await hosted.piSession.abort();
    };
    const stopCancellationMonitor = startPiCancellationMonitor({
      isCancelled: input.isCancelled,
      abort: requestAbort,
      onError: (error) => {
        turn.eventError ??= error;
      }
    });

    try {
      await input.saveProviderSession(providerSessionSnapshot(hosted));
      if (input.isCancelled()) await requestAbort();
      else await hosted.piSession.prompt(input.message);
      await hosted.piSession.waitForIdle();
      await turn.eventChain;
      if (turn.eventError) throw turn.eventError;
      if (input.isCancelled()) return { status: "cancelled", runId: turn.runId };
      const pendingRunId = turn.pendingRunIds.values().next().value as string | undefined;
      if (pendingRunId) return { status: "waiting_approval", runId: pendingRunId };

      const turnFailure = getPiTurnFailure(turn.assistantFailure, turn.latestAssistantText);
      if (turnFailure) throw new Error(turnFailure);
      await input.saveProviderSession(providerSessionSnapshot(hosted));
      await this.emitTurnEvent(turn, {
        type: "agent.completed",
        payload: {
          provider: "pi",
          providerSessionId: hosted.piSession.sessionId,
          sessionFile: publicPiSessionFile(hosted.piSession.sessionFile),
          summary: turn.latestAssistantText
        }
      });
      return { status: "completed", summary: turn.latestAssistantText, runId: turn.runId };
    } catch (error) {
      if (input.isCancelled()) return { status: "cancelled", runId: turn.runId };
      const pendingRunId = turn.pendingRunIds.values().next().value as string | undefined;
      if (pendingRunId) return { status: "waiting_approval", runId: pendingRunId };
      const message = error instanceof Error ? error.message : String(error);
      if (!turn.started) {
        await this.emitTurnEvent(turn, { type: "agent.started", payload: { provider: "pi" } });
      }
      await this.emitTurnEvent(turn, { type: "agent.failed", payload: { provider: "pi", error: message } });
      return { status: "failed", error: message, runId: turn.runId };
    } finally {
      stopCancellationMonitor();
      await turn.eventChain;
      if (hosted.activeTurn === turn) hosted.activeTurn = null;
    }
  }

  private handleEvent(hosted: HostedPiSession, event: AgentSessionEvent): void {
    const turn = hosted.activeTurn;
    if (!turn) return;
    turn.eventChain = turn.eventChain
      .then(() => mapPiEvent(event, (projected) => this.emitTurnEvent(turn, projected), {
        onStarted: () => {
          turn.started = true;
        },
        onAssistantMessage: (content) => {
          turn.latestAssistantText = content;
          turn.assistantFailure = null;
        },
        onAssistantFailure: (error) => {
          turn.latestAssistantText = "";
          turn.assistantFailure = error;
        },
        onEntryAppended: async (entry) => {
          await projectPiSessionEntry(entry, (projected) => this.emitTurnEvent(turn, {
            ...projected,
            runId: turn.runId
          }));
          hosted.projectionCursor = entry.id;
          await turn.input.saveProviderSession(providerSessionSnapshot(hosted));
        },
        onCapabilityRunPending: async (runId) => {
          if (turn.pendingRunIds.has(runId)) return;
          await turn.input.onCapabilityRunPending?.(runId, hosted.piSession.sessionId);
          turn.pendingRunIds.add(runId);
          if (!turn.abortRequested) {
            turn.abortRequested = true;
            await hosted.piSession.abort();
          }
          await this.emitTurnEvent(turn, {
            type: "approval.pending",
            payload: { kind: "capability_run", runId }
          });
        }
      }))
      .catch((error: unknown) => {
        turn.eventError ??= error;
      });
  }

  private emitTurnEvent(turn: HostedTurn, event: PiAgentEmitEvent): void | Promise<void> {
    const sequence = event.sequence ?? ++turn.sequence;
    return turn.input.emit({
      ...event,
      source: event.source ?? "pi",
      sourceId: event.sourceId ?? `${turn.runId}:${sequence}`,
      runId: event.runId ?? turn.runId,
      sequence
    });
  }
}

function isActiveAgentCommand(command: PiAgentCommand): command is PiActiveAgentCommand {
  return command.type === "steer" || command.type === "follow_up" || command.type === "abort";
}

function commandContent(payload: Record<string, unknown>): string {
  return requiredCommandString(payload.content, "content");
}

function requiredCommandString(value: unknown, field: string): string {
  const normalized = optionalCommandString(value);
  if (!normalized) throw new Error(`Command ${field} is required`);
  return normalized;
}

function optionalCommandString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerSessionSnapshot(hosted: HostedPiSession) {
  const settings = hosted.runtime.settings;
  return {
    providerSessionId: hosted.piSession.sessionId,
    sessionFile: hosted.piSession.sessionFile ?? null,
    providerName: settings.providerName,
    model: settings.model,
    settingsSnapshot: settingsSnapshot(settings),
    runtimeGeneration: hosted.runtime.generation,
    runtimeProvider: settings.providerName,
    runtimeModel: settings.model,
    projectionCursor: hosted.projectionCursor
  };
}

function zosSystemPrompt(workingPath: string): string {
  return [
    "You are running inside ZOS.",
    `The current working directory is ${workingPath}.`,
    "Use the ZOS MCP server for NAS and system capabilities. Paths are always relative to a selected NAS root.",
    "Mutating capabilities return durable runs and require approval in the first-party ZOS UI.",
    "Never request or include passwords, API keys, Wi-Fi secrets, registry tokens, or host absolute paths."
  ].join("\n");
}

async function emitResourceDiagnostics(
  input: PiAgentRuntimeInput,
  loader: DefaultResourceLoader,
  generation: number
): Promise<void> {
  const diagnostics: Array<{ resourceType: string; path?: string }> = [];
  for (const error of loader.getExtensions().errors) {
    diagnostics.push({ resourceType: "extension", path: error.path });
  }
  for (const diagnostic of loader.getSkills().diagnostics) {
    if (diagnostic.type === "error") {
      diagnostics.push({
        resourceType: "skill",
        ...(diagnostic.path ? { path: diagnostic.path } : {})
      });
    }
  }
  for (const diagnostic of loader.getPrompts().diagnostics) {
    if (diagnostic.type === "error") {
      diagnostics.push({
        resourceType: "prompt",
        ...(diagnostic.path ? { path: diagnostic.path } : {})
      });
    }
  }
  let sequence = 1;
  for (const diagnostic of diagnostics) {
    await input.emit({
      type: "resource_error",
      source: "pi",
      sourceId: `resource:${input.session.id}:${generation}:${diagnostic.resourceType}:${sequence}`,
      runId: `resource:${input.session.id}`,
      sequence,
      payload: {
        resourceType: diagnostic.resourceType,
        resource: diagnostic.path ? path.basename(diagnostic.path) : null,
        error: `Pi ${diagnostic.resourceType} resource could not be loaded`
      }
    });
    sequence += 1;
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
  return [readTool, lsTool, findTool, grepTool, ...photostaffTools, editTool, writeTool] as unknown as ToolDefinition[];
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
    onEntryAppended: (entry: SessionEntry) => void | Promise<void>;
    onCapabilityRunPending: (runId: string) => void | Promise<void>;
  }
): Promise<void> {
  if (event.type === "entry_appended") {
    await callbacks.onEntryAppended(event.entry);
    return;
  }
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
  if (event.type === "turn_start") {
    await emit({ type: "turn_start", payload: {} });
    return;
  }
  if (event.type === "turn_end") {
    await emit({
      type: "turn_end",
      payload: {
        message: projectPiMessage(event.message),
        toolResultCount: event.toolResults.length
      }
    });
    return;
  }
  if (event.type === "message_start") {
    await emit({
      type: "message_start",
      payload: projectPiMessage(event.message)
    });
    return;
  }
  if (event.type === "message_update") {
    await emit({
      type: "message_update",
      payload: {
        ...projectPiMessage(event.message),
        updateType: event.assistantMessageEvent.type,
        delta: event.assistantMessageEvent.type === "text_delta"
          ? event.assistantMessageEvent.delta
          : ""
      }
    });
    return;
  }
  if (event.type === "message_end") {
    await emit({
      type: "message_end",
      payload: projectPiMessage(event.message)
    });
    if (event.message.role === "assistant") {
      mapPiAssistantMessageEnd(event.message, callbacks);
    }
    return;
  }
  if (event.type === "tool_execution_start") {
    await emit({
      type: "tool_execution_start",
      sourceId: `tool:${event.toolCallId}:start`,
      payload: {
        id: event.toolCallId,
        name: event.toolName,
        input: redactPiToolArgs(event.toolName, event.args),
        debug: compactPiEvent(event)
      }
    });
    return;
  }
  if (event.type === "tool_execution_update") {
    await emit({
      type: "tool_execution_update",
      payload: {
        id: event.toolCallId,
        name: event.toolName,
        input: redactPiToolArgs(event.toolName, event.args),
        output: redactSensitiveValue(event.partialResult)
      }
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    await emit({
      type: "tool_execution_end",
      sourceId: `tool:${event.toolCallId}:end`,
      payload: {
        id: event.toolCallId,
        name: event.toolName,
        output: redactSensitiveValue(event.result),
        isError: event.isError,
        durationMs: event.durationMs ?? null,
        debug: compactPiEvent(event)
      }
    });
    const pendingRunId = capabilityPendingRunId(event.result);
    if (pendingRunId) await callbacks.onCapabilityRunPending(pendingRunId);
    return;
  }
  if (event.type === "agent_end") {
    await emit({
      type: "agent_end",
      payload: {
        willRetry: event.willRetry,
        messageCount: event.messages.length
      }
    });
    return;
  }
  if (event.type === "compaction_start") {
    await emit({ type: "compaction_start", payload: { reason: event.reason } });
    return;
  }
  if (event.type === "compaction_end") {
    await emit({
      type: "compaction_end",
      payload: {
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        error: event.errorMessage ?? null
      }
    });
    return;
  }
  if (event.type === "thinking_level_changed") {
    await emit({
      type: "thinking_level_change",
      payload: { level: event.level }
    });
  }
}

export async function projectPiSessionEntry(
  entry: SessionEntry,
  emit: PiAgentRuntimeInput["emit"]
): Promise<void> {
  const runId = `pi-entry:${entry.id}`;
  if (entry.type === "message" && entry.message.role === "assistant") {
    for (const item of entry.message.content) {
      if (item.type !== "toolCall") continue;
      await emit({
        type: "tool_execution_start",
        source: "pi",
        sourceId: `tool:${item.id}:start`,
        runId,
        payload: {
          id: item.id,
          name: item.name,
          input: redactPiToolArgs(item.name, item.arguments)
        }
      });
    }
    const content = extractAssistantText(entry.message);
    if (content || entry.message.errorMessage) {
      await emit({
        type: "agent.message",
        source: "pi",
        sourceId: `entry:${entry.id}:assistant`,
        runId,
        payload: {
          role: "assistant",
          content,
          stopReason: entry.message.stopReason,
          error: entry.message.errorMessage ?? null
        }
      });
    }
    if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") {
      await emit({
        type: "agent.failed",
        source: "pi",
        sourceId: `entry:${entry.id}:failure`,
        runId,
        payload: {
          provider: "pi",
          error: entry.message.errorMessage ?? `Pi run ${entry.message.stopReason}`,
          interrupted: entry.message.stopReason === "aborted"
        }
      });
    }
    return;
  }
  if (entry.type === "message" && entry.message.role === "toolResult") {
    await emit({
      type: "tool_execution_end",
      source: "pi",
      sourceId: `tool:${entry.message.toolCallId}:end`,
      runId,
      payload: {
        id: entry.message.toolCallId,
        name: entry.message.toolName,
        output: redactSensitiveValue(entry.message.content),
        isError: entry.message.isError,
        durationMs: entry.message.durationMs ?? null
      }
    });
    return;
  }
  if (entry.type === "compaction") {
    await emit({
      type: "compaction_end",
      source: "pi",
      sourceId: `entry:${entry.id}`,
      runId,
      payload: {
        reason: "persisted",
        aborted: false,
        willRetry: false,
        error: null,
        tokensBefore: entry.tokensBefore
      }
    });
    return;
  }
  if (entry.type === "model_change") {
    await emit({
      type: "model_change",
      source: "pi",
      sourceId: `entry:${entry.id}`,
      runId,
      payload: { provider: entry.provider, model: entry.modelId }
    });
    return;
  }
  if (entry.type === "thinking_level_change") {
    await emit({
      type: "thinking_level_change",
      source: "pi",
      sourceId: `entry:${entry.id}`,
      runId,
      payload: { level: entry.thinkingLevel }
    });
  }
}

function projectPiMessage(message: { role: string; content?: unknown; stopReason?: unknown; errorMessage?: unknown }) {
  return {
    role: message.role,
    content: message.role === "assistant" ? extractAssistantText(message) : "",
    stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
    error: typeof message.errorMessage === "string" ? message.errorMessage : null
  };
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
    generation: settings.generation,
    providerName: settings.providerName,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKeyConfigured: Boolean(settings.apiKey),
    updatedAt: settings.updatedAt
  };
}

export function publicPiSessionFile(sessionFile: string | null | undefined): string | null {
  return sessionFile ? path.basename(sessionFile) : null;
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
