import { afterEach, describe, expect, it, vi } from "vitest";
import { appendEvent, getJob, listVoiceTurns, openCyberOsDb, saveAudioSettings, updateJobStatus, defaultAudioSettings } from "@cyberos/db";
import { AudioCoordinator } from "./audio-coordinator.js";
import type { AudioRuntime } from "./audio-runtime.js";
import type { AudioDaemonStatus } from "@cyberos/shared";

const databases: ReturnType<typeof openCyberOsDb>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture(transcript = "你好") {
  const db = openCyberOsDb(":memory:"); databases.push(db);
  saveAudioSettings(db, { ...defaultAudioSettings(), enabled: true, cyberAudioBaseUrl: "https://audio.example.com", cyberAudioToken: "token", inputDeviceId: "remote", outputDeviceId: "speaker" });
  const daemon: AudioDaemonStatus = { available: true, connected: true, protocol: "ATVV", recordingId: null, recordings: ["capture-1"], generation: 1, playing: false, error: null };
  const played: string[] = [];
  const runtime: AudioRuntime = {
    status: async () => ({ ...daemon, recordings: [...daemon.recordings] }),
    configure: async () => {}, devices: async () => ({ inputs: [{ id: "remote", name: "Remote", connected: true }], outputs: [{ id: "speaker", name: "Speaker", connected: true }] }),
    recording: async (id) => ({ id, deviceId: "remote", wav: Buffer.alloc(50).toString("base64") }),
    ack: async (id) => { daemon.recordings = daemon.recordings.filter((value) => value !== id); },
    play: async (wav) => { played.push(wav.toString()); }, stop: async () => {}
  };
  const client = { test: async () => ({ reachable: true, authenticated: true, sttReady: true, ttsReady: true, voices: ["serena"], error: null }), transcribe: async () => transcript, synthesize: async (_settings: unknown, text: string): Promise<Buffer> => Buffer.from(text) };
  const focus = { acquire: async () => "lease", renew: async () => {}, release: async () => {} };
  const coordinator = new AudioCoordinator(db, runtime, client, focus);
  return { db, coordinator, daemon, client, played, focus, runtime };
}

