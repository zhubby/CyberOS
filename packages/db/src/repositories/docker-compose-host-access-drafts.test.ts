import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDockerComposeApp,
  createDockerComposeHostAccessDraft,
  deleteExpiredDockerComposeHostAccessDrafts,
  getDockerComposeHostAccessDraft,
  openCyberOsDb,
  type CyberOsDatabase
} from "../index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-compose-host-access-draft-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("Docker Compose Host Access drafts", () => {
  it("keeps fingerprints in the private draft and deletes expired drafts", () => {
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
    const draft = createDockerComposeHostAccessDraft(db, {
      projectId: app.id,
      composeRevision: app.revision,
      policyVersion: "policy-1",
      imageDigests: [{ service: "collector", digest: "sha256:image" }],
      fingerprints: [{ service: "collector", fingerprint: "private-fingerprint" }],
      expiresAt: "2026-10-19T00:00:00.000Z"
    });
    expect(getDockerComposeHostAccessDraft(db, draft.id)?.fingerprints)
      .toEqual([{ service: "collector", fingerprint: "private-fingerprint" }]);

    expect(deleteExpiredDockerComposeHostAccessDrafts(db, new Date("2026-10-19T00:00:01.000Z"))).toBe(1);
    expect(getDockerComposeHostAccessDraft(db, draft.id)).toBeNull();
  });
});
