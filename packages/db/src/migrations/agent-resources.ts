import type { Migration } from "./types.js";

export const agentResourceMigrations: Migration[] = [
  {
    id: "002_agent_resources",
    sql: `
CREATE TABLE agent_resource_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation > 0),
  updated_at TEXT NOT NULL
);

INSERT INTO agent_resource_generation(id, generation, updated_at)
VALUES (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE agent_mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL,
  url TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 300),
  exposure TEXT NOT NULL CHECK (exposure IN ('codemode', 'deferred', 'direct')),
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'bearer', 'headers')),
  credential_header_names_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  allow_insecure_http INTEGER NOT NULL DEFAULT 0 CHECK (allow_insecure_http IN (0, 1)),
  test_status TEXT NOT NULL DEFAULT 'untested' CHECK (test_status IN ('untested', 'ready', 'error')),
  tool_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_count >= 0),
  last_tested_at TEXT,
  last_error TEXT,
  trusted_at TEXT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_agent_mcp_servers_enabled ON agent_mcp_servers(enabled, name);

CREATE TABLE agent_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL,
  version TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('zip', 'git')),
  source_url TEXT,
  source_ref TEXT,
  source_subdirectory TEXT,
  source_storage_pool_id TEXT,
  source_path TEXT,
  resolved_commit TEXT,
  digest TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  generation INTEGER NOT NULL CHECK (generation > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (source_type = 'zip' AND source_storage_pool_id IS NOT NULL AND source_path IS NOT NULL AND source_url IS NULL)
    OR
    (source_type = 'git' AND source_url IS NOT NULL AND source_storage_pool_id IS NULL AND source_path IS NULL)
  )
);

CREATE INDEX idx_agent_skills_enabled ON agent_skills(enabled, name);
    `
  }
];
