import { randomUUID } from "node:crypto";
import type { AgentSessionRecord, VoiceTurnRecord } from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import { createUserMessageAndJob } from "./jobs.js";
import { getSession, hasActiveJobsForSession } from "./sessions.js";

export function findVoiceSession(db: CyberOsDatabase): AgentSessionRecord | null {
  const id = db.prepare("SELECT id FROM agent_sessions WHERE system_key = 'default-voice'").pluck().get();
  return typeof id === "string" ? getSession(db, id) : null;
}

export function ensureVoiceSession(db: CyberOsDatabase): AgentSessionRecord {
  return db.transaction(() => {
    const existing = findVoiceSession(db);
    if (existing) return existing;
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_sessions(id, current_path, kind, system_key, created_at, updated_at)
      VALUES (?, '.', 'voice', 'default-voice', ?, ?)`).run(id, now, now);
    return getSession(db, id)!;
  }).immediate();
}

export function resetVoiceSession(db: CyberOsDatabase): AgentSessionRecord {
  return db.transaction(() => {
    const session = ensureVoiceSession(db);
    if (hasActiveJobsForSession(db, session.id) || listVoiceTurns(db, true).length
      || db.prepare("SELECT 1 FROM agent_session_commands WHERE session_id = ? AND status IN ('queued', 'running')").get(session.id)) {
      throw new Error("Voice session has active work");
    }
    db.prepare("DELETE FROM agent_provider_sessions WHERE session_id = ?").run(session.id);
    db.prepare("UPDATE agent_sessions SET context_generation = context_generation + 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), session.id);
    return getSession(db, session.id)!;
  }).immediate();
}

interface TurnRow {
  recording_id: string; device_id: string; session_id: string | null; message_id: string | null;
  job_id: string | null; status: VoiceTurnRecord["status"]; speech_suppressed: number;
  error: string | null; timings_json: string; created_at: string; updated_at: string;
}
function mapTurn(row: TurnRow): VoiceTurnRecord {
  return { recordingId: row.recording_id, deviceId: row.device_id, sessionId: row.session_id,
    messageId: row.message_id, jobId: row.job_id, status: row.status, speechSuppressed: Boolean(row.speech_suppressed),
    error: row.error, timings: JSON.parse(row.timings_json) as Record<string, number>, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function getVoiceTurn(db: CyberOsDatabase, recordingId: string): VoiceTurnRecord | null {
  const row = db.prepare("SELECT * FROM audio_voice_turns WHERE recording_id = ?").get(recordingId) as TurnRow | undefined;
  return row ? mapTurn(row) : null;
}
export function listVoiceTurns(db: CyberOsDatabase, active = false): VoiceTurnRecord[] {
  const rows = db.prepare(`SELECT * FROM audio_voice_turns ${active ? "WHERE status NOT IN ('completed','interrupted','failed')" : ""} ORDER BY created_at DESC, rowid DESC LIMIT 30`).all() as TurnRow[];
  return rows.map(mapTurn);
}
export function reserveVoiceTurn(db: CyberOsDatabase, input: { recordingId: string; deviceId: string }): VoiceTurnRecord {
  return db.transaction(() => {
    const existing = getVoiceTurn(db, input.recordingId);
    if (existing) return existing;
    if (listVoiceTurns(db, true).length >= 2) throw new Error("Voice channel busy");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO audio_voice_turns(recording_id, device_id, status, created_at, updated_at) VALUES (?, ?, 'transcribing', ?, ?)")
      .run(input.recordingId, input.deviceId, now, now);
    return getVoiceTurn(db, input.recordingId)!;
  }).immediate();
}
export function updateVoiceTurn(db: CyberOsDatabase, recordingId: string, patch: Partial<Pick<VoiceTurnRecord, "status" | "error" | "speechSuppressed" | "timings">>): VoiceTurnRecord {
  const current = getVoiceTurn(db, recordingId);
  if (!current) throw new Error("Voice turn not found");
  const next = { ...current, ...patch };
  db.prepare("UPDATE audio_voice_turns SET status = ?, error = ?, speech_suppressed = ?, timings_json = ?, updated_at = ? WHERE recording_id = ?")
    .run(next.status, next.error, next.speechSuppressed ? 1 : 0, JSON.stringify(next.timings), new Date().toISOString(), recordingId);
  return getVoiceTurn(db, recordingId)!;
}
export function suppressVoiceSpeech(db: CyberOsDatabase): void {
  db.prepare("UPDATE audio_voice_turns SET speech_suppressed = 1 WHERE status NOT IN ('completed','interrupted','failed')").run();
}
export function deliverVoiceTurn(db: CyberOsDatabase, recordingId: string, content: string): VoiceTurnRecord {
  return db.transaction(() => {
    const turn = getVoiceTurn(db, recordingId);
    if (!turn) throw new Error("Voice turn not found");
    if (turn.jobId) return turn;
    if (turn.status !== "transcribing" || !content.trim()) throw new Error("Invalid voice transcription");
    const session = ensureVoiceSession(db);
    const { job, message } = createUserMessageAndJob(db, { sessionId: session.id, content: content.trim(), commandIdempotencyKey: `voice:${recordingId}` });
    db.prepare("UPDATE audio_voice_turns SET session_id = ?, message_id = ?, job_id = ?, status = 'queued', updated_at = ? WHERE recording_id = ?")
      .run(session.id, message.id, job.id, new Date().toISOString(), recordingId);
    return getVoiceTurn(db, recordingId)!;
  }).immediate();
}
export function recoverVoiceTurns(db: CyberOsDatabase): void {
  db.prepare(`UPDATE audio_voice_turns SET speech_suppressed = 1,
    status = CASE WHEN job_id IS NOT NULL AND status IN ('queued','agent') THEN status
      WHEN status IN ('synthesizing','speaking') THEN 'interrupted' ELSE 'failed' END,
    error = 'Audio service restarted; uncertain audio is not replayed', updated_at = ?
    WHERE status NOT IN ('completed','interrupted','failed')`).run(new Date().toISOString());
}

export function voiceJobFinalText(db: CyberOsDatabase, jobId: string): string {
  const payload = db.prepare("SELECT payload_json FROM agent_events WHERE job_id = ? AND type = 'agent.completed' ORDER BY id DESC LIMIT 1").pluck().get(jobId);
  if (typeof payload !== "string") return "";
  const value = JSON.parse(payload) as { summary?: unknown };
  return typeof value.summary === "string" ? value.summary : "";
}