describe("voice coordinator", () => {
  it("correlates final speech with the recording job, not unrelated chat output", async () => {
    const { db, coordinator, played } = fixture();
    await coordinator.tick(); await coordinator.idle();
    const turn = listVoiceTurns(db)[0]!;
    expect(getJob(db, turn.jobId!)?.status).toBe("queued");
    appendEvent(db, { sessionId: turn.sessionId!, jobId: turn.jobId!, type: "agent.completed", payload: { summary: "正确回复" } });
    appendEvent(db, { sessionId: turn.sessionId!, type: "agent.completed", payload: { summary: "不相关回复" } });
    updateJobStatus(db, turn.jobId!, "completed");
    await coordinator.tick(); await coordinator.idle();
    expect(played).toEqual(["正确回复"]);
    expect(listVoiceTurns(db)[0]!.status).toBe("completed");
  });
  it("empty or failed STT creates no agent job", async () => {
    const { db, coordinator, client, daemon } = fixture("");
    await coordinator.tick(); await coordinator.idle();
    expect(listVoiceTurns(db)[0]).toMatchObject({ status: "failed", jobId: null });
    expect(db.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
    client.transcribe = async () => { throw new Error("STT unavailable"); };
    daemon.recordings = ["capture-2"];
    await coordinator.tick(); await coordinator.idle();
    expect(listVoiceTurns(db)).toHaveLength(2);
    expect(listVoiceTurns(db).every((turn) => turn.status === "failed" && turn.jobId === null)).toBe(true);
    expect(db.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
  });
  it("new capture suppresses old job speech without cancelling that job", async () => {
    const { db, coordinator, daemon, played } = fixture();
    await coordinator.tick(); await coordinator.idle();
    const turn = listVoiceTurns(db)[0]!;
    daemon.generation++; daemon.recordingId = "capture-2";
    await coordinator.tick();
    expect(getJob(db, turn.jobId!)?.status).toBe("queued");
    appendEvent(db, { sessionId: turn.sessionId!, jobId: turn.jobId!, type: "agent.completed", payload: { summary: "旧回复" } });
    updateJobStatus(db, turn.jobId!, "completed");
    await coordinator.tick(); await coordinator.idle();
    expect(played).toEqual([]);
    expect(listVoiceTurns(db)[0]!.speechSuppressed).toBe(true);
  });
  it("TTS failure retains the single job and never resubmits the recording", async () => {
    const { db, coordinator, client } = fixture();
    await coordinator.tick(); await coordinator.idle();
    const turn = listVoiceTurns(db)[0]!;
    client.synthesize = async () => { throw new Error("TTS unavailable"); };
    appendEvent(db, { sessionId: turn.sessionId!, jobId: turn.jobId!, type: "agent.completed", payload: { summary: "回复" } });
    updateJobStatus(db, turn.jobId!, "completed");
    await coordinator.tick(); await coordinator.idle(); await coordinator.tick();
    expect(listVoiceTurns(db)[0]).toMatchObject({ status: "failed", jobId: turn.jobId });
    expect(db.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(1);
  });
  it("recording tests do not create voice turns or agent messages", async () => {
    const { db, coordinator, daemon } = fixture();
    daemon.recordings = [];
    await coordinator.armRecordingTest();
    daemon.recordings = ["capture-1"];
    await coordinator.tick(); await coordinator.idle();
    expect(coordinator.status().test.transcript).toBe("你好");
    expect(listVoiceTurns(db)).toEqual([]);
    expect(db.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
  });
  it("does not repurpose previously queued voice input as a recording test", async () => {
    const { coordinator } = fixture();
    await expect(coordinator.armRecordingTest()).rejects.toThrow(/busy/i);
    expect(coordinator.status().test.armed).toBe(false);
  });
  it("does not start old speech when a newer recording arrives during synthesis before polling", async () => {
    const { db, coordinator, daemon, client, played } = fixture();
    await coordinator.tick(); await coordinator.idle();
    const turn = listVoiceTurns(db)[0]!;
    appendEvent(db, { sessionId: turn.sessionId!, jobId: turn.jobId!, type: "agent.completed", payload: { summary: "旧回复" } });
    updateJobStatus(db, turn.jobId!, "completed");
    client.synthesize = async () => { daemon.generation++; return Buffer.from("stale"); };
    await coordinator.tick(); await coordinator.idle();
    expect(played).toEqual([]);
    expect(listVoiceTurns(db)[0]!.status).toBe("interrupted");
  });
  it("disabling during transcription prevents late Agent delivery", async () => {
    const { db, coordinator, client } = fixture();
    let finish!: (text: string) => void;
    client.transcribe = () => new Promise<string>((resolve) => { finish = resolve; });
    await coordinator.tick();
    saveAudioSettings(db, { enabled: false });
    await coordinator.settingsChanged();
    finish("late text");
    await coordinator.idle();
    expect(db.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
  });
  it("shares one in-flight focus acquisition and holds it until recording ends", async () => {
    const { coordinator, daemon, focus, played } = fixture();
    daemon.recordings = [];
    await coordinator.tick();
    let grant!: (id: string) => void;
    focus.acquire = vi.fn(() => new Promise<string>((resolve) => { grant = resolve; }));
    focus.release = vi.fn(async () => {});
    const speech = coordinator.testSpeech("test").catch((error: unknown) => error);
    await vi.waitFor(() => expect(focus.acquire).toHaveBeenCalledOnce());
    daemon.generation++;
    daemon.recordingId = "next";
    const poll = coordinator.tick();
    await Promise.resolve();
    expect(focus.acquire).toHaveBeenCalledOnce();
    grant("shared-lease");
    await poll;
    expect(await speech).toBeInstanceOf(Error);
    expect(played).toEqual([]);
    expect(focus.release).not.toHaveBeenCalled();
    daemon.recordingId = null;
    await coordinator.tick();
    expect(focus.release).toHaveBeenCalledExactlyOnceWith("shared-lease");
  });
  it("reports interrupted output tests instead of claiming audio was played", async () => {
    const { coordinator, daemon, client, played } = fixture();
    daemon.recordings = [];
    await coordinator.tick();
    let finish!: (wav: Buffer) => void;
    client.synthesize = vi.fn(() => new Promise<Buffer>((resolve) => { finish = resolve; }));
    const speech = coordinator.testSpeech("test");
    const result = expect(speech).rejects.toThrow(/interrupt/i);
    await vi.waitFor(() => expect(client.synthesize).toHaveBeenCalledOnce());
    daemon.generation++;
    finish(Buffer.from("interrupted"));
    await result;
    expect(played).toEqual([]);
  });
  it("does not submit input using a poll snapshot taken before disable", async () => {
    const { db, coordinator, runtime } = fixture();
    let configured!: () => void;
    runtime.configure = () => new Promise<void>((resolve) => { configured = resolve; });
    const poll = coordinator.tick();
    saveAudioSettings(db, { enabled: false });
    const change = coordinator.settingsChanged();
    configured();
    await poll;
    await change;
    await coordinator.idle();
    expect(db.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
  });
  it("restores linked Agent work after restart without replaying its speech", async () => {
    const { db, coordinator, played } = fixture();
    await coordinator.tick(); await coordinator.idle();
    const turn = listVoiceTurns(db)[0]!;
    coordinator.start();
    appendEvent(db, { sessionId: turn.sessionId!, jobId: turn.jobId!, type: "agent.completed", payload: { summary: "recovered" } });
    updateJobStatus(db, turn.jobId!, "completed");
    await coordinator.tick(); await coordinator.idle();
    expect(played).toEqual([]);
    expect(listVoiceTurns(db)[0]).toMatchObject({ status: "interrupted", speechSuppressed: true, jobId: turn.jobId });
    await coordinator.close();
  });
});
