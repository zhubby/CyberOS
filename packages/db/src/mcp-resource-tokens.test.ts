import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeMcpResourceToken,
  createMcpClient,
  createMcpResourceToken,
  deleteExpiredMcpResourceTokens,
  openCyberOsDb,
  type CyberOsDatabase
} from "./index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-mcp-resource-token-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("MCP resource tokens", () => {
  it("stores only a token digest and consumes the token once for its client", () => {
    const owner = createMcpClient(db, { name: "Owner", kind: "local", scopes: ["cyberos:files:read"] });
    const other = createMcpClient(db, { name: "Other", kind: "local", scopes: ["cyberos:files:read"] });
    const created = createMcpResourceToken(db, {
      clientId: owner.id,
      kind: "file",
      descriptor: { rootId: "primary", path: "hello.txt" },
      revision: "revision-1",
      mimeType: "text/plain",
      fileName: "hello.txt",
      sizeBytes: 5,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const stored = db.prepare("SELECT token_digest, descriptor_json FROM mcp_resource_tokens").get() as {
      token_digest: string;
      descriptor_json: string;
    };
    expect(stored.token_digest).toHaveLength(64);
    expect(stored.token_digest).not.toContain(created.token);
    expect(stored.descriptor_json).toBe('{"rootId":"primary","path":"hello.txt"}');
    expect(consumeMcpResourceToken(db, { token: created.token, clientId: other.id })).toBeNull();
    expect(consumeMcpResourceToken(db, { token: created.token, clientId: owner.id })).toMatchObject({
      clientId: owner.id,
      kind: "file",
      usedAt: expect.any(String)
    });
    expect(consumeMcpResourceToken(db, { token: created.token, clientId: owner.id })).toBeNull();
  });

  it("rejects expired tokens and deletes terminal token rows", () => {
    const owner = createMcpClient(db, { name: "Owner", kind: "local", scopes: ["cyberos:files:read"] });
    const created = createMcpResourceToken(db, {
      clientId: owner.id,
      kind: "file_export",
      descriptor: { rootId: "primary", paths: ["hello.txt"] },
      revision: "revision-2",
      mimeType: "application/zip",
      fileName: "files.zip",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });

    expect(consumeMcpResourceToken(db, {
      token: created.token,
      clientId: owner.id,
      now: "2099-01-01T00:00:00.000Z"
    })).toBeNull();
    expect(deleteExpiredMcpResourceTokens(db, "2099-01-01T00:00:00.000Z")).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM mcp_resource_tokens").pluck().get()).toBe(0);
  });
});
