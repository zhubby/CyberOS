import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeDockerConsoleAuthorization,
  createDockerConsoleAuthorization,
  createDockerOperationRecord,
  openCyberOsDb,
  updateDockerOperationStatus,
  type CyberOsDatabase
} from "./index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-db-console-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("Docker console authorization repository", () => {
  it("only authorizes approved Docker console operations and consumes them once", () => {
    const operation = createDockerOperationRecord(db, {
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
        containerId: "container-1",
        shell: "/bin/sh"
      })
    ).toThrow("Approved console operation not found");

    expect(updateDockerOperationStatus(db, operation.id, "approved")).toMatchObject({
      status: "approved"
    });
    const authorization = createDockerConsoleAuthorization(db, {
      operationId: operation.id,
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
