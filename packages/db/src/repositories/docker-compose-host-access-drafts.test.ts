import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createActionMessageAndJob,
  createDockerComposeApp,
  createDockerComposeHostAccessDraft,
  createSession,
  deleteExpiredDockerComposeHostAccessDrafts,
  ensureNasRoots,
  getApproval,
  getDockerComposeHostAccessDraftByApproval,
  getDockerOperation,
  getJob,
  linkDockerComposeHostAccessDraft,
  openCyberOsDb,
  type CyberOsDatabase
} from "../index.js";
import { createDockerOperationApproval } from "./docker-operations.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-compose-host-access-draft-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: tempDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("Docker Compose Host Access drafts", () => {
  it("keeps fingerprints private and expires all linked approval state", () => {
    const app = createDockerComposeApp(db, {
      name: "Collector",
      projectKey: "collector",
      composeContent: "services:\n  collector:\n    image: alpine\n",
      environment: [],
      services: ["collector"],
      warnings: [],
      risk: "high",
      hostAccess: [{ service: "collector", grants: [{ capability: "host_processes" }] }]
    });
    const session = createSession(db, { rootId: "local" });
    const { job } = createActionMessageAndJob(db, {
      sessionId: session.id,
      content: "Deploy Collector",
      kind: "docker",
      status: "waiting_approval"
    });
    const linked = createDockerOperationApproval(db, {
      jobId: job.id,
      proposal: {
        action: "compose_up",
        targetType: "compose_project",
        composeProjectId: app.id,
        composeProjectName: app.name,
        composeRevision: app.revision,
        risk: "high",
        summary: "Deploy Collector",
        hostAccess: {
          policyVersion: "policy-1",
          added: [{ service: "collector", capability: "host_processes", risk: "high" }],
          removed: [],
          imageDigests: [{ service: "collector", digest: "sha256:image" }]
        }
      }
    });
    const draft = createDockerComposeHostAccessDraft(db, {
      projectId: app.id,
      composeRevision: app.revision,
      policyVersion: "policy-1",
      imageDigests: [{ service: "collector", digest: "sha256:image" }],
      fingerprints: [{ service: "collector", fingerprint: "private-fingerprint" }],
      expiresAt: "2026-10-19T00:00:00.000Z"
    });
    expect(linkDockerComposeHostAccessDraft(db, draft.id, draft.revision, {
      approvalId: linked.approval.id,
      operationId: linked.operation.id,
      jobId: job.id
    })).toBe(true);
    expect(getDockerComposeHostAccessDraftByApproval(db, linked.approval.id)?.fingerprints)
      .toEqual([{ service: "collector", fingerprint: "private-fingerprint" }]);
    expect(JSON.stringify(getApproval(db, linked.approval.id))).not.toContain("private-fingerprint");

    expect(deleteExpiredDockerComposeHostAccessDrafts(db, new Date("2026-10-19T00:00:01.000Z"))).toBe(1);
    expect(getDockerComposeHostAccessDraftByApproval(db, linked.approval.id)).toBeNull();
    expect(getApproval(db, linked.approval.id)?.status).toBe("failed");
    expect(getDockerOperation(db, linked.operation.id)?.status).toBe("failed");
    expect(getJob(db, job.id)?.status).toBe("failed");
  });
});
