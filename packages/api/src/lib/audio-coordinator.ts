import {
  defaultAudioSettings, deliverVoiceTurn, ensureVoiceSession, findVoiceSession,
  getAudioSettings, getJob, getVoiceTurn, listVoiceTurns, recoverVoiceTurns,
  reserveVoiceTurn, resetVoiceSession, suppressVoiceSpeech, updateVoiceTurn, voiceJobFinalText,
  type CyberOsDatabase
} from "@cyberos/db";
import type { AudioStatus, EffectiveAudioSettings, VoiceTurnRecord } from "@cyberos/shared";
import { CyberAudioClient, speechChunks, type AudioServiceStatus } from "./audio-client.js";
import type { AudioFocusRuntime } from "./audio-focus.js";
import { unavailableAudioStatus, type AudioRuntime } from "./audio-runtime.js";

type AudioClient = Pick<CyberAudioClient, "test" | "transcribe" | "synthesize">;

export class AudioCoordinator {
  private daemon = unavailableAudioStatus();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private readonly work = new Set<Promise<void>>();
  private readonly transcribing = new Set<string>();
  private speech: Promise<void> | null = null;
  private epoch = 0;
  private configurationRevision = 0;
  private generation: number | null = null;
  private lastConfiguration = "";
  private configuredAt = 0;
  private lease: { id: string; renewedAt: number } | null = null;
  private focusSerial: Promise<void> = Promise.resolve();
  private readonly focusOwners = new Set<string>();
  private recordingOwner: string | null = null;
  private error: string | null = null;
  private closed = false;
  private testDeadline = 0;
  private testResult: AudioStatus["test"] = { armed: false, transcript: null, error: null };

  constructor(private readonly db: CyberOsDatabase, readonly runtime: AudioRuntime, private readonly client: AudioClient = new CyberAudioClient(), private readonly focus: AudioFocusRuntime) {}

  start(): void {
    recoverVoiceTurns(this.db);
    this.timer = setInterval(() => { void this.tick(); }, 300);
    this.timer.unref();
    void this.tick();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.epoch++;
    if (this.client instanceof CyberAudioClient) this.client.abort();
    await this.runtime.stop().catch(() => {});
    await this.runtime.configure({ enabled: false, inputDeviceId: null, maxRecordingSeconds: 30 }).catch(() => {});
    await this.ticking;
    await this.idle();
    for (const owner of this.focusOwners) await this.releaseFocus(owner);
  }

