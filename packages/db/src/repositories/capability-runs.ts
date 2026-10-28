import { createHash, randomUUID } from "node:crypto";
import type { CapabilityErrorCode, CapabilityRisk, CapabilityRunState, JsonValue } from "@cyberos/capabilities";
import type { CyberOsDatabase } from "../connection.js";

export interface CapabilityRunRecord {
  id: string;
  clientId: string | null;
  subjectId: string;
  subjectKind: "pi" | "local" | "lan" | "system";
  capabilityId: string;
  state: CapabilityRunState;
  risk: CapabilityRisk;
  input: JsonValue;
  inputDigest: string;
  idempotencyKey: string | null;
  progress: JsonValue;
  domainOperationType: string | null;
  domainOperationId: string | null;
  result: JsonValue | null;
  errorCode: CapabilityErrorCode | null;
  errorMessage: string | null;
  revision: number;
  cancellable: boolean;
  expiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface CapabilityApprovalRecord {
  id: string;
  runId: string;
  status: "pending" | "approved" | "rejected" | "expired" | "failed";
  proposal: JsonValue;
  risk: Exclude<CapabilityRisk, "read">;
  revision: number;
  requiresConfirmation: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCapabilityApprovalRecord extends CapabilityApprovalRecord {
  run: CapabilityRunRecord;
  sessionId: string;
  jobId: string;
}

interface CapabilityRunRow {
  id: string;
  client_id: string | null;
  subject_id: string;
  subject_kind: CapabilityRunRecord["subjectKind"];
  capability_id: string;
  state: CapabilityRunState;
  risk: CapabilityRisk;
  input_json: string;
  input_digest: string;
  idempotency_key: string | null;
  progress_json: string;
  domain_operation_type: string | null;
  domain_operation_id: string | null;
  result_json: string | null;
  error_code: CapabilityErrorCode | null;
  error_message: string | null;
  revision: number;
  cancellable: 0 | 1;
  expires_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface CapabilityApprovalRow {
  id: string;
  run_id: string;
  status: CapabilityApprovalRecord["status"];
  proposal_json: string;
  risk: CapabilityApprovalRecord["risk"];
  revision: number;
  requires_confirmation: 0 | 1;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

const TERMINAL_STATES: readonly CapabilityRunState[] = ["succeeded", "failed", "cancelled", "expired"];

export function createCapabilityRun(db: CyberOsDatabase, input: {
  clientId?: string | null;
  subjectId: string;
  subjectKind: CapabilityRunRecord["subjectKind"];
  capabilityId: string;
  risk: CapabilityRisk;
  redactedInput: JsonValue;
  idempotencyKey?: string | null;
  state?: Extract<CapabilityRunState, "queued" | "running">;
  cancellable?: boolean;
  expiresAt?: string | null;
}): CapabilityRunRecord {
  const inputJson = stableJson(input.redactedInput);
  if (input.idempotencyKey && input.clientId) {
    const existing = db.prepare(`
      SELECT * FROM capability_runs
      WHERE client_id = ? AND capability_id = ? AND idempotency_key = ?
    `).get(input.clientId, input.capabilityId, input.idempotencyKey) as CapabilityRunRow | undefined;
    if (existing) {
      if (existing.input_digest !== digestJson(inputJson)) throw new Error("Idempotency key conflicts with different input");
      return mapRun(existing);
    }
  }
  const now = new Date().toISOString();
  const run: CapabilityRunRecord = {
    id: randomUUID(),
    clientId: input.clientId ?? null,
    subjectId: input.subjectId,
    subjectKind: input.subjectKind,
    capabilityId: input.capabilityId,
    state: input.state ?? "queued",
    risk: input.risk,
    input: input.redactedInput,
    inputDigest: digestJson(inputJson),
    idempotencyKey: input.idempotencyKey ?? null,
    progress: {},
    domainOperationType: null,
    domainOperationId: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    revision: 1,
    cancellable: input.cancellable ?? true,
    expiresAt: input.expiresAt ?? null,
    createdAt: now,
    startedAt: input.state === "running" ? now : null,
    finishedAt: null,
    updatedAt: now
  };
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO capability_runs (
        id, client_id, subject_id, subject_kind, capability_id, state, risk, input_json, input_digest,
        idempotency_key, progress_json, revision, cancellable, expires_at, created_at, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?, ?, ?, ?)
    `).run(run.id, run.clientId, run.subjectId, run.subjectKind, run.capabilityId, run.state, run.risk,
      inputJson, run.inputDigest, run.idempotencyKey, run.cancellable ? 1 : 0, run.expiresAt, now, run.startedAt, now);
    appendCapabilityRunEvent(db, run.id, "run.created", { state: run.state });
  });
  tx();
  return run;
}

export function createCapabilityProposal(db: CyberOsDatabase, input: {
  clientId?: string | null;
  subjectId: string;
  subjectKind: "pi";
  capabilityId: string;
  risk: Exclude<CapabilityRisk, "read">;
  redactedInput: JsonValue;
  proposal: JsonValue;
  privatePayload?: JsonValue;
  idempotencyKey?: string | null;
  requiresConfirmation?: boolean;
  expiresAt: string;
}): { run: CapabilityRunRecord; approval: CapabilityApprovalRecord } {
  if (input.subjectKind !== "pi") {
    throw new Error("Only the built-in Pi agent can create capability approvals");
  }
  const tx = db.transaction(() => {
    const created = createCapabilityRun(db, {
      clientId: input.clientId ?? null,
      subjectId: input.subjectId,
      subjectKind: input.subjectKind,
      capabilityId: input.capabilityId,
      risk: input.risk,
      redactedInput: input.redactedInput,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      expiresAt: input.expiresAt
    });
    const existingApproval = getCapabilityApprovalByRun(db, created.id);
    if (existingApproval) return { run: getCapabilityRun(db, created.id)!, approval: existingApproval };
    const now = new Date().toISOString();
    const approval: CapabilityApprovalRecord = {
      id: randomUUID(),
      runId: created.id,
      status: "pending",
      proposal: input.proposal,
      risk: input.risk,
      revision: 1,
      requiresConfirmation: input.requiresConfirmation ?? false,
      decidedBy: null,
      decidedAt: null,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now
    };
    db.prepare(`
      INSERT INTO capability_approvals (
        id, run_id, status, proposal_json, risk, revision, requires_confirmation, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'pending', ?, ?, 1, ?, ?, ?, ?)
    `).run(approval.id, approval.runId, stableJson(approval.proposal), approval.risk,
      approval.requiresConfirmation ? 1 : 0, approval.expiresAt, now, now);
    if (input.privatePayload !== undefined) {
      db.prepare(`
        INSERT INTO capability_run_payloads(run_id, payload_json, created_at)
        VALUES (?, ?, ?)
      `).run(created.id, stableJson(input.privatePayload), now);
    }
    db.prepare(`
      UPDATE capability_runs SET state = 'waiting_approval', updated_at = ?, revision = revision + 1
      WHERE id = ? AND state = 'queued'
    `).run(now, created.id);
    appendCapabilityRunEvent(db, created.id, "approval.requested", { approvalId: approval.id, revision: 1 });
    return { run: getCapabilityRun(db, created.id)!, approval };
  });
  return tx();
}

export function getCapabilityRun(db: CyberOsDatabase, runId: string): CapabilityRunRecord | null {
  const row = db.prepare("SELECT * FROM capability_runs WHERE id = ?").get(runId) as CapabilityRunRow | undefined;
  return row ? mapRun(row) : null;
}

export function getOwnedCapabilityRun(db: CyberOsDatabase, clientId: string, runId: string): CapabilityRunRecord | null {
  const row = db.prepare("SELECT * FROM capability_runs WHERE id = ? AND client_id = ?").get(runId, clientId) as CapabilityRunRow | undefined;
  return row ? mapRun(row) : null;
}

export function listOwnedCapabilityRuns(db: CyberOsDatabase, input: {
  clientId: string;
  limit?: number;
  before?: { createdAt: string; id: string };
}): CapabilityRunRecord[] {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const rows = input.before
    ? db.prepare(`
        SELECT * FROM capability_runs
        WHERE client_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(input.clientId, input.before.createdAt, input.before.createdAt, input.before.id, limit)
    : db.prepare(`SELECT * FROM capability_runs WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(input.clientId, limit);
  return (rows as CapabilityRunRow[]).map(mapRun);
}

export function cancelOwnedCapabilityRun(db: CyberOsDatabase, clientId: string, runId: string): CapabilityRunRecord | null {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const result = db.prepare(`
      UPDATE capability_runs
      SET state = 'cancelled', error_code = 'CANCELLED', error_message = 'Cancelled by client',
          cancellable = 0, finished_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND client_id = ? AND cancellable = 1
        AND state IN ('queued', 'running', 'waiting_approval')
    `).run(now, now, runId, clientId);
    if (result.changes !== 1) return null;
    db.prepare(`UPDATE capability_approvals SET status = 'expired', updated_at = ? WHERE run_id = ? AND status = 'pending'`).run(now, runId);
    appendCapabilityRunEvent(db, runId, "run.cancelled", {});
    deleteCapabilityRunPayload(db, runId);
    return getCapabilityRun(db, runId);
  });
  return tx();
}

export function transitionCapabilityRun(db: CyberOsDatabase, input: {
  runId: string;
  expectedRevision: number;
  from: readonly CapabilityRunState[];
  to: CapabilityRunState;
  progress?: JsonValue;
  result?: JsonValue | null;
  errorCode?: CapabilityErrorCode | null;
  errorMessage?: string | null;
  cancellable?: boolean;
  domainOperationType?: string | null;
  domainOperationId?: string | null;
}): CapabilityRunRecord | null {
  const now = new Date().toISOString();
  const terminal = TERMINAL_STATES.includes(input.to);
  const placeholders = input.from.map(() => "?").join(", ");
  const result = db.prepare(`
    UPDATE capability_runs SET
      state = ?, progress_json = COALESCE(?, progress_json), result_json = ?, error_code = ?, error_message = ?,
      cancellable = CASE WHEN ? = 1 THEN 0 ELSE COALESCE(?, cancellable) END,
      domain_operation_type = COALESCE(?, domain_operation_type),
      domain_operation_id = COALESCE(?, domain_operation_id), started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
      finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END, updated_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ? AND state IN (${placeholders})
  `).run(input.to, input.progress === undefined ? null : stableJson(input.progress), input.result === undefined ? null : stableJson(input.result),
    input.errorCode ?? null, input.errorMessage ?? null, terminal ? 1 : 0,
    input.cancellable === undefined ? null : input.cancellable ? 1 : 0,
    input.domainOperationType ?? null, input.domainOperationId ?? null, input.to, now, terminal ? 1 : 0, now, now,
    input.runId, input.expectedRevision, ...input.from);
  if (result.changes !== 1) return null;
  appendCapabilityRunEvent(db, input.runId, `run.${input.to}`, input.progress ?? {});
  return getCapabilityRun(db, input.runId);
}

export function getCapabilityApprovalByRun(db: CyberOsDatabase, runId: string): CapabilityApprovalRecord | null {
  const row = db.prepare("SELECT * FROM capability_approvals WHERE run_id = ?").get(runId) as CapabilityApprovalRow | undefined;
  return row ? mapApproval(row) : null;
}

export function listPendingCapabilityApprovals(db: CyberOsDatabase): Array<CapabilityApprovalRecord & { run: CapabilityRunRecord }> {
  const rows = db.prepare("SELECT * FROM capability_approvals WHERE status = 'pending' ORDER BY created_at, id").all() as CapabilityApprovalRow[];
  return rows.flatMap((row) => {
    const run = getCapabilityRun(db, row.run_id);
    return run ? [{ ...mapApproval(row), run }] : [];
  });
}

export function listPendingAgentCapabilityApprovals(
  db: CyberOsDatabase,
  input: { sessionId?: string } = {}
): AgentCapabilityApprovalRecord[] {
  const rows = db.prepare(`
    SELECT a.*, acr.job_id, j.session_id
    FROM capability_approvals a
    JOIN capability_runs r ON r.id = a.run_id AND r.subject_kind = 'pi'
    JOIN agent_capability_runs acr ON acr.run_id = r.id
    JOIN jobs j ON j.id = acr.job_id AND j.kind = 'agent'
    WHERE a.status = 'pending' AND r.state = 'waiting_approval' AND j.status = 'waiting_approval'
      AND (? IS NULL OR j.session_id = ?)
    ORDER BY a.created_at, a.id
  `).all(input.sessionId ?? null, input.sessionId ?? null) as Array<CapabilityApprovalRow & {
    job_id: string;
    session_id: string;
  }>;
  return rows.flatMap((row) => {
    const run = getCapabilityRun(db, row.run_id);
    return run ? [{ ...mapApproval(row), run, jobId: row.job_id, sessionId: row.session_id }] : [];
  });
}

export function getAgentCapabilityApproval(
  db: CyberOsDatabase,
  approvalId: string
): AgentCapabilityApprovalRecord | null {
  const row = db.prepare(`
    SELECT a.*, acr.job_id, j.session_id
    FROM capability_approvals a
    JOIN capability_runs r ON r.id = a.run_id AND r.subject_kind = 'pi'
    JOIN agent_capability_runs acr ON acr.run_id = r.id
    JOIN jobs j ON j.id = acr.job_id AND j.kind = 'agent'
    WHERE a.id = ?
  `).get(approvalId) as (CapabilityApprovalRow & { job_id: string; session_id: string }) | undefined;
  if (!row) return null;
  const run = getCapabilityRun(db, row.run_id);
  return run ? { ...mapApproval(row), run, jobId: row.job_id, sessionId: row.session_id } : null;
}

export function saveCapabilityRunPayload(db: CyberOsDatabase, runId: string, payload: JsonValue): void {
  db.prepare(`
    INSERT INTO capability_run_payloads(run_id, payload_json, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET payload_json = excluded.payload_json
  `).run(runId, stableJson(payload), new Date().toISOString());
}

export function getCapabilityRunPayload(db: CyberOsDatabase, runId: string): JsonValue | null {
  const value = db.prepare("SELECT payload_json FROM capability_run_payloads WHERE run_id = ?")
    .pluck().get(runId) as string | undefined;
  return value ? JSON.parse(value) as JsonValue : null;
}

export function deleteCapabilityRunPayload(db: CyberOsDatabase, runId: string): boolean {
  return db.prepare("DELETE FROM capability_run_payloads WHERE run_id = ?").run(runId).changes === 1;
}

export function cancelAgentCapabilityRunsForJob(
  db: CyberOsDatabase,
  jobId: string,
  now = new Date().toISOString()
): number {
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT r.id, a.id AS approval_id
      FROM capability_runs r
      JOIN agent_capability_runs acr ON acr.run_id = r.id
      JOIN capability_approvals a ON a.run_id = r.id
      WHERE acr.job_id = ? AND r.state = 'waiting_approval' AND a.status = 'pending'
      ORDER BY r.created_at, r.id
    `).all(jobId) as Array<{ id: string; approval_id: string }>;

    const expireApproval = db.prepare(`
      UPDATE capability_approvals
      SET status = 'expired', updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'pending'
    `);
    const cancelRun = db.prepare(`
      UPDATE capability_runs
      SET state = 'cancelled', error_code = 'CANCELLED', error_message = 'Agent job was cancelled',
          cancellable = 0, finished_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND state = 'waiting_approval'
    `);

    let cancelled = 0;
    for (const row of rows) {
      if (expireApproval.run(now, row.approval_id).changes !== 1) continue;
      if (cancelRun.run(now, now, row.id).changes !== 1) {
        throw new Error(`Capability run ${row.id} changed while cancelling its Agent job`);
      }
      appendCapabilityRunEvent(db, row.id, "approval.expired", {
        approvalId: row.approval_id,
        reason: "job_cancelled"
      });
      appendCapabilityRunEvent(db, row.id, "run.cancelled", { reason: "job_cancelled" });
      deleteCapabilityRunPayload(db, row.id);
      cancelled += 1;
    }
    return cancelled;
  });
  return tx.immediate();
}

export function expireCapabilityApprovals(db: CyberOsDatabase, now = new Date().toISOString()): number {
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT a.id, a.run_id FROM capability_approvals a
      JOIN capability_runs r ON r.id = a.run_id
      WHERE a.status = 'pending' AND a.expires_at <= ? AND r.state = 'waiting_approval'
      ORDER BY a.expires_at, a.id
    `).all(now) as Array<{ id: string; run_id: string }>;
    if (rows.length === 0) return 0;
    const expireApproval = db.prepare(`
      UPDATE capability_approvals
      SET status = 'expired', updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'pending' AND expires_at <= ?
    `);
    const expireRun = db.prepare(`
      UPDATE capability_runs
      SET state = 'expired', error_code = 'APPROVAL_EXPIRED',
        error_message = 'Approval expired before a first-party decision', cancellable = 0,
        finished_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND state = 'waiting_approval'
    `);
    let expired = 0;
    for (const row of rows) {
      if (expireApproval.run(now, row.id, now).changes !== 1) continue;
      if (expireRun.run(now, now, row.run_id).changes !== 1) {
        throw new Error(`Capability run ${row.run_id} changed while expiring its approval`);
      }
      appendCapabilityRunEvent(db, row.run_id, "approval.expired", { approvalId: row.id });
      appendCapabilityRunEvent(db, row.run_id, "run.expired", { reason: "approval_expired" });
      deleteCapabilityRunPayload(db, row.run_id);
      expired += 1;
    }
    return expired;
  });
  return tx.immediate();
}

export function listRunnableCapabilityRuns(db: CyberOsDatabase, limit = 50): CapabilityRunRecord[] {
  const rows = db.prepare(`
    SELECT r.* FROM capability_runs r
    JOIN capability_approvals a ON a.run_id = r.id
    WHERE r.state = 'queued' AND a.status = 'approved'
    ORDER BY r.created_at, r.id LIMIT ?
  `).all(Math.max(1, Math.min(limit, 200))) as CapabilityRunRow[];
  return rows.map(mapRun);
}

export function failInterruptedCapabilityRuns(db: CyberOsDatabase): number {
  const now = new Date().toISOString();
  const rows = db.prepare("SELECT id FROM capability_runs WHERE state = 'running'").all() as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  const tx = db.transaction(() => {
    const update = db.prepare(`
      UPDATE capability_runs SET state = 'failed', error_code = 'INTERNAL',
        error_message = 'Execution was interrupted; destructive operations are not replayed automatically',
        cancellable = 0, finished_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND state = 'running'
    `);
    let changed = 0;
    for (const row of rows) {
      const result = update.run(now, now, row.id);
      if (result.changes === 1) {
        changed += 1;
        appendCapabilityRunEvent(db, row.id, "run.failed", { reason: "interrupted" });
        deleteCapabilityRunPayload(db, row.id);
      }
    }
    return changed;
  });
  return tx();
}

export function decideCapabilityApproval(db: CyberOsDatabase, input: {
  approvalId: string;
  expectedRevision: number;
  decision: "approved" | "rejected";
  decidedBy: string;
  confirmed?: boolean;
  startRunning?: boolean;
}): { approval: CapabilityApprovalRecord; run: CapabilityRunRecord } | null {
  const now = new Date().toISOString();
  expireCapabilityApprovals(db, now);
  const tx = db.transaction(() => {
    const row = db.prepare("SELECT * FROM capability_approvals WHERE id = ?").get(input.approvalId) as CapabilityApprovalRow | undefined;
    if (!row || row.status !== "pending" || row.revision !== input.expectedRevision || row.expires_at <= now) return null;
    if (row.requires_confirmation === 1 && input.decision === "approved" && input.confirmed !== true) return null;
    const run = getCapabilityRun(db, row.run_id);
    if (!run || run.state !== "waiting_approval") return null;
    const result = db.prepare(`
      UPDATE capability_approvals
      SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'pending' AND revision = ?
    `).run(input.decision, input.decidedBy, now, now, row.id, input.expectedRevision);
    if (result.changes !== 1) return null;
    let runResult;
    if (input.decision === "approved") {
      const nextState = input.startRunning === true ? "running" : "queued";
      runResult = db.prepare(`
        UPDATE capability_runs SET state = ?,
          progress_json = CASE WHEN ? = 'running' THEN '{"phase":"executing"}' ELSE progress_json END,
          cancellable = CASE WHEN ? = 'running' THEN 0 ELSE cancellable END,
          started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
          updated_at = ?, revision = revision + 1
        WHERE id = ? AND state = 'waiting_approval'
      `).run(nextState, nextState, nextState, nextState, now, now, row.run_id);
    } else {
      runResult = db.prepare(`
        UPDATE capability_runs SET state = 'failed', error_code = 'APPROVAL_REJECTED',
          error_message = 'Rejected in CyberOS', cancellable = 0,
          finished_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND state = 'waiting_approval'
      `).run(now, now, row.run_id);
    }
    if (runResult.changes !== 1) {
      throw new Error(`Capability run ${row.run_id} changed while deciding its approval`);
    }
    appendCapabilityRunEvent(db, row.run_id, `approval.${input.decision}`, { approvalId: row.id });
    if (input.decision === "approved" && input.startRunning === true) {
      appendCapabilityRunEvent(db, row.run_id, "run.running", { phase: "executing", secretInput: true });
    } else if (input.decision === "rejected") {
      deleteCapabilityRunPayload(db, row.run_id);
    }
    const approval = db.prepare("SELECT * FROM capability_approvals WHERE id = ?").get(row.id) as CapabilityApprovalRow;
    return { approval: mapApproval(approval), run: getCapabilityRun(db, row.run_id)! };
  });
  return tx.immediate();
}

export function linkAgentJobToCapabilityRun(db: CyberOsDatabase, input: { jobId: string; runId: string; providerSessionId?: string | null }): void {
  const eligible = db.prepare(`
    SELECT 1
    FROM jobs j
    JOIN capability_runs r ON r.id = ?
    WHERE j.id = ? AND j.kind = 'agent' AND r.subject_kind = 'pi'
  `).pluck().get(input.runId, input.jobId);
  if (!eligible) throw new Error("Capability approvals can only be linked to a Pi Agent job");
  db.prepare(`
    INSERT INTO agent_capability_runs(job_id, run_id, provider_session_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET provider_session_id = excluded.provider_session_id
  `).run(input.jobId, input.runId, input.providerSessionId ?? null, new Date().toISOString());
}

export function getCapabilityRunForAgentJob(db: CyberOsDatabase, jobId: string): CapabilityRunRecord | null {
  const row = db.prepare(`
    SELECT r.* FROM capability_runs r
    JOIN agent_capability_runs a ON a.run_id = r.id
    WHERE a.job_id = ? ORDER BY a.created_at DESC LIMIT 1
  `).get(jobId) as CapabilityRunRow | undefined;
  return row ? mapRun(row) : null;
}

export function claimNextCapabilityContinuation(
  db: CyberOsDatabase,
  input: { workerId: string; leaseMs: number; now?: Date }
): { jobId: string; runs: CapabilityRunRecord[] } | null {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const leaseUntil = new Date(nowDate.getTime() + input.leaseMs).toISOString();
  const terminalStates = "'succeeded', 'failed', 'cancelled', 'expired'";
  const tx = db.transaction(() => {
    const candidate = db.prepare(`
      SELECT j.id AS job_id
      FROM jobs j
      JOIN agent_capability_runs a ON a.job_id = j.id
      JOIN capability_runs r ON r.id = a.run_id
      WHERE j.kind = 'agent' AND j.status = 'waiting_approval'
        AND r.state IN (${terminalStates})
        AND NOT EXISTS (
          SELECT 1 FROM agent_capability_runs pending_link
          JOIN capability_runs pending_run ON pending_run.id = pending_link.run_id
          WHERE pending_link.job_id = j.id
            AND pending_run.state NOT IN (${terminalStates})
        )
        AND a.run_id = (
          SELECT latest.run_id FROM agent_capability_runs latest
          WHERE latest.job_id = j.id
          ORDER BY latest.created_at DESC, latest.run_id DESC LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs active
          JOIN agent_messages active_message ON active_message.id = active.message_id
          WHERE active.session_id = j.session_id AND active.id <> j.id
            AND active.kind = 'agent' AND active.status = 'running'
            AND active_message.role = 'user'
        )
        AND NOT EXISTS (
          SELECT 1 FROM agent_session_commands active_command
          WHERE active_command.session_id = j.session_id
            AND active_command.status = 'running'
            AND active_command.lease_until > ?
        )
      ORDER BY j.created_at, j.id LIMIT 1
    `).get(now) as { job_id: string } | undefined;
    if (!candidate) return null;
    const updated = db.prepare(`
      UPDATE jobs SET status = 'running', error = NULL, error_code = NULL,
        attempt = attempt + 1, lease_owner = ?, lease_until = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND status = 'waiting_approval'
    `).run(input.workerId, leaseUntil, now, now, candidate.job_id);
    if (updated.changes !== 1) return null;
    const rows = db.prepare(`
      SELECT r.* FROM capability_runs r
      JOIN agent_capability_runs a ON a.run_id = r.id
      WHERE a.job_id = ?
      ORDER BY a.created_at, a.run_id
    `).all(candidate.job_id) as CapabilityRunRow[];
    const runs = rows.map(mapRun);
    return runs.length > 0 ? { jobId: candidate.job_id, runs } : null;
  });
  return tx.immediate();
}

export function listCapabilityRunEvents(db: CyberOsDatabase, runId: string, afterId = 0): Array<{ id: number; type: string; payload: JsonValue; createdAt: string }> {
  const rows = db.prepare(`
    SELECT id, type, payload_json, created_at FROM capability_run_events
    WHERE run_id = ? AND id > ? ORDER BY id LIMIT 500
  `).all(runId, afterId) as Array<{ id: number; type: string; payload_json: string; created_at: string }>;
  return rows.map((row) => ({ id: row.id, type: row.type, payload: JSON.parse(row.payload_json) as JsonValue, createdAt: row.created_at }));
}

function appendCapabilityRunEvent(db: CyberOsDatabase, runId: string, type: string, payload: JsonValue): void {
  db.prepare(`INSERT INTO capability_run_events(run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)`)
    .run(runId, type, stableJson(payload), new Date().toISOString());
}

function stableJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function digestJson(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

function mapRun(row: CapabilityRunRow): CapabilityRunRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    subjectId: row.subject_id,
    subjectKind: row.subject_kind,
    capabilityId: row.capability_id,
    state: row.state,
    risk: row.risk,
    input: JSON.parse(row.input_json) as JsonValue,
    inputDigest: row.input_digest,
    idempotencyKey: row.idempotency_key,
    progress: JSON.parse(row.progress_json) as JsonValue,
    domainOperationType: row.domain_operation_type,
    domainOperationId: row.domain_operation_id,
    result: row.result_json ? JSON.parse(row.result_json) as JsonValue : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    revision: row.revision,
    cancellable: row.cancellable === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  };
}

function mapApproval(row: CapabilityApprovalRow): CapabilityApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    proposal: JSON.parse(row.proposal_json) as JsonValue,
    risk: row.risk,
    revision: row.revision,
    requiresConfirmation: row.requires_confirmation === 1,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
