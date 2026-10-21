import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeDockerConsoleAuthorization,
  createDockerConsoleAuthorization,
  createSession,
  createUserMessageAndJob,
  ensureNasRoots,
  openZosDb,
  updateApprovalStatus,
  updateDockerOperationStatus,
  type ZosDatabase
} from "./index.js";
import { createDockerOperationApproval } from "./repositories/docker-operations.js";

let tempDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-db-console-"));
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: tempDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("Docker console authorization repository", () => {
  it("only authorizes approved Docker console operations and consumes them once", () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Open container console",
      status: "waiting_approval"
    });
    const { approval, operation } = createDockerOperationApproval(db, {
      jobId: job.id,
      proposal: {
        action: "console",
        targetType: "console",
        containerId: "container-1",
        containerName: "media",
        shell: "/bin/sh",
        risk: "high",
        summary: "Open Docker console for media"
      }
    });

    expect(() =>
      createDockerConsoleAuthorization(db, {
        operationId: operation.id,
        approvalId: approval.id,
        containerId: "container-1",
        shell: "/bin/sh"
      })
    ).toThrow("Approved console operation not found");

    expect(updateApprovalStatus(db, approval.id, "approved", ["pending"])).toBe(true);
    expect(updateDockerOperationStatus(db, operation.id, "approved")).toMatchObject({
      status: "approved"
    });
    const authorization = createDockerConsoleAuthorization(db, {
      operationId: operation.id,
      approvalId: approval.id,
      containerId: "container-1",
      shell: "/bin/sh"
    });

    expect(consumeDockerConsoleAuthorization(db, authorization.id)).toMatchObject({
      id: authorization.id,
      status: "used",
      usedAt: expect.any(String)
    });
    expect(consumeDockerConsoleAuthorization(db, authorization.id)).toBeNull();
  });
});