  status(): AudioStatus {
    const turns = listVoiceTurns(this.db);
    return { daemon: this.daemon, sessionId: findVoiceSession(this.db)?.id ?? null,
      awaitingApproval: turns.some((turn) => turn.jobId && getJob(this.db, turn.jobId)?.status === "waiting_approval"),
      turns, error: this.error, test: { ...this.testResult } };
  }
  async refreshStatus(): Promise<AudioStatus> { await this.tick(); return this.status(); }
  async validateSettings(settings: EffectiveAudioSettings): Promise<void> {
    if (!settings.enabled) return;
    const devices = await this.runtime.devices();
    if (!devices.inputs.some((device) => device.id === settings.inputDeviceId)) throw new Error("Select a paired trusted ATVV input");
    if (!devices.outputs.some((device) => device.id === settings.outputDeviceId && device.connected)) throw new Error("Selected audio output is offline");
  }
  async settingsChanged(): Promise<void> {
    this.configurationRevision++;
    this.error = null;
    this.lastConfiguration = "";
    this.testDeadline = 0;
    this.testResult.armed = false;
    await this.stopSpeech();
    if (this.settings().enabled) ensureVoiceSession(this.db);
    await this.tick();
  }
  async stopSpeech(): Promise<void> {
    this.epoch++;
    suppressVoiceSpeech(this.db);
    await this.runtime.stop().catch(() => {});
  }
  async serviceTest(): Promise<AudioServiceStatus> { return this.client.test(this.settings()); }
  async armRecordingTest(): Promise<void> {
    const revision = this.configurationRevision;
    const settings = this.settings();
    if (!settings.inputDeviceId || !settings.cyberAudioBaseUrl || !settings.cyberAudioToken) throw new Error("Configure input, service and token first");
    const daemon = await this.runtime.status();
    if (this.closed || revision !== this.configurationRevision) throw new Error("Audio configuration changed");
    if (!daemon.available || this.transcribing.size || this.testResult.armed || daemon.recordingId || daemon.recordings.length) throw new Error("Audio input is busy");
    this.testDeadline = Date.now() + 45_000;
    this.testResult = { armed: true, transcript: null, error: null };
    this.lastConfiguration = "";
    await this.stopSpeech();
  }
  async testSpeech(text: string): Promise<void> {
    if (this.speech || this.daemon.recordingId) throw new Error("Audio output is busy");
    const settings = this.settings();
    if (!settings.outputDeviceId) throw new Error("Select an audio output first");
    const operation = (async () => { await this.stopSpeech(); await this.speak(null, text, settings); })();
    this.speech = operation;
    try { await operation; } finally { this.speech = null; }
  }
  resetContext() {
    if (this.daemon.recordingId || this.work.size || this.speech || this.testResult.armed) throw new Error("Voice session has active work");
    return resetVoiceSession(this.db);
  }
  async idle(): Promise<void> { await Promise.allSettled([...this.work, ...(this.speech ? [this.speech] : [])]); }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.ticking ??= this.poll().catch(() => { this.error = "Audio coordination failed; check device and service configuration"; }).finally(() => { this.ticking = null; });
    return this.ticking;
  }
  private settings(): EffectiveAudioSettings { return getAudioSettings(this.db) ?? defaultAudioSettings(); }

  private async poll(): Promise<void> {
    const revision = this.configurationRevision;
    const settings = this.settings();
    if (this.testResult.armed && Date.now() >= this.testDeadline) {
      this.testResult = { armed: false, transcript: null, error: "Recording test timed out" };
      this.testDeadline = 0;
    }
    const config = { enabled: settings.enabled || this.testResult.armed, inputDeviceId: settings.inputDeviceId, maxRecordingSeconds: settings.maxRecordingSeconds };
    const signature = JSON.stringify(config);
    try {
      if (signature !== this.lastConfiguration || Date.now() - this.configuredAt > 20_000) {
        await this.runtime.configure(config);
        this.lastConfiguration = signature;
        this.configuredAt = Date.now();
      }
      this.daemon = await this.runtime.status();
    } catch {
      this.daemon = unavailableAudioStatus();
    }
    if (this.closed || revision !== this.configurationRevision) return;
    if (this.generation !== null && this.generation !== this.daemon.generation && this.daemon.available) {
      this.epoch++;
      suppressVoiceSpeech(this.db);
    }
    if (this.daemon.available) this.generation = this.daemon.generation;
    const recordingOwner = this.daemon.recordingId ? `recording:${this.daemon.recordingId}` : null;
    if (recordingOwner) await this.acquireFocus(recordingOwner);
    if (this.recordingOwner && this.recordingOwner !== recordingOwner) await this.releaseFocus(this.recordingOwner);
    this.recordingOwner = recordingOwner;
    const focusIntact = await this.withFocus(async () => {
      if (!this.lease || Date.now() - this.lease.renewedAt <= 4_000) return true;
      try { await this.focus.renew(this.lease.id); this.lease.renewedAt = Date.now(); return true; }
      catch { this.lease = null; this.focusOwners.clear(); return false; }
    });
    if (!focusIntact) {
      await this.stopSpeech();
      this.error = "Media changed; speech interrupted";
    }
    if (this.closed || revision !== this.configurationRevision) return;
    for (const id of this.daemon.recordings) {
      if (this.transcribing.has(id)) continue;
      const existing = getVoiceTurn(this.db, id);
      if (existing) { await this.runtime.ack(id); continue; }
      if (!settings.enabled && !this.testResult.armed) { await this.runtime.ack(id); continue; }
      if (this.transcribing.size) break;
      const testing = this.testResult.armed;
      if (!testing) {
        try { reserveVoiceTurn(this.db, { recordingId: id, deviceId: settings.inputDeviceId ?? "unknown" }); }
        catch { this.error = "Voice channel busy; input was not submitted"; await this.runtime.ack(id); continue; }
      }
      if (testing) { this.testResult.armed = false; this.testDeadline = 0; }
      this.transcribing.add(id);
      const operation = this.transcribe(id, settings, testing).finally(() => { this.transcribing.delete(id); this.work.delete(operation); });
      this.work.add(operation);
    }
    for (const turn of listVoiceTurns(this.db, true).reverse()) {
      if (!turn.jobId) continue;
      const job = getJob(this.db, turn.jobId);
      if (!job || job.status === "failed" || job.status === "cancelled") {
        updateVoiceTurn(this.db, turn.recordingId, { status: "failed", error: "Agent task failed or was cancelled; inspect voice history" });
      } else if (job.status === "running" || job.status === "waiting_approval") {
        if (turn.status === "queued") updateVoiceTurn(this.db, turn.recordingId, { status: "agent" });
      } else if (job.status === "completed" && (turn.status === "queued" || turn.status === "agent")) {
        if (turn.speechSuppressed || !settings.enabled || !settings.speechEnabled) {
          updateVoiceTurn(this.db, turn.recordingId, { status: turn.speechSuppressed ? "interrupted" : "completed" });
        } else if (!this.speech) {
          const ready = updateVoiceTurn(this.db, turn.recordingId, { timings: { ...turn.timings,
            agentMs: Math.max(0, Date.now() - Date.parse(turn.createdAt) - (turn.timings.sttMs ?? 0)) } });
          const operation = this.speak(ready, voiceJobFinalText(this.db, turn.jobId), settings).catch(() => {
            const interrupted = getVoiceTurn(this.db, turn.recordingId)?.speechSuppressed;
            updateVoiceTurn(this.db, turn.recordingId, { status: interrupted ? "interrupted" : "failed", error: interrupted ? null : "Speech synthesis or selected output failed; text remains in voice history" });
          }).finally(() => { this.speech = null; });
          this.speech = operation;
        }
      }
    }
  }

  private async transcribe(id: string, settings: EffectiveAudioSettings, testing: boolean): Promise<void> {
    const started = Date.now();
    const revision = this.configurationRevision;
    try {
      const recording = await this.runtime.recording(id);
      if (recording.id !== id || recording.deviceId !== settings.inputDeviceId) throw new Error("Recording identity mismatch");
      const text = await this.client.transcribe(settings, Buffer.from(recording.wav, "base64"));
      if (this.closed) return;
      if (revision !== this.configurationRevision) {
        if (!testing) updateVoiceTurn(this.db, id, { status: "failed", error: "Configuration changed; transcription was not submitted" });
        return;
      }
      if (testing) this.testResult = { armed: false, transcript: text, error: text ? null : "Empty transcription" };
      else if (!text) updateVoiceTurn(this.db, id, { status: "failed", error: "Empty transcription; no Agent task created" });
      else {
        deliverVoiceTurn(this.db, id, text);
        updateVoiceTurn(this.db, id, { timings: { sttMs: Date.now() - started } });
      }
    } catch {
      if (testing) this.testResult = { armed: false, transcript: null, error: "Recording or transcription failed" };
      else updateVoiceTurn(this.db, id, { status: "failed", error: "Recording or transcription failed; no Agent task created" });
    } finally { await this.runtime.ack(id).catch(() => {}); }
  }

  private async speak(turn: VoiceTurnRecord | null, text: string, settings: EffectiveAudioSettings): Promise<void> {
    const epoch = this.epoch;
    const owner = `speech:${turn?.recordingId ?? "test"}`;
    const started = Date.now();
    let firstPlayback = true;
    const valid = () => !this.closed && epoch === this.epoch && (!turn || !getVoiceTurn(this.db, turn.recordingId)?.speechSuppressed);
    try {
      const initial = await this.runtime.status();
      const expectedGeneration = initial.generation;
      if (initial.recordingId || (turn && expectedGeneration !== this.generation)) {
        this.epoch++;
        suppressVoiceSpeech(this.db);
      }
      const chunks = speechChunks(text);
      if (!turn && !chunks.length) throw new Error("Speech test has no speakable text");
      if (turn && valid()) updateVoiceTurn(this.db, turn.recordingId, { status: "synthesizing" });
      for (const chunk of chunks) {
        if (!valid()) break;
        const wav = await this.client.synthesize(settings, chunk);
        if (!valid()) break;
        const status = await this.runtime.status();
        if (status.recordingId || status.generation !== expectedGeneration) {
          this.epoch++;
          suppressVoiceSpeech(this.db);
          break;
        }
        await this.acquireFocus(owner);
        if (!valid()) break;
        if (!settings.outputDeviceId) throw new Error("Output not selected");
        if (turn) {
          const current = getVoiceTurn(this.db, turn.recordingId)!;
          updateVoiceTurn(this.db, turn.recordingId, { status: "speaking", timings: { ...current.timings,
            ...(firstPlayback ? { ttsMs: Date.now() - started, replyMs: Date.now() - Date.parse(turn.createdAt) } : {}) } });
        }
        firstPlayback = false;
        await this.runtime.play(wav, settings.outputDeviceId, settings.volume, status.generation);
      }
      if (!turn && (!valid() || firstPlayback)) throw new Error("Speech test interrupted");
      if (turn) updateVoiceTurn(this.db, turn.recordingId, { status: valid() ? "completed" : "interrupted" });
    } finally { await this.releaseFocus(owner); }
  }
  private async acquireFocus(owner: string): Promise<void> {
    await this.withFocus(async () => {
      if (!this.lease) this.lease = { id: await this.focus.acquire(), renewedAt: Date.now() };
      this.focusOwners.add(owner);
    });
  }
  private async releaseFocus(owner: string): Promise<void> {
    await this.withFocus(async () => {
      this.focusOwners.delete(owner);
      if (!this.lease || this.focusOwners.size) return;
      const lease = this.lease;
      this.lease = null;
      await this.focus.release(lease.id).catch(() => {});
    });
  }
  private withFocus<Result>(operation: () => Promise<Result>): Promise<Result> {
    const next = this.focusSerial.then(operation);
    this.focusSerial = next.then(() => {}, () => {});
    return next;
  }
}
