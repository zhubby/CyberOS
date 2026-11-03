import type { EffectiveAudioSettings, AudioServiceStatus } from "@cyberos/shared";
export type { AudioServiceStatus } from "@cyberos/shared";
type Fetch = typeof globalThis.fetch;

export class CyberAudioClient {
  private readonly cancellation = new AbortController();
  constructor(private readonly fetcher: Fetch = globalThis.fetch, private readonly delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))) {}
  abort(): void { this.cancellation.abort(); }

  async test(settings: EffectiveAudioSettings): Promise<AudioServiceStatus> {
    const status: AudioServiceStatus = { reachable: false, authenticated: false, sttReady: false, ttsReady: false, voices: [], error: null };
    try {
      const ready = await this.request(settings, "/ready", {}, false, 8_000);
      const body = await json(ready);
      status.reachable = true;
      const models = object(body.models);
      status.sttReady = models.stt === "ready";
      status.ttsReady = models.tts === "ready";
    } catch (error) {
      status.error = audioError(error);
    }
    try {
      const response = await this.request(settings, "/v1/audio/voices", {}, true, 8_000);
      const body = await json(response);
      status.authenticated = true;
      status.voices = Array.isArray(body.voices) ? body.voices.filter((voice): voice is string => typeof voice === "string" && voice.length <= 100) : [];
    } catch (error) {
      status.error = audioError(error);
    }
    return status;
  }

  async transcribe(settings: EffectiveAudioSettings, wav: Buffer): Promise<string> {
    if (wav.length > 1024 * 1024) throw new Error("Audio recording exceeds limit");
    const body = new FormData();
    body.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "recording.wav");
    body.set("model", "qwen3-asr-1.7b");
    body.set("language", settings.sttLanguage);
    body.set("response_format", "json");
    const response = await this.request(settings, "/v1/audio/transcriptions", { method: "POST", body });
    const result = await json(response);
    if (typeof result.text !== "string" || result.text.length > 100_000) throw new Error("Invalid transcription response");
    return result.text.trim();
  }

  async synthesize(settings: EffectiveAudioSettings, text: string): Promise<Buffer> {
    if (!text.trim() || Array.from(text).length > 500) throw new Error("Speech text must contain 1–500 characters");
    const response = await this.request(settings, "/v1/audio/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      model: "qwen3-tts-1.7b", input: text, voice: settings.ttsVoice, language: settings.ttsLanguage,
      instructions: settings.ttsInstructions, response_format: "wav", stream: false
    }) });
    const wav = await boundedBody(response, 6 * 1024 * 1024);
    if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Speech service did not return WAV audio");
    return wav;
  }

  private async request(settings: EffectiveAudioSettings, route: string, init: RequestInit = {}, authenticated = true, timeout = 130_000): Promise<Response> {
    if (!settings.cyberAudioBaseUrl) throw new Error("Configure CyberAudio service first");
    if (authenticated && !settings.cyberAudioToken) throw new Error("Configure CyberAudio token first");
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", `Bearer ${settings.cyberAudioToken}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${settings.cyberAudioBaseUrl}${route}`, { ...init, headers, redirect: "error", signal: AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(timeout)]) });
      } catch { throw new Error("CyberAudio connection failed or timed out"); }
      if (response.status === 429 && attempt < 2) {
        const value = response.headers.get("retry-after") ?? "2";
        const seconds = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
        await response.body?.cancel();
        await this.delay(Math.min(5_000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : 2_000)));
        continue;
      }
      if (!response.ok && !(route === "/ready" && response.status === 503)) {
        await response.body?.cancel();
        throw new Error(response.status === 401 || response.status === 403 ? "CyberAudio authentication failed" : response.status === 429 ? "CyberAudio busy; retry later" : `CyberAudio request failed (${response.status})`);
      }
      return response;
    }
    throw new Error("CyberAudio busy; retry later");
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function boundedBody(response: Response, max: number): Promise<Buffer> {
  if (!response.body) throw new Error("Empty CyberAudio response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error("CyberAudio response exceeds limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  try { return object(JSON.parse((await boundedBody(response, 256 * 1024)).toString("utf8"))); }
  catch { throw new Error("Invalid CyberAudio response"); }
}
export function audioError(error: unknown): string {
  return error instanceof Error ? error.message : "Audio operation failed";
}

export function speechChunks(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, "")
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/giu, "").replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").replace(/^\s{0,3}(?:#{1,6}\s*|>\s*|[-*+]\s+|\d+\.\s+)/gmu, "")
    .replace(/[*_`~]/gu, "").replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim();
  const chunks: string[] = [];
  let current = "";
  for (const sentence of plain.match(/[^。！？.!?]+[。！？.!?]?|[。！？.!?]/gu) ?? []) {
    const characters = Array.from(sentence);
    if (current && Array.from(current).length + characters.length > 500) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
    }
    while (characters.length > 500) {
      const chunk = characters.splice(0, 500).join("").trim();
      if (chunk) chunks.push(chunk);
    }
    current += characters.join("");
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
