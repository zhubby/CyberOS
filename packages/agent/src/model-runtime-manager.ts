import path from "node:path";
import {
  ModelRuntime,
  type CreateModelRuntimeOptions
} from "@earendil-works/pi-coding-agent";
import type {
  AgentProviderSessionRecord,
  ModelProviderName,
  ModelProviderSettingsRecord
} from "@cyberos/shared";

type PiProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
type PiProviderApi = NonNullable<PiProviderConfig["api"]>;

export interface ModelRuntimeBinding {
  generation: number;
  settings: ModelProviderSettingsRecord;
  runtime: ModelRuntime;
  model: ReturnType<ModelRuntime["getModel"]>;
}

export type ModelRuntimeFactory = (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;

export function registerConfiguredProvider(
  modelRuntime: ModelRuntime,
  settings: ModelProviderSettingsRecord
): void {
  if (!settings.baseUrl) return;

  if (settings.model && !modelRuntime.getModel(settings.providerName, settings.model)) {
    modelRuntime.registerProvider(settings.providerName, {
      baseUrl: settings.baseUrl,
      api: providerApi(settings.providerName),
      models: [configuredProviderModel(settings)]
    });
    return;
  }
  modelRuntime.registerProvider(settings.providerName, { baseUrl: settings.baseUrl });
}

export class ModelRuntimeManager {
  private readonly generations = new Map<string, Promise<ModelRuntimeBinding>>();

  constructor(
    private readonly agentDir: string,
    private readonly createRuntime: ModelRuntimeFactory = (options) => ModelRuntime.create(options)
  ) {}

  get(
    currentSettings: ModelProviderSettingsRecord,
    providerSession: AgentProviderSessionRecord | null
  ): Promise<ModelRuntimeBinding> {
    const settings = resolveRuntimeSettings(currentSettings, providerSession);
    const cacheKey = runtimeCacheKey(settings);
    const existing = this.generations.get(cacheKey);
    if (existing) return existing;

    const created = this.createBinding(settings, currentSettings).catch((error: unknown) => {
      this.generations.delete(cacheKey);
      throw error;
    });
    this.generations.set(cacheKey, created);
    return created;
  }

  clear(): void {
    this.generations.clear();
  }

  get size(): number {
    return this.generations.size;
  }

  private async createBinding(
    settings: ModelProviderSettingsRecord,
    currentSettings: ModelProviderSettingsRecord
  ): Promise<ModelRuntimeBinding> {
    const runtime = await this.createRuntime({
      authPath: path.join(this.agentDir, "auth.json"),
      modelsPath: null
    });
    registerConfiguredProvider(runtime, settings);

    const canUseCurrentCredential =
      settings.generation === currentSettings.generation
      && settings.providerName === currentSettings.providerName;
    if (canUseCurrentCredential && currentSettings.apiKey) {
      await runtime.setRuntimeApiKey(settings.providerName, currentSettings.apiKey);
    }
    if (!runtime.hasConfiguredAuth(settings.providerName)) {
      const reason = canUseCurrentCredential
        ? "Configure or re-authenticate the provider before retrying."
        : `Runtime generation ${settings.generation} no longer has credentials. Re-authenticate or explicitly switch this session to the current model.`;
      throw new Error(`Pi credentials are unavailable for provider "${settings.providerName}". ${reason}`);
    }

    const model = settings.model
      ? runtime.getModel(settings.providerName, settings.model)
      : undefined;
    if (settings.model && !model) {
      throw new Error(
        `Pi model "${settings.model}" is not available for provider "${settings.providerName}". Set a Base URL when using a custom model ID.`
      );
    }
    return {
      generation: settings.generation,
      settings,
      runtime,
      model
    };
  }
}

function runtimeCacheKey(settings: ModelProviderSettingsRecord): string {
  return JSON.stringify([
    settings.generation,
    settings.providerName,
    settings.baseUrl,
    settings.model
  ]);
}

export function resolveRuntimeSettings(
  currentSettings: ModelProviderSettingsRecord,
  providerSession: AgentProviderSessionRecord | null
): ModelProviderSettingsRecord {
  if (!providerSession) return currentSettings;
  const snapshot = providerSession.settingsSnapshot;
  return {
    generation: positiveInteger(snapshot.generation) ?? providerSession.runtimeGeneration,
    providerName: providerSession.runtimeProvider,
    baseUrl: nullableString(snapshot.baseUrl),
    model: providerSession.runtimeModel,
    apiKey: null,
    updatedAt: stringValue(snapshot.updatedAt) ?? providerSession.updatedAt
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : stringValue(value);
}

function providerApi(providerName: ModelProviderName): PiProviderApi {
  return providerName === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function configuredProviderModel(
  settings: ModelProviderSettingsRecord
): NonNullable<PiProviderConfig["models"]>[number] {
  return {
    id: settings.model,
    name: settings.model,
    api: providerApi(settings.providerName),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384
  };
}
