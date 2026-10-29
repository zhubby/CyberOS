import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentMcpServer,
  createAgentSkill,
  deleteAgentMcpServer,
  deleteAgentSkill,
  getAgentResourceGeneration,
  listAgentMcpServers,
  listAgentSkills,
  openCyberOsDb,
  updateAgentMcpServer,
  updateAgentSkill,
  type CyberOsDatabase
} from "./index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-agent-resources-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("agent resource repositories", () => {
  it("tracks MCP CRUD with a monotonic shared generation", () => {
    const initialGeneration = getAgentResourceGeneration(db);
    const created = createAgentMcpServer(db, mcpInput("home-assistant"));
    expect(created.generation).toBe(initialGeneration + 1);
    expect(listAgentMcpServers(db)).toEqual([created]);

    const updated = updateAgentMcpServer(db, created.id, {
      ...mcpInput("home-assistant"),
      enabled: true,
      testStatus: "ready",
      toolCount: 4,
      trustedAt: new Date().toISOString()
    });
    expect(updated?.generation).toBe(initialGeneration + 2);
    expect(deleteAgentMcpServer(db, created.id)).toBe(true);
    expect(getAgentResourceGeneration(db)).toBe(initialGeneration + 3);
    expect(listAgentMcpServers(db)).toEqual([]);
  });

  it("enforces case-insensitive names across MCP servers and Skills", () => {
    createAgentMcpServer(db, mcpInput("home-assistant"));
    expect(() => createAgentMcpServer(db, mcpInput("HOME-ASSISTANT"))).toThrow(/UNIQUE constraint failed/u);

    const skill = createAgentSkill(db, skillInput("ops-review"));
    expect(() => createAgentSkill(db, skillInput("OPS-REVIEW"))).toThrow(/UNIQUE constraint failed/u);
    expect(updateAgentSkill(db, skill.id, { ...skillInput("ops-review"), enabled: true })?.enabled).toBe(true);
    expect(deleteAgentSkill(db, skill.id)).toBe(true);
    expect(listAgentSkills(db)).toEqual([]);
  });
});

function mcpInput(name: string) {
  return {
    name,
    description: "Local automation",
    url: "http://127.0.0.1:8123/mcp",
    timeoutSeconds: 30,
    exposure: "codemode" as const,
    authMode: "none" as const,
    allowInsecureHttp: true
  };
}

function skillInput(name: string) {
  return {
    name,
    description: "Operational review workflow",
    version: "1.0.0",
    sourceType: "git" as const,
    sourceUrl: "https://example.com/skills.git",
    sourceRef: "main",
    sourceSubdirectory: null,
    sourceStoragePoolId: null,
    sourcePath: null,
    resolvedCommit: "a".repeat(40),
    digest: "b".repeat(64),
    enabled: false,
    diagnostics: []
  };
}
