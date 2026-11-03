import type { Migration } from "./types.js";

export const audioMigrations: Migration[] = [{
  id: "009_audio_voice_channel",
  sql: `
ALTER TABLE agent_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat', 'voice'));
ALTER TABLE agent_sessions ADD COLUMN system_key TEXT;
ALTER TABLE agent_sessions ADD COLUMN context_generation INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_agent_sessions_system_key ON agent_sessions(system_key) WHERE system_key IS NOT NULL;
CREATE TABLE audio_voice_turns (
  recording_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  session_id TEXT REFERENCES agent_sessions(id),
  message_id TEXT,
  job_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('transcribing','queued','agent','synthesizing','speaking','completed','interrupted','failed')),
  speech_suppressed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  timings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_audio_voice_turns_status ON audio_voice_turns(status, created_at);
`
}];
