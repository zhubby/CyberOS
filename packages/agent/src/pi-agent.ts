import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type LoadedMcpConfig,
  type SessionEntry
} from "@earendil-works/pi-coding-agent";
import { resolveSafeExistingPath } from "@cyberos/nas-tools";
import type {
  AgentProviderSessionRecord,
  AgentSessionCommandType,
  AgentSessionRecord,
  ModelProviderSettingsRecord,
  ModelProviderName,
  NasRootRecord,
  PiToolName,
  PiToolPolicySettingsRecord
} from "@cyberos/shared";
import {
  ModelRuntimeManager,
  type ModelRuntimeBinding
} from "./model-runtime-manager.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import { PiResourcePolicy } from "./pi-resource-policy.js";

export { registerConfiguredProvider } from "./model-runtime-manager.js";

export interface PiAgentEmitEvent {
  type: import("@cyberos/shared").AgentEventType;
  payload: Record<string, unknown>;
  source?: "pi" | "cyberos";
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
  mcp?: PiMcpRuntimeSettings;
  runner?: PiAgentRunner;
}

export interface PiMcpRuntimeSettings {
  enabled: boolean;
  url: string;
  tokenFile: string;
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

const DIRECT_MCP_TOOLS = [
  "cyberos.catalog.get",
  "cyberos.system.status",
  "cyberos.roots.list",
  "cyberos.files.list",
  "cyberos.files.stat",
  "cyberos.files.read",
  "cyberos.files.search",
  "cyberos.files.mutate",
  "cyberos.runs.get"
] as const;
const MCP_RESOURCE_TOOL_NAMES = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource"
] as const;
const CYBEROS_MCP_SERVER_NAME = "cyberos";
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
      appendSystemPrompt: [cyberosSystemPrompt(workspace.relativePath)]
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
        mcpEnabled: mcpConfig !== null
      }),
      customTools: [],
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

function cyberosSystemPrompt(workingPath: string): string {
  return [
    "You are running inside CyberOS.",
    `The current working directory is ${workingPath}.`,
    "Use the CyberOS MCP server for NAS and system capabilities. Paths are always relative to a selected NAS root.",
    "Mutating capabilities return durable runs and require approval in the first-party CyberOS UI.",
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
}): string[] {
  return [
    // Pi requires an MCP allowlist match before direct tools can be declared to the model.
    ...(options.mcpEnabled
      ? [
          "codemode",
          "tool_search",
          `mcp__${CYBEROS_MCP_SERVER_NAME}__*`,
          ...MCP_RESOURCE_TOOL_NAMES
        ]
      : [])
  ];
}

export async function loadControlledPiMcpConfig(settings: PiMcpRuntimeSettings): Promise<LoadedMcpConfig> {
  const tokenStat = await stat(settings.tokenFile);
  if (!tokenStat.isFile()) {
    throw new Error("CyberOS Pi MCP token path is not a regular file");
  }
  if ((tokenStat.mode & 0o077) !== 0) {
    throw new Error("CyberOS Pi MCP token file permissions must be 0600");
  }
  const token = (await readFile(settings.tokenFile, "utf8")).trim();
  if (!/^cyberos_mcp_[A-Za-z0-9_-]{40,}$/u.test(token)) {
    throw new Error("CyberOS Pi MCP token file is invalid");
  }
  return {
    servers: [{
      name: CYBEROS_MCP_SERVER_NAME,
      source: "cyberos:internal",
      scope: "global",
      config: {
        type: "http",
        url: settings.url,
        headers: { Authorization: `Bearer ${token}` },
        exposure: "codemode",
        description: "CyberOS NAS capabilities, durable runs, resources, and approval-gated proposals.",
        toolExposure: Object.fromEntries(DIRECT_MCP_TOOLS.map((name) => [name, "direct" as const]))
      }
    }],
    autoEnableCodemode: true,
    errors: []
  };
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
