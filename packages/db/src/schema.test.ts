import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createActionMessageAndJob,
  createDockerConsoleAuthorization,
  createDockerOperationRecord,
  createSession,
  createUserMessageAndJob,
  createVmConsoleAuthorization,
  ensureNasRoots,
  getApproval,
  getDockerOperation,
  getJob,
  getVmOperation,
  listTranscriptItems,
  listOperationNotifications,
  CYBEROS_DATABASE_FORMAT_VERSION,
  migrations,
  openCyberOsDb,
  openCyberOsDbReadOnly,
  updateApprovalStatus,
  updateDockerOperationStatus,
  updateVmOperationStatus
} from "./index.js";
import { createPendingApproval } from "./repositories/approvals.js";
import { createDockerOperationApproval } from "./repositories/docker-operations.js";
import { createVmOperationApproval } from "./repositories/vm-operations.js";

let tempDir: string;

function startMigrationProcess(databasePath: string, moduleUrl: string): Promise<void> {
  const childCode = [
    `import { openCyberOsDb } from ${JSON.stringify(moduleUrl)};`,
    "const db = openCyberOsDb(process.argv[1]);",
    "db.close();"
  ].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", childCode, databasePath],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (status === 0) {
        resolve();
      } else {
        reject(new Error(`migration process exited ${status ?? signal}: ${stderr}`));
      }
    });
  });
}

