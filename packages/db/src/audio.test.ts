import { afterEach, describe, expect, it } from "vitest";
import { openCyberOsDb } from "./connection.js";
import {
  createSession, defaultAudioSettings, deleteSession, getAudioSettings,
  listMessages, saveAudioSettings, getAgentProviderSession, saveAgentProviderSession, updateJobStatus
} from "./repositories.js";
import {
  ensureVoiceSession, resetVoiceSession, reserveVoiceTurn, deliverVoiceTurn,
  getVoiceTurn, updateVoiceTurn, recoverVoiceTurns
} from "./repositories/audio.js";

const databases: ReturnType<typeof openCyberOsDb>[] = [];
function database() {
  const db = openCyberOsDb(":memory:");
  databases.push(db);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("voice persistence", () => {
  it("migrates ordinary sessions and creates one protected default voice session", () => {
    const db = database();
    expect(createSession(db, {}).kind).toBe("chat");
    const session = ensureVoiceSession(db);
    expect(session.kind).toBe("voice");
    expect(ensureVoiceSession(db).id).toBe(session.id);
    expect(() => deleteSession(db, session.id)).toThrow(/voice/i);
  });

  it("reads legacy audio settings with safe defaults and preserves token on partial saves", () => {
    const db = database();
    db.prepare("INSERT INTO system_settings(key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("audio_settings", JSON.stringify({ cyberAudioBaseUrl: "http://localhost:8443", updatedAt: "2026-11-03T00:00:00.000Z" }), "2026-11-03T00:00:00.000Z");
    expect(getAudioSettings(db)).toMatchObject({ enabled: false, inputDeviceId: null, maxRecordingSeconds: 30, cyberAudioToken: null });
    saveAudioSettings(db, { ...defaultAudioSettings(), cyberAudioToken: "private-token" });
    expect(saveAudioSettings(db, { cyberAudioBaseUrl: "https://example.com" }).cyberAudioToken).toBe("private-token");
    expect(() => saveAudioSettings(db, { enabled: true })).toThrow();
  });

  it("delivers a recording exactly once and keeps the explicit job association", () => {
    const db = database();
    reserveVoiceTurn(db, { recordingId: "recording-1", deviceId: "remote-1" });
    const first = deliverVoiceTurn(db, "recording-1", "hello");
    const duplicate = deliverVoiceTurn(db, "recording-1", "other");
    expect(duplicate).toEqual(first);
    expect(first.jobId).toBeTruthy();
    expect(listMessages(db, { sessionId: first.sessionId!, limit: 100 })).toHaveLength(1);
    expect(() => resetVoiceSession(db)).toThrow(/active/i);
  });

  it("rejects null values for nonnullable audio controls", () => {
    const db = database();
    for (const key of ["enabled", "speechEnabled", "maxRecordingSeconds", "volume", "sttLanguage", "ttsLanguage", "ttsVoice", "ttsInstructions"]) {
      expect(() => saveAudioSettings(db, { [key]: null })).toThrow(/invalid/i);
    }
  });

  it("rejects a third live turn and does not replay uncertain speech on recovery", () => {
    const db = database();
    reserveVoiceTurn(db, { recordingId: "first", deviceId: "remote" });
    reserveVoiceTurn(db, { recordingId: "second", deviceId: "remote" });
    expect(() => reserveVoiceTurn(db, { recordingId: "third", deviceId: "remote" })).toThrow(/busy/i);
    updateVoiceTurn(db, "first", { status: "speaking" });
    recoverVoiceTurns(db);
    expect(getVoiceTurn(db, "first")).toMatchObject({ status: "interrupted", speechSuppressed: true });
    expect(getVoiceTurn(db, "second")).toMatchObject({ status: "failed" });
  });

  it("resets context generation without deleting history or the default identity", () => {
    const db = database();
    const original = ensureVoiceSession(db);
    reserveVoiceTurn(db, { recordingId: "retained", deviceId: "remote" });
    const turn = deliverVoiceTurn(db, "retained", "retained history");
    updateJobStatus(db, turn.jobId!, "completed");
    updateVoiceTurn(db, "retained", { status: "completed" });
    saveAgentProviderSession(db, { sessionId: original.id, providerSessionId: "old-context", sessionFile: "/tmp/old-context.jsonl", providerName: "openai", model: "model", settingsSnapshot: {} });
    expect(getAgentProviderSession(db, original.id)?.providerSessionId).toBe("old-context");
    const reset = resetVoiceSession(db);
    expect(reset.id).toBe(original.id);
    expect(reset.contextGeneration).toBe(1);
    expect(getAgentProviderSession(db, reset.id)).toBeNull();
    expect(listMessages(db, { sessionId: reset.id, limit: 100 })[0]?.content).toBe("retained history");
  });
});
