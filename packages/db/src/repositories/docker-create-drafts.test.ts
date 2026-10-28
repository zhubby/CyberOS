import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeDockerCreateDraft,
  createActionMessageAndJob,
  createDockerCreateDraft,
  createSession,
  deleteExpiredDockerCreateDrafts,
  ensureNasRoots,
  getApproval,
  getDockerCreateDraft,
  getDockerCreateDraftByApproval,
  getDockerOperation,
  getJob,
  linkDockerCreateDraft
} from "../index.js";
import { createDockerOperationApproval } from "./docker-operations.js";
import { openCyberOsDb, type CyberOsDatabase } from "../index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-docker-draft-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: tempDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("Docker create drafts", () => {
  it("keeps private input out of summaries and consumes a revision once", () => {
    const draft = createDockerCreateDraft(db, {
      input: {
        name: "collector",
        image: "collector:latest",
        environment: { SECRET: "private" },
        hostAccess: [{ capability: "host_processes" }]
      },
      policyVersion: "policy-1",
      grants: [{ capability: "host_processes", risk: "high" }],
      fingerprint: "fingerprint",
      imageDigest: "sha256:image",
      expiresAt: new Date(Date.now() + 60_000)
    });

    expect(getDockerCreateDraft(db, draft.id)?.input.environment).toEqual({ SECRET: "private" });
    expect(consumeDockerCreateDraft(db, draft.id, "wrong")).toBeNull();
    expect(consumeDockerCreateDraft(db, draft.id, draft.revision)?.input.name).toBe("collector");
    expect(getDockerCreateDraft(db, draft.id)).toBeNull();
  });

  it("deletes expired drafts during consumption and startup cleanup", () => {
    const expired = createDockerCreateDraft(db, {
      input: { name: "expired", image: "alpine", hostAccess: [{ capability: "host_sys" }] },
      policyVersion: "policy-1",
      grants: [{ capability: "host_sys", risk: "medium" }],
      fingerprint: "fingerprint",
      imageDigest: "sha256:image",
      expiresAt: new Date(Date.now() - 1_000)
    });
    expect(consumeDockerCreateDraft(db, expired.id, expired.revision)).toBeNull();

    createDockerCreateDraft(db, {
      input: { name: "expired-two", image: "alpine", hostAccess: [{ capability: "host_sys" }] },
      policyVersion: "policy-1",
      grants: [{ capability: "host_sys", risk: "medium" }],
      fingerprint: "fingerprint",
      imageDigest: "sha256:image",
      expiresAt: new Date(Date.now() - 1_000)
    });
    expect(deleteExpiredDockerCreateDrafts(db)).toBe(1);
  });

  it("finds linked drafts privately and expires the approval, operation, and job together", () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createActionMessageAndJob(db, {
      sessionId: session.id,
      content: "Create collector",
      kind: "docker",
      status: "waiting_approval"
    });
    const linked = createDockerOperationApproval(db, {
      jobId: job.id,
      proposal: {
        action: "create",
        targetType: "container",
        containerName: "collector",
        risk: "high",
        summary: "Create collector",
        hostAccess: {
          policyVersion: "policy-1",
          added: [{ capability: "host_processes", risk: "high" }],
          removed: [],
          imageDigests: [{ digest: "sha256:image" }]
        }
      }
    });
    const draft = createDockerCreateDraft(db, {
      input: { name: "collector", image: "alpine", hostAccess: [{ capability: "host_processes" }] },
      policyVersion: "policy-1",
      grants: [{ capability: "host_processes", risk: "high" }],
      fingerprint: "fingerprint",
      imageDigest: "sha256:image",
      expiresAt: "2026-10-19T00:00:00.000Z"
    });
    expect(linkDockerCreateDraft(db, draft.id, draft.revision, {
      approvalId: linked.approval.id,
      operationId: linked.operation.id,
      jobId: job.id
    })).toBe(true);
    expect(getDockerCreateDraftByApproval(db, linked.approval.id)?.id).toBe(draft.id);

    expect(deleteExpiredDockerCreateDrafts(db, new Date("2026-10-19T00:00:01.000Z"))).toBe(1);
    expect(getDockerCreateDraftByApproval(db, linked.approval.id)).toBeNull();
    expect(getApproval(db, linked.approval.id)?.status).toBe("failed");
    expect(getDockerOperation(db, linked.operation.id)?.status).toBe("failed");
    expect(getJob(db, job.id)?.status).toBe("failed");
  });
});