function applyMigrationsThrough(db: Database.Database, finalId: string): void {
  markCyberOsDatabase(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  for (const migration of migrations) {
    const foreignKeysEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
    if (migration.disableForeignKeys) db.pragma("foreign_keys = OFF");
    try {
      migration.prepare?.(db);
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, new Date().toISOString());
    } finally {
      if (migration.disableForeignKeys) db.pragma(`foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
    }
    if (migration.id === finalId) return;
  }
  throw new Error(`Unknown migration ${finalId}`);
}

function markCyberOsDatabase(db: Database.Database): void {
  db.pragma(`user_version = ${CYBEROS_DATABASE_FORMAT_VERSION}`);
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-db-migration-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("SQLite schema migrations", () => {
  it("initializes only blank databases with the CyberOS v2 identity", () => {
    const databasePath = path.join(tempDir, "cyberos.sqlite");
    const database = openCyberOsDb(databasePath);
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(CYBEROS_DATABASE_FORMAT_VERSION);
    } finally {
      database.close();
    }

    const reopened = openCyberOsDbReadOnly(databasePath);
    reopened.close();
  });

  it("rejects an unmarked non-empty database without migrating it", () => {
    const databasePath = path.join(tempDir, "old.sqlite");
    const oldDatabase = new Database(databasePath);
    oldDatabase.exec("CREATE TABLE old_product_data (id TEXT PRIMARY KEY)");
    oldDatabase.close();

    expect(() => openCyberOsDb(databasePath)).toThrow("does not migrate older databases");
    expect(() => openCyberOsDbReadOnly(databasePath)).toThrow("expected CyberOS format 2");

    const unchanged = new Database(databasePath, { readonly: true });
    try {
      expect(unchanged.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"
      ).pluck().all()).toEqual(["old_product_data"]);
    } finally {
      unchanged.close();
    }
  });

  it("keeps migrations in their established order", () => {
    expect(migrations.map((migration) => migration.id)).toEqual([
      "001_initial",
      "002_nas_roots_enabled",
      "003_system_settings",
      "004_pi_sessions_and_tool_approvals",
      "005_docker_management",
      "006_share_management",
      "006a_storage_management",
      "006b_vm_management",
      "007_indexer_status",
      "008_index_failure_root_guard",
      "009_p0_operations",
      "010_index_run_history_archive",
      "011_storage_pool_delete",
      "012_docker_resource_create",
      "013_download_tasks",
      "014_operation_notifications",
      "015_terminal_tabs",
      "016_hostd_config",
      "017_photo_library",
      "018_photo_upload_reservations",
      "019_photo_metadata_index",
      "020_docker_compose_apps",
      "021_vm_direct_actions",
      "022_downloader_reliability",
      "023_photostaff_reliability",
      "024_rust_indexer",
      "025_ops_runs",
      "026_file_batches",
      "027_agent_transcript_sequence",
      "028_monitoring_alerts",
      "029_monitoring_silence_cancellation",
      "030_monitoring_rule_evaluation_status",
      "031_monitoring_unsilenced_event",
      "032_docker_host_access",
      "033_docker_host_access_draft_links",
      "034_mcp_capability_runs",
      "035_mcp_transfer_tokens",
      "036_bluetooth_transfers",
      "037_agent_only_capability_approvals",
      "038_panel_operations_without_agent_jobs",
      "039_media_library",
      "040_media_operation_notifications",
      "041_bluetooth_receive_finalization",
      "042_mcp_resource_tokens",
      "043_agent_job_leases_and_pi_projection"
    ]);
  });

  it("preserves notification and Bluetooth transfer rows through migrations 040 and 041", () => {
    const databasePath = path.join(tempDir, "bluetooth-finalization.sqlite");
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    applyMigrationsThrough(legacy, "039_media_library");
    ensureNasRoots(legacy, [{ id: "local", name: "Local", path: tempDir }]);
    const now = "2026-10-20T00:00:00.000Z";
    legacy.prepare(`
      INSERT INTO operation_notifications (
        id, job_id, session_id, operation_id, kind, status, summary, error, read_at, created_at, updated_at
      ) VALUES ('notification-before-040', NULL, NULL, 'operation-before-040', 'share', 'succeeded',
        'Existing notification', NULL, NULL, ?, ?)
    `).run(now, now);
    legacy.prepare(`
      INSERT INTO bluetooth_transfers (
        id, direction, adapter_id, device_address, root_id, storage_pool_id,
        relative_path, display_name, status, transferred_bytes, total_bytes,
        error, obex_transfer_path, control_requested, read_at, created_at,
        updated_at, started_at, finished_at, last_progress_at
      ) VALUES ('transfer-before-041', 'receive', 'adapter-hci0', 'AA:BB:CC:DD:EE:FF',
        'local', 'pool-1', 'incoming/example.txt', 'example.txt', 'completed', 7, 7,
        NULL, '/org/bluez/obex/transfer1', NULL, NULL, ?, ?, ?, ?, ?)
    `).run(now, now, now, now, now);
    legacy.close();

    const migrated = openCyberOsDb(databasePath);
    try {
      expect(migrated.prepare("SELECT kind, status, summary FROM operation_notifications WHERE id = ?")
        .get("notification-before-040")).toEqual({
        kind: "share",
        status: "succeeded",
        summary: "Existing notification"
      });
      expect(migrated.prepare("SELECT status, relative_path, finalization_relative_path FROM bluetooth_transfers WHERE id = ?")
        .get("transfer-before-041")).toEqual({
        status: "completed",
        relative_path: "incoming/example.txt",
        finalization_relative_path: null
      });

      migrated.prepare(`
        INSERT INTO operation_notifications (
          id, job_id, session_id, operation_id, kind, status, summary, error, read_at, created_at, updated_at
        ) VALUES ('media-notification', NULL, NULL, 'media-operation', 'media', 'failed',
          'Bluetooth audio fallback', 'device unavailable', NULL, ?, ?)
      `).run(now, now);
      migrated.prepare(`
        UPDATE bluetooth_transfers
        SET status = 'finalizing', finalization_relative_path = 'inbox/example.txt'
        WHERE id = 'transfer-before-041'
      `).run();

      expect(migrated.prepare("SELECT kind FROM operation_notifications WHERE id = 'media-notification'").get())
        .toEqual({ kind: "media" });
      expect(migrated.prepare("SELECT status, finalization_relative_path FROM bluetooth_transfers WHERE id = 'transfer-before-041'").get())
        .toEqual({ status: "finalizing", finalization_relative_path: "inbox/example.txt" });
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("preserves legacy history while detaching panel operations from Agent jobs", () => {
    const databasePath = path.join(tempDir, "panel-approval-boundary.sqlite");
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    applyMigrationsThrough(legacy, "036_bluetooth_transfers");
    ensureNasRoots(legacy, [{ id: "local", name: "Local", path: tempDir }]);

    const approvalSession = createSession(legacy, { rootId: "local" });
    const approvalJob = createUserMessageAndJob(legacy, {
      sessionId: approvalSession.id,
      content: "Rename a file",
      status: "waiting_approval"
    }).job;
    const legacyApproval = createPendingApproval(legacy, {
      jobId: approvalJob.id,
      proposal: [{
        operation: "rename",
        rootId: "local",
        sourcePath: "before",
        targetPath: "after",
        risk: "medium",
        reversible: true,
        summary: "Rename before to after"
      }]
    });

    const batchSession = createSession(legacy, { rootId: "local" });
    const batchJob = createUserMessageAndJob(legacy, {
      sessionId: batchSession.id,
      content: "Move selected files",
      status: "running"
    }).job;
    const now = new Date().toISOString();
    legacy.prepare(`
      INSERT INTO file_batches (
        id, job_id, session_id, root_id, storage_pool_id, operation, target_directory,
        total_count, completed_count, success_count, failed_count, cancelled_count,
        current_source_path, created_at, updated_at, finished_at
      ) VALUES ('batch-1', ?, ?, 'local', 'pool-1', 'move', 'archive', 1, 0, 0, 0, 0, NULL, ?, ?, NULL)
    `).run(batchJob.id, batchSession.id, now, now);
    legacy.prepare(`
      INSERT INTO file_batch_items (
        id, batch_id, ordinal, source_path, target_path, trash_entry_id, operation_id,
        status, error, created_at, updated_at
      ) VALUES ('batch-item-1', 'batch-1', 0, 'before.txt', 'archive/before.txt', NULL,
        'batch-operation-1', 'queued', NULL, ?, ?)
    `).run(now, now);

    const consoleSession = createSession(legacy, { rootId: "local" });
    const consoleJob = createUserMessageAndJob(legacy, {
      sessionId: consoleSession.id,
      content: "Open console",
      status: "waiting_approval"
    }).job;
    const legacyConsole = createDockerOperationApproval(legacy, {
      jobId: consoleJob.id,
      proposal: {
        action: "console",
        targetType: "console",
        containerId: "container-1",
        shell: "/bin/sh",
        risk: "high",
        summary: "Open console"
      }
    });
    legacy.prepare("UPDATE pending_approvals SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(now, legacyConsole.approval.id);
    legacy.prepare("UPDATE docker_operations SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(now, legacyConsole.operation.id);
    const legacyAuthorization = createDockerConsoleAuthorization(legacy, {
      operationId: legacyConsole.operation.id,
      approvalId: legacyConsole.approval.id,
      containerId: "container-1",
      shell: "/bin/sh"
    });
    legacy.close();

    const migrated = openCyberOsDb(databasePath);
    try {
      expect(getApproval(migrated, legacyApproval.id)).toMatchObject({ status: "expired" });
      expect(getJob(migrated, approvalJob.id)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Legacy approval expired")
      });
      expect(migrated.prepare("SELECT status, error FROM file_batches WHERE id = 'batch-1'").get())
        .toEqual({ status: "running", error: null });
      expect((migrated.pragma("table_info('file_batches')") as Array<{ name: string }>).map((column) => column.name))
        .not.toEqual(expect.arrayContaining(["job_id", "session_id"]));
      expect(migrated.prepare("SELECT approval_id FROM docker_console_authorizations WHERE id = ?").get(legacyAuthorization.id))
        .toEqual({ approval_id: legacyConsole.approval.id });

      const directOperation = createDockerOperationRecord(migrated, {
        proposal: {
          action: "console",
          targetType: "console",
          containerId: "container-2",
          shell: "/bin/sh",
          risk: "high",
          summary: "Open direct console"
        }
      });
      updateDockerOperationStatus(migrated, directOperation.id, "approved");
      const directAuthorization = createDockerConsoleAuthorization(migrated, {
        operationId: directOperation.id,
        approvalId: null,
        containerId: "container-2",
        shell: "/bin/sh"
      });
      expect(directAuthorization.approvalId).toBeNull();
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("repairs pre-release Host Access draft tables without orphaning approvals", () => {
    const databasePath = path.join(tempDir, "legacy-host-access-drafts.sqlite");
    const legacy = new Database(databasePath);
    markCyberOsDatabase(legacy);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE agent_messages (id TEXT PRIMARY KEY);
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE docker_operations (
        id TEXT PRIMARY KEY,
        approval_id TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE docker_apps (
        id TEXT PRIMARY KEY,
        host_access_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE docker_create_drafts (
        id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        input_json TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        grant_summary_json TEXT NOT NULL DEFAULT '[]',
        fingerprint TEXT NOT NULL,
        image_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_docker_create_drafts_expires_at ON docker_create_drafts(expires_at);

      INSERT INTO jobs(id, status, error, updated_at)
      VALUES ('job-1', 'waiting_approval', NULL, '2026-01-01T00:00:00.000Z');
      INSERT INTO pending_approvals(id, job_id, kind, status, proposal_json, updated_at)
      VALUES (
        'approval-1',
        'job-1',
        'docker_operation',
        'pending',
        '[{"action":"create","hostAccess":{"policyVersion":"legacy"}}]',
        '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO docker_operations(id, approval_id, status, metadata_json, updated_at)
      VALUES ('operation-1', 'approval-1', 'proposed', '{}', '2026-01-01T00:00:00.000Z');
      INSERT INTO docker_create_drafts(
        id, revision, input_json, policy_version, grant_summary_json,
        fingerprint, image_digest, created_at, expires_at
      ) VALUES (
        'draft-1', 'revision-1', '{}', 'legacy', '[]', 'fingerprint',
        'sha256:legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z'
      );
    `);
    const insertMigration = legacy.prepare(
      "INSERT INTO schema_migrations(id, applied_at) VALUES (?, '2026-01-01T00:00:00.000Z')"
    );
    for (const migration of migrations.filter((migration) => migration.id !== "033_docker_host_access_draft_links")) {
      insertMigration.run(migration.id);
    }
    legacy.close();

    const upgraded = openCyberOsDb(databasePath);
    try {
      expect(upgraded.prepare("SELECT status FROM pending_approvals WHERE id = 'approval-1'").pluck().get()).toBe("failed");
      expect(upgraded.prepare("SELECT status FROM docker_operations WHERE id = 'operation-1'").pluck().get()).toBe("failed");
      expect(upgraded.prepare("SELECT status FROM jobs WHERE id = 'job-1'").pluck().get()).toBe("failed");
      expect(upgraded.prepare("SELECT COUNT(*) FROM docker_create_drafts").pluck().get()).toBe(0);
      expect(upgraded.pragma("table_info(docker_create_drafts)")).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "approval_id" }),
        expect.objectContaining({ name: "operation_id" }),
        expect.objectContaining({ name: "job_id" })
      ]));
      expect(upgraded.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'docker_compose_host_access_drafts'"
      ).pluck().get()).toBe("docker_compose_host_access_drafts");
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  it("upgrades the complete pre-release Host Access schema without adding the deployed column twice", () => {
    const databasePath = path.join(tempDir, "complete-host-access-drafts.sqlite");
    const database = openCyberOsDb(databasePath);
    database.prepare("DELETE FROM schema_migrations WHERE id = '033_docker_host_access_draft_links'").run();
    database.close();

    const upgraded = openCyberOsDb(databasePath);
    try {
      const deployedColumns = (upgraded.pragma("table_info(docker_apps)") as Array<{ name: string }>)
        .filter((column) => column.name === "deployed_host_access_json");
      expect(deployedColumns).toHaveLength(1);
      expect(upgraded.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'docker_compose_host_access_drafts'"
      ).pluck().get()).toBe("docker_compose_host_access_drafts");
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  it("installs monitoring alert configuration, incident, and outbox tables", () => {
    const database = openCyberOsDb(path.join(tempDir, "monitoring-alerts.sqlite"));
    try {
      const tables = database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'monitoring_%'
      `).pluck().all();
      expect(tables).toEqual(expect.arrayContaining([
        "monitoring_alert_rules",
        "monitoring_alert_instances",
        "monitoring_alert_incidents",
        "monitoring_alert_silences",
        "monitoring_alert_contacts",
        "monitoring_alert_contact_groups",
        "monitoring_oncall_schedules",
        "monitoring_escalation_policies",
        "monitoring_alert_deliveries",
        "monitoring_alert_delivery_attempts",
        "monitoring_alerter_state"
      ]));
      expect(database.prepare("PRAGMA table_info(monitoring_alert_silences)").all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "cancelled_at" })]));
      expect(database.prepare("PRAGMA table_info(monitoring_alert_rules)").all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "evaluation_error" }),
          expect.objectContaining({ name: "last_evaluated_at" })
        ]));
      const incidentId = "incident-unsilenced-schema";
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO monitoring_alert_incidents(
          id, source, series_key, status, severity, title, firing_at,
          rule_snapshot_json, created_at, updated_at
        ) VALUES (?, 'system', 'schema-check', 'firing', 'warning', 'Schema check', ?, '{}', ?, ?)
      `).run(incidentId, now, now, now);
      expect(() => database.prepare(`
        INSERT INTO monitoring_alert_incident_events(incident_id, type, created_at)
        VALUES (?, 'unsilenced', ?)
      `).run(incidentId, now)).not.toThrow();
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.prepare(
        "SELECT json_extract(value_json, '$.security') FROM system_settings WHERE key = 'monitoring_smtp'"
      ).pluck().get()).toBe("starttls");
    } finally {
      database.close();
    }
  });

  it("upgrades the incident event constraint without losing alert history", () => {
    const databasePath = path.join(tempDir, "monitoring-events-upgrade.sqlite");
    const legacy = new Database(databasePath);
    markCyberOsDatabase(legacy);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE monitoring_alert_incidents (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE monitoring_alert_incident_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id TEXT NOT NULL REFERENCES monitoring_alert_incidents(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('fired', 'acknowledged', 'read', 'recovered', 'rule_changed', 'disabled', 'deleted', 'silenced', 'delivery_succeeded', 'delivery_failed')),
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_monitoring_alert_incident_events_incident
        ON monitoring_alert_incident_events(incident_id, created_at, id);
      INSERT INTO monitoring_alert_incidents(id) VALUES ('incident-legacy');
      INSERT INTO monitoring_alert_incident_events(incident_id, type, created_at)
      VALUES ('incident-legacy', 'fired', '2026-03-10T00:00:00.000Z');
    `);
    const insertMigration = legacy.prepare(
      "INSERT INTO schema_migrations(id, applied_at) VALUES (?, '2026-03-10T00:00:00.000Z')"
    );
    for (const migration of migrations.filter((migration) => migration.id !== "031_monitoring_unsilenced_event")) {
      insertMigration.run(migration.id);
    }
    legacy.close();

    const upgraded = openCyberOsDb(databasePath);
    try {
      expect(upgraded.prepare(`
        SELECT type FROM monitoring_alert_incident_events WHERE incident_id = 'incident-legacy'
      `).pluck().all()).toEqual(["fired"]);
      expect(() => upgraded.prepare(`
        INSERT INTO monitoring_alert_incident_events(incident_id, type, created_at)
        VALUES ('incident-legacy', 'unsilenced', '2026-03-10T00:01:00.000Z')
      `).run()).not.toThrow();
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  it("backfills a deterministic transcript sequence from legacy timestamps", () => {
    const databasePath = path.join(tempDir, "legacy-transcript.sqlite");
    const initial = openCyberOsDb(databasePath);
    const transcriptMigration = migrations.find((migration) => migration.id === "027_agent_transcript_sequence");
    expect(transcriptMigration?.id).toBe("027_agent_transcript_sequence");
    try {
      ensureNasRoots(initial, [{ id: "local", name: "Local", path: tempDir }]);
      initial.exec("DROP TABLE agent_transcript_items");
      initial.prepare("DELETE FROM schema_migrations WHERE id = ?").run(transcriptMigration?.id);
      initial.prepare(`
        INSERT INTO agent_sessions (id, root_id, current_path, created_at, updated_at)
        VALUES ('session-1', 'local', '.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
      const insertMessage = initial.prepare(`
        INSERT INTO agent_messages (id, session_id, role, content, created_at)
        VALUES (?, 'session-1', ?, ?, ?)
      `);
      insertMessage.run("message-offset", "user", "offset", "2026-01-01T08:00:00+08:00");
      insertMessage.run("message-late", "user", "late", "2026-01-01T00:30:00.000Z");
      insertMessage.run("message-tie", "user", "tie", "2026-01-01T09:00:00+08:00");
      insertMessage.run("message-system", "system", "hidden", "2026-01-01T00:45:00.000Z");
      const insertJob = initial.prepare(`
        INSERT INTO jobs (id, session_id, message_id, kind, status, created_at, updated_at)
        VALUES (?, 'session-1', ?, 'agent', 'completed', ?, ?)
      `);
      insertJob.run("job-chat", "message-tie", "2026-01-01T01:00:00.000Z", "2026-01-01T01:00:00.000Z");
      insertJob.run("job-system", "message-system", "2026-01-01T00:45:00.000Z", "2026-01-01T00:45:00.000Z");
      const insertEvent = initial.prepare(`
        INSERT INTO agent_events (id, session_id, job_id, type, payload_json, created_at)
        VALUES (?, 'session-1', ?, ?, ?, ?)
      `);
      insertEvent.run(10, "job-chat", "agent.message", '{"content":"event ten"}', "2026-01-01T01:00:00.000Z");
      insertEvent.run(2, "job-chat", "job.failed", '{"error":"event two"}', "2026-01-01T01:00:00.000Z");
      insertEvent.run(11, "job-chat", "agent.completed", '{}', "2026-01-01T00:15:00.000Z");
      insertEvent.run(12, "job-system", "job.failed", '{"error":"hidden"}', "2026-01-01T00:45:00.000Z");
    } finally {
      initial.close();
    }

    const migrated = openCyberOsDb(databasePath);
    try {
      expect(listTranscriptItems(migrated, { sessionId: "session-1" }).map((item) => ({
        sequence: item.sequence,
        source: item.message?.id ?? item.event?.id
      }))).toEqual([
        { sequence: 1, source: "message-offset" },
        { sequence: 2, source: "message-late" },
        { sequence: 3, source: "message-tie" },
        { sequence: 4, source: 2 },
        { sequence: 5, source: 10 }
      ]);
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
      migrated.prepare(`
        INSERT INTO agent_sessions (id, root_id, current_path, created_at, updated_at)
        VALUES ('session-2', 'local', '.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `).run();
      expect(() => migrated.prepare(`
        UPDATE agent_transcript_items
        SET session_id = 'session-2'
        WHERE message_id = 'message-offset'
      `).run()).toThrow("transcript source/session mismatch");
    } finally {
      migrated.close();
    }

    const reopened = openCyberOsDb(databasePath);
    try {
      expect(listTranscriptItems(reopened, { sessionId: "session-1" })).toHaveLength(5);
      reopened.prepare("DELETE FROM agent_sessions WHERE id = ?").run("session-1");
      expect(reopened.prepare("SELECT COUNT(*) FROM agent_transcript_items").pluck().get()).toBe(0);
    } finally {
      reopened.close();
    }
  });

  it("installs operations runner history and lifecycle indexes", () => {
    const database = openCyberOsDb(path.join(tempDir, "ops-runs.sqlite"));
    try {
      const columns = database.prepare("PRAGMA table_info(ops_runs)").all()
        .map((column) => (column as { name: string }).name);
      expect(columns).toEqual([
        "id",
        "task",
        "status",
        "started_at",
        "heartbeat_at",
        "finished_at",
        "summary_json",
        "error"
      ]);
      const indexes = database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ops_runs'
      `).pluck().all();
      expect(indexes).toEqual(expect.arrayContaining([
        "idx_ops_runs_task_started_at",
        "idx_ops_runs_status_heartbeat"
      ]));
    } finally {
      database.close();
    }
  });

  it("installs the Rust indexer queue, content state, FTS, worker, and root state", () => {
    const database = openCyberOsDb(path.join(tempDir, "rust-indexer.sqlite"));
    try {
      const tables = database.prepare(`
        SELECT name FROM sqlite_master WHERE name LIKE 'index%'
      `).pluck().all();
      expect(tables).toEqual(expect.arrayContaining([
        "index_queue",
        "index_content_state",
        "indexed_content_fts",
        "indexer_workers",
        "index_root_state"
      ]));
      const indexedFileColumns = database.prepare("PRAGMA table_info(indexed_files)").all()
        .map((column) => (column as { name: string }).name);
      expect(indexedFileColumns).toEqual(expect.arrayContaining([
        "storage_pool_id",
        "source_device",
        "source_inode",
        "scan_generation",
        "extraction_source",
        "extraction_status",
        "extraction_error"
      ]));
      expect(database.prepare(`
        SELECT json_extract(value_json, '$.scanConcurrency')
        FROM system_settings WHERE key = 'indexer_settings'
      `).pluck().get()).toBe(4);
    } finally {
      database.close();
    }
  });

  it("installs downloader reliability state, journals, reservations, workers, and claim index", () => {
    const database = openCyberOsDb(path.join(tempDir, "downloader-reliability.sqlite"));
    try {
      const columns = database.prepare("PRAGMA table_info(download_tasks)").all()
        .map((column) => (column as { name: string }).name);
      expect(columns).toEqual(expect.arrayContaining([
        "phase",
        "download_mode",
        "expected_sha256",
        "actual_sha256",
        "error_code",
        "error_retryable",
        "retry_count",
        "next_retry_at",
        "control_requested",
        "segment_count"
      ]));
      const tables = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'download_%'
      `).pluck().all();
      expect(tables).toEqual(expect.arrayContaining([
        "download_segments",
        "download_publish_journal",
        "download_space_reservations",
        "download_workers"
      ]));
      const indexes = database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'download_tasks'
      `).pluck().all();
      expect(indexes).toContain("idx_download_tasks_claim");
    } finally {
      database.close();
    }
  });

  it("serializes concurrent first-start migration runs", async () => {
    const databasePath = path.join(tempDir, "concurrent-startup.sqlite");
    const moduleUrl = pathToFileURL(path.resolve("packages/db/src/index.ts")).href;

    await Promise.all(
      Array.from({ length: 8 }, () => startMigrationProcess(databasePath, moduleUrl))
    );

    const database = openCyberOsDb(databasePath);
    try {
      const columns = database.prepare("PRAGMA table_info(index_runs)").all()
        .map((column) => (column as { name: string }).name);
      expect(columns).toEqual(expect.arrayContaining(["phase", "current_path", "last_progress_at"]));
      expect(database.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBe(migrations.length);
    } finally {
      database.close();
    }
  });

  it("upgrades legacy downloader tasks and partial files without data loss", async () => {
    const databasePath = path.join(tempDir, "legacy-downloader.sqlite");
    const nasRoot = path.join(tempDir, "nas");
    const partialPath = path.join(nasRoot, ".running.part");
    await mkdir(nasRoot);
    await writeFile(partialPath, "abc");
    const legacy = new Database(databasePath);
    markCyberOsDatabase(legacy);
    const appliedAt = "2026-01-01T00:00:00.000Z";
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const recordMigration = legacy.prepare(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
    );
    const reliabilityIndex = migrations.findIndex((item) => item.id === "022_downloader_reliability");
    for (const migration of migrations.slice(0, reliabilityIndex)) {
      legacy.exec(migration.sql);
      recordMigration.run(migration.id, appliedAt);
    }
    legacy.prepare(`
      INSERT INTO nas_roots (id, name, path, created_at, updated_at, enabled)
      VALUES ('local', 'Local', ?, ?, ?, 1)
    `).run(nasRoot, appliedAt, appliedAt);
    const insertTask = legacy.prepare(`
      INSERT INTO download_tasks (
        id, url, root_id, storage_pool_id, target_directory, target_file_name,
        target_path, partial_path, status, received_bytes, total_bytes, error,
        worker_id, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, 'local', ?, '.', ?, ?, ?, ?, ?, 10, ?, ?, ?, ?, ?)
    `);
    for (const status of ["queued", "running", "paused", "failed"] as const) {
      const received = status === "running" ? 3 : 0;
      insertTask.run(
        status,
        `https://example.com/${status}.bin`,
        nasRoot,
        `${status}.bin`,
        `${status}.bin`,
        status === "running" ? ".running.part" : `.${status}.part`,
        status,
        received,
        status === "failed" ? "legacy failure" : null,
        status === "running" ? "node-worker" : null,
        status === "running" ? "2026-01-01T00:00:30.000Z" : null,
        appliedAt,
        appliedAt
      );
    }
    legacy.close();

    const upgraded = openCyberOsDb(databasePath);
    try {
      const rows = upgraded.prepare(`
        SELECT id, status, received_bytes, phase, download_mode, retry_count,
          control_requested, segment_count
        FROM download_tasks ORDER BY id
      `).all() as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        expect.objectContaining({ id: "failed", status: "failed", received_bytes: 0 }),
        expect.objectContaining({ id: "paused", status: "paused", received_bytes: 0 }),
        expect.objectContaining({ id: "queued", status: "queued", received_bytes: 0 }),
        expect.objectContaining({
          id: "running",
          status: "running",
          received_bytes: 3,
          phase: null,
          download_mode: null,
          retry_count: 0,
          control_requested: null,
          segment_count: 0
        })
      ]);
      expect(upgraded.prepare(
        "SELECT 1 FROM schema_migrations WHERE id = '022_downloader_reliability'"
      ).pluck().get()).toBe(1);
      await expect(readFile(partialPath, "utf8")).resolves.toBe("abc");
    } finally {
      upgraded.close();
    }
  });

  it("migrates legacy photo data and indexes to photostaff without data loss", () => {
    const databasePath = path.join(tempDir, "legacy-photostaff.sqlite");
    const legacy = new Database(databasePath);
    markCyberOsDatabase(legacy);
    const appliedAt = "2026-01-01T00:00:00.000Z";
    const libraryUpdatedAt = "2025-12-01T00:00:00.000Z";
    const reliabilityIndex = migrations.findIndex((item) => item.id === "023_photostaff_reliability");
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const recordMigration = legacy.prepare(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
    );
    for (const migration of migrations.slice(0, reliabilityIndex)) {
      legacy.exec(migration.sql);
      recordMigration.run(migration.id, appliedAt);
    }
    legacy.prepare(`
      INSERT INTO nas_roots (id, name, path, created_at, updated_at, enabled)
      VALUES ('local', 'Local', ?, ?, ?, 1)
    `).run(tempDir, appliedAt, appliedAt);
    legacy.prepare(`
      INSERT INTO photo_assets (
        id, root_id, storage_pool_id, path, name, mime_type, size_bytes, mtime_ms,
        content_hash, width, height, orientation, taken_at, taken_at_source,
        thumbnail_key, preview_key, status, error, library_updated_at, indexed_at
      ) VALUES (
        'asset-1', 'local', 'pool-1', 'Photos/legacy.jpg', 'legacy.jpg',
        'image/jpeg', 123, 456, 'legacy-hash', 40, 30, 1, ?, 'exif',
        'thumbnail/legacy.webp', 'preview/legacy.webp', 'ready', NULL, ?, ?
      )
    `).run(appliedAt, libraryUpdatedAt, appliedAt);
    legacy.prepare(`
      INSERT INTO photo_jobs (
        id, kind, status, root_id, storage_pool_id, path, library_updated_at,
        scanned, processed, failed, current_path, error, worker_id,
        lease_expires_at, created_at, updated_at, started_at, finished_at
      ) VALUES (
        'job-1', 'full_scan', 'running', 'local', 'pool-1', 'Photos', ?,
        10, 8, 1, 'Photos/legacy.jpg', NULL, 'node-worker', ?, ?, ?, ?, NULL
      )
    `).run(libraryUpdatedAt, appliedAt, appliedAt, appliedAt, appliedAt);
    legacy.prepare(`
      INSERT INTO photo_upload_reservations
        (id, library_updated_at, content_hash, path, created_at)
      VALUES ('upload-1', ?, 'upload-hash', 'Photos/upload.jpg', ?)
    `).run(libraryUpdatedAt, appliedAt);
    legacy.prepare(`
      INSERT INTO photo_asset_metadata (
        rowid, asset_id, schema_version, status, media_kind, captured_at,
        capture_source, camera_make, camera_model, title, description, rating,
        gps_latitude, gps_longitude, raw_metadata_json, warnings_json, updated_at
      ) VALUES (
        42, 'asset-1', 2, 'ready', 'image', ?, 'exif', 'Sigma', 'fp L',
        'Legacy title', 'Legacy description', 4, 31.2, 121.5, '{}', '[]', ?
      )
    `).run(appliedAt, appliedAt);
    legacy.prepare(`
      INSERT INTO photo_keywords (asset_id, keyword, normalized_keyword)
      VALUES ('asset-1', 'Travel', 'travel')
    `).run();
    legacy.prepare(`
      INSERT INTO photo_metadata_values (
        id, asset_id, source, key, value_type, text_value,
        normalized_text_value, sensitive, ordinal
      ) VALUES (7, 'asset-1', 'xmp', 'xmp.Label', 'text', 'Featured', 'featured', 0, 0)
    `).run();
    legacy.prepare(`
      INSERT INTO photo_metadata_fts (
        rowid, asset_id, name, path, title, description, creator, copyright,
        keywords, camera, lens
      ) VALUES (
        42, 'asset-1', 'legacy.jpg', 'Photos/legacy.jpg', 'Legacy title',
        'Legacy description', '', '', 'Travel', 'Sigma fp L', ''
      )
    `).run();
    legacy.prepare(`
      INSERT INTO photo_geo_index
        (metadata_rowid, min_latitude, max_latitude, min_longitude, max_longitude)
      VALUES (42, 31.2, 31.2, 121.5, 121.5)
    `).run();
    legacy.prepare(`
      INSERT INTO system_settings (key, value_json, updated_at) VALUES
        ('photo_library', ?, ?),
        ('photo_map_settings', ?, ?)
    `).run(
      JSON.stringify({ rootId: "local", storagePoolId: "pool-1", path: "Photos", updatedAt: libraryUpdatedAt }),
      libraryUpdatedAt,
      JSON.stringify({ rootId: "local", storagePoolId: "pool-1", path: "Photos/map.pmtiles", tileType: "png", minZoom: 0, maxZoom: 4, updatedAt: libraryUpdatedAt }),
      libraryUpdatedAt
    );
    legacy.close();

    const upgraded = openCyberOsDb(databasePath);
    try {
      expect(upgraded.prepare("SELECT id, content_hash FROM photostaff_assets").get())
        .toEqual({ id: "asset-1", content_hash: "legacy-hash" });
      expect(upgraded.prepare("SELECT rowid, camera_model FROM photostaff_asset_metadata").get())
        .toEqual({ rowid: 42, camera_model: "fp L" });
      expect(upgraded.prepare("SELECT keyword FROM photostaff_keywords").pluck().get()).toBe("Travel");
      expect(upgraded.prepare("SELECT id, text_value FROM photostaff_metadata_values").get())
        .toEqual({ id: 7, text_value: "Featured" });
      expect(upgraded.prepare("SELECT asset_id FROM photostaff_metadata_fts WHERE photostaff_metadata_fts MATCH 'Legacy'").pluck().all())
        .toEqual(["asset-1"]);
      expect(upgraded.prepare("SELECT metadata_rowid FROM photostaff_geo_index").pluck().all()).toEqual([42]);
      expect(upgraded.prepare("SELECT id FROM photostaff_upload_reservations").pluck().all()).toEqual(["upload-1"]);
      expect(upgraded.prepare(`
        SELECT status, worker_id, lease_expires_at, started_at, scan_generation
        FROM photostaff_jobs WHERE id = 'job-1'
      `).get()).toEqual({
        status: "queued",
        worker_id: null,
        lease_expires_at: null,
        started_at: null,
        scan_generation: "job-1"
      });
      expect(upgraded.prepare("SELECT key FROM system_settings WHERE key LIKE 'photostaff_%_settings' ORDER BY key").pluck().all())
        .toEqual(["photostaff_library_settings", "photostaff_map_settings", "photostaff_processing_settings"]);
      expect(upgraded.prepare("SELECT key FROM system_settings WHERE key IN ('photo_library', 'photo_map_settings')").pluck().all())
        .toEqual([]);
      const legacyTables = upgraded.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'photo_assets', 'photo_jobs', 'photo_upload_reservations',
          'photo_asset_metadata', 'photo_keywords', 'photo_metadata_values',
          'photo_metadata_fts', 'photo_geo_index'
        )
      `).pluck().all();
      expect(legacyTables).toEqual([]);
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  it("retires pending VM approvals and preserves console authorizations for direct actions", () => {
    const databasePath = path.join(tempDir, "vm-direct-actions.sqlite");
    const current = openCyberOsDb(databasePath);
    ensureNasRoots(current, [{ id: "local", name: "Local", path: tempDir }]);
    const session = createSession(current, { rootId: "local" });
    const { job } = createActionMessageAndJob(current, {
      sessionId: session.id,
      content: "Open VM console",
      kind: "vm",
      status: "waiting_approval"
    });
    const { approval, operation } = createVmOperationApproval(current, {
      jobId: job.id,
      proposal: {
        action: "console",
        domainName: "guest",
        domainUuid: "guest-uuid",
        risk: "medium",
        summary: "Open VM console"
      }
    });
    updateApprovalStatus(current, approval.id, "approved");
    updateVmOperationStatus(current, operation.id, "approved");
    const authorization = createVmConsoleAuthorization(current, {
      operationId: operation.id,
      approvalId: approval.id,
      domainName: "guest"
    });

    current.pragma("foreign_keys = OFF");
    current.exec(`
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE vm_console_authorizations RENAME TO vm_console_authorizations_new;
      CREATE TABLE vm_console_authorizations (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES vm_operations(id) ON DELETE CASCADE,
        approval_id TEXT NOT NULL REFERENCES pending_approvals(id) ON DELETE CASCADE,
        domain_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'used', 'expired', 'failed')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      INSERT INTO vm_console_authorizations
      SELECT * FROM vm_console_authorizations_new;
      DROP TABLE vm_console_authorizations_new;
      DELETE FROM schema_migrations WHERE id = '021_vm_direct_actions';
    `);
    current.close();

    const migrated = openCyberOsDb(databasePath);
    try {
      expect(getApproval(migrated, approval.id)?.status).toBe("expired");
      expect(getVmOperation(migrated, operation.id)).toMatchObject({
        status: "failed",
        metadata: expect.objectContaining({ error: expect.stringContaining("execute directly") })
      });
      expect(getJob(migrated, job.id)).toMatchObject({ status: "cancelled", error: expect.stringContaining("execute directly") });
      expect(listOperationNotifications(migrated)).toEqual([
        expect.objectContaining({ jobId: job.id, status: "cancelled", error: expect.stringContaining("execute directly") })
      ]);
      expect(migrated.prepare("SELECT approval_id FROM vm_console_authorizations WHERE id = ?").pluck().get(authorization.id))
        .toBe(approval.id);
      const approvalColumn = migrated.prepare("PRAGMA table_info(vm_console_authorizations)").all()
        .find((column) => (column as { name: string }).name === "approval_id") as { notnull: number };
      expect(approvalColumn.notnull).toBe(0);
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("adds photostaff metadata, scalar, text, and spatial indexes without replacing photostaff assets", () => {
    const databasePath = path.join(tempDir, "photostaff-metadata.sqlite");
    const database = openCyberOsDb(databasePath);
    try {
      const tables = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type IN ('table', 'trigger')
          AND (name LIKE 'photostaff_%' OR name = 'trg_photostaff_asset_metadata_delete_indexes')
      `).pluck().all() as string[];
      expect(tables).toEqual(expect.arrayContaining([
        "photostaff_assets",
        "photostaff_asset_metadata",
        "photostaff_metadata_values",
        "photostaff_metadata_fts",
        "photostaff_geo_index",
        "photostaff_keywords",
        "trg_photostaff_asset_metadata_delete_indexes"
      ]));
    } finally {
      database.close();
    }
  });

  it("adds managed Compose App tables to an existing database without replacing settings", () => {
    const databasePath = path.join(tempDir, "legacy-compose.sqlite");
    const current = openCyberOsDb(databasePath);
    current.prepare(`
      INSERT INTO system_settings (key, value_json, updated_at)
      VALUES ('legacy_test', '{"preserved":true}', ?)
    `).run(new Date().toISOString());
    current.exec(`
      DROP TABLE docker_app_environment;
      DROP TABLE docker_apps;
      DELETE FROM schema_migrations WHERE id = '020_docker_compose_apps';
    `);
    current.close();

    const migrated = openCyberOsDb(databasePath);
    try {
      const tables = migrated.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('docker_apps', 'docker_app_environment')
        ORDER BY name
      `).pluck().all();
      expect(tables).toEqual(["docker_app_environment", "docker_apps"]);
      expect(migrated.prepare("SELECT value_json FROM system_settings WHERE key = 'legacy_test'").pluck().get())
        .toBe('{"preserved":true}');
    } finally {
      migrated.close();
    }
  });

  it("removes the legacy helper socket from persisted share settings", () => {
    const databasePath = path.join(tempDir, "hostd-config.sqlite");
    const current = openCyberOsDb(databasePath);
    current.prepare(
      `INSERT INTO system_settings (key, value_json, updated_at)
       VALUES ('share_settings', ?, ?)`
    ).run(
      JSON.stringify({
        enabled: true,
        helperSocketPath: "/run/cyberos/share-helper.sock",
        account: { username: "share", password: null },
        shares: []
      }),
      new Date().toISOString()
    );
    current.prepare("DELETE FROM schema_migrations WHERE id = '016_hostd_config'").run();
    current.close();

    const migrated = openCyberOsDb(databasePath);
    try {
      const value = migrated
        .prepare("SELECT value_json FROM system_settings WHERE key = 'share_settings'")
        .pluck()
        .get() as string;
      expect(JSON.parse(value)).toEqual({
        enabled: true,
        account: { username: "share", password: null },
        shares: []
      });
    } finally {
      migrated.close();
    }
  });

  it("preserves Docker operations and console foreign keys when adding resource creation", () => {
    const databasePath = path.join(tempDir, "docker-resource-create.sqlite");
    const current = openCyberOsDb(databasePath);
    ensureNasRoots(current, [{ id: "local", name: "Local", path: tempDir }]);
    const session = createSession(current, { rootId: "local" });
    const { job } = createUserMessageAndJob(current, {
      sessionId: session.id,
      content: "Open container console",
      status: "waiting_approval"
    });
    const { approval, operation } = createDockerOperationApproval(current, {
      jobId: job.id,
      proposal: {
        action: "console",
        targetType: "console",
        containerId: "container-1",
        shell: "/bin/sh",
        risk: "high",
        summary: "Open Docker console"
      }
    });
    updateApprovalStatus(current, approval.id, "approved");
    updateDockerOperationStatus(current, operation.id, "approved");
    const authorization = createDockerConsoleAuthorization(current, {
      operationId: operation.id,
      approvalId: approval.id,
      containerId: "container-1",
      shell: "/bin/sh"
    });

    current.pragma("foreign_keys = OFF");
    current.exec(`
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE docker_operations RENAME TO docker_operations_new;
      CREATE TABLE docker_operations (
        id TEXT PRIMARY KEY,
        approval_id TEXT REFERENCES pending_approvals(id) ON DELETE SET NULL,
        action TEXT NOT NULL CHECK (action IN ('start', 'stop', 'restart', 'remove', 'compose_up', 'compose_down', 'compose_pull', 'compose_restart', 'console')),
        target_type TEXT NOT NULL CHECK (target_type IN ('container', 'compose_project', 'console')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO docker_operations
      SELECT * FROM docker_operations_new;
      DROP TABLE docker_operations_new;
      DELETE FROM schema_migrations WHERE id = '012_docker_resource_create';
      PRAGMA legacy_alter_table = OFF;
    `);
    current.close();

    const migrated = openCyberOsDb(databasePath);
    try {
      expect(getDockerOperation(migrated, operation.id)).toMatchObject({
        id: operation.id,
        action: "console",
        targetType: "console",
        targetId: "container-1",
        status: "approved"
      });
      expect(
        migrated
          .prepare("SELECT operation_id FROM docker_console_authorizations WHERE id = ?")
          .get(authorization.id)
      ).toEqual({ operation_id: operation.id });
      expect(migrated.pragma("foreign_key_list('docker_console_authorizations')")).toEqual(
        expect.arrayContaining([expect.objectContaining({ table: "docker_operations" })])
      );
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("migrates legacy approvals through the Docker migration with valid foreign keys", () => {
    const databasePath = path.join(tempDir, "legacy.sqlite");
    const legacyDb = new Database(databasePath);
    markCyberOsDatabase(legacyDb);
    const now = new Date().toISOString();
    legacyDb.pragma("foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (id, applied_at)
      VALUES ('001_initial', '${now}'), ('002_nas_roots_enabled', '${now}'), ('003_system_settings', '${now}'), ('004_pi_sessions_and_tool_approvals', '${now}');

      CREATE TABLE system_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE nas_roots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE RESTRICT,
        current_path TEXT NOT NULL DEFAULT '.',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'applied', 'failed')),
        proposal_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'file_operation'
          CHECK (kind IN ('file_operation', 'pi_tool_call'))
      );
      CREATE TABLE file_operations (
        id TEXT PRIMARY KEY,
        approval_id TEXT REFERENCES pending_approvals(id) ON DELETE SET NULL,
        operation TEXT NOT NULL,
        source_path TEXT,
        target_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'applied', 'rolled_back', 'failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO nas_roots (id, name, path, created_at, updated_at, enabled)
      VALUES ('local', 'Local', '${tempDir}', '${now}', '${now}', 1);
      INSERT INTO agent_sessions (id, root_id, current_path, created_at, updated_at)
      VALUES ('session-1', 'local', '.', '${now}', '${now}');
      INSERT INTO agent_messages (id, session_id, role, content, created_at)
      VALUES ('message-1', 'session-1', 'user', 'edit file', '${now}');
      INSERT INTO jobs (id, session_id, message_id, status, error, created_at, updated_at)
      VALUES ('job-1', 'session-1', 'message-1', 'waiting_approval', NULL, '${now}', '${now}');
      INSERT INTO pending_approvals (id, job_id, status, proposal_json, created_at, updated_at, kind)
      VALUES ('approval-1', 'job-1', 'pending', '[]', '${now}', '${now}', 'file_operation');
      INSERT INTO file_operations (id, approval_id, operation, source_path, target_path, status, metadata_json, created_at, updated_at)
      VALUES ('operation-1', 'approval-1', 'edit', 'hello.txt', NULL, 'proposed', '{}', '${now}', '${now}');
    `);
    legacyDb.close();

    const migrated = openCyberOsDb(databasePath);
    try {
      expect(getApproval(migrated, "approval-1")).toMatchObject({
        id: "approval-1",
        kind: "file_operation"
      });
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
      const { approval } = createDockerOperationApproval(migrated, {
        jobId: "job-1",
        proposal: {
          action: "start",
          targetType: "container",
          containerId: "container-1",
          risk: "medium",
          summary: "Start Docker container media"
        }
      });
      expect(approval.kind).toBe("docker_operation");
    } finally {
      migrated.close();
    }
  });
});
