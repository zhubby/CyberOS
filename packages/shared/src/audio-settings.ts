import type { EffectiveAudioSettings, PublicAudioSettings } from "./types.js";

export const AUDIO_SETTING_FIELDS = ["cyberAudioBaseUrl", "cyberAudioToken", "enabled", "inputDeviceId", "maxRecordingSeconds", "sttLanguage", "ttsLanguage", "ttsVoice", "ttsInstructions", "speechEnabled", "outputDeviceId", "volume"] as const;

export function normalizeAudioSettings(input: Record<string, unknown>, updatedAt: string): EffectiveAudioSettings {
  const text = (key: string, fallback: string, max: number): string => {
    const value = input[key] === undefined ? fallback : input[key];
    if (typeof value !== "string" || Array.from(value).length > max || Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`Invalid audio ${key}`);
    return value.trim();
  };
  const optionalText = (key: string, max: number): string | null => input[key] === null || input[key] === undefined ? null : text(key, "", max) || null;
  const boolean = (key: string, fallback: boolean): boolean => {
    if (input[key] === undefined) return fallback;
    if (typeof input[key] !== "boolean") throw new Error(`Invalid audio ${key}`);
    return input[key];
  };
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = input[key] === undefined ? fallback : input[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid audio ${key}`);
    return value;
  };
  const language = (key: string): "auto" | "zh" | "en" => {
    const value = input[key] === undefined ? "auto" : input[key];
    if (value !== "auto" && value !== "zh" && value !== "en") throw new Error(`Invalid audio ${key}`);
    return value;
  };
  const settings: EffectiveAudioSettings = {
    cyberAudioBaseUrl: normalizeCyberAudioBaseUrl(input.cyberAudioBaseUrl ?? null),
    cyberAudioToken: optionalText("cyberAudioToken", 4096),
    enabled: boolean("enabled", false), inputDeviceId: optionalText("inputDeviceId", 256),
    maxRecordingSeconds: number("maxRecordingSeconds", 30, 1, 30),
    sttLanguage: language("sttLanguage"), ttsLanguage: language("ttsLanguage"),
    ttsVoice: text("ttsVoice", "serena", 100), ttsInstructions: text("ttsInstructions", "", 200),
    speechEnabled: boolean("speechEnabled", true), outputDeviceId: optionalText("outputDeviceId", 512),
    volume: number("volume", 70, 0, 100), updatedAt
  };
  if (settings.enabled && (!settings.cyberAudioBaseUrl || !settings.cyberAudioToken || !settings.inputDeviceId || !settings.outputDeviceId)) {
    throw new Error("Voice requires a service, token, trusted input and explicit output");
  }
  return settings;
}

export function publicAudioSettings(settings: EffectiveAudioSettings): PublicAudioSettings {
  const { cyberAudioToken, ...visible } = settings;
  return { ...visible, tokenConfigured: Boolean(cyberAudioToken) };
}

export function normalizeCyberAudioBaseUrl(value: unknown): string | null {
  if (value === null) return null;
  const invalid = () => new Error("CyberAudio requires an HTTP/HTTPS service address without credentials, query parameters, or a fragment");
  if (typeof value !== "string") throw invalid();
  const address = value.trim();
  if (!address) return null;
  if (
    address.length > 2048
    || /[\s\\]/u.test(address)
    || Array.from(address).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) throw invalid();

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw invalid();
  }
  if (
    !/^https?:\/\//iu.test(address)
    || !["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || address.includes("?")
    || address.includes("#")
  ) throw invalid();
  const normalized = url.toString().replace(/\/+$/u, "");
  if (normalized.length > 2048) throw invalid();
  return normalized;
}
