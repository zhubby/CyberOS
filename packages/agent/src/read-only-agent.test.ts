import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionRecord, NasRootRecord } from "@zos/shared";
import { runReadOnlyAgentTurn, type AgentEmitEvent } from "./read-only-agent.js";

let tempDir: string;
let root: NasRootRecord;
let session: AgentSessionRecord;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-agent-"));
  await mkdir(path.join(tempDir, "docs"));
  await writeFile(path.join(tempDir, "docs", "plan.txt"), "hello");
  root = {
    id: "local",
    name: "Local",
    path: tempDir,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  session = {
    id: "session-1",
    rootId: root.id,
    currentPath: ".",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("read-only agent fallback", () => {
  it("emits tool events and explicit completion", async () => {
    const events: AgentEmitEvent[] = [];

    await runReadOnlyAgentTurn({
      session,
      root,
      message: "What is in this folder?",
      emit: (event) => {
        events.push(event);
      }
    });

    expect(events.map((event) => event.type)).toEqual([
      "agent.started",
      "tool_call.started",
      "tool_call.completed",
      "agent.message",
      "agent.completed"
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      tool: "complete_task",
      shouldContinue: false
    });
  });

  it("uses search_files for natural-language search requests", async () => {
    const events: AgentEmitEvent[] = [];

    await runReadOnlyAgentTurn({
      session,
      root,
      message: "search plan",
      emit: (event) => {
        events.push(event);
      }
    });

    expect(events.find((event) => event.type === "tool_call.started")?.payload).toMatchObject({
      name: "search_files"
    });
  });

  it("uses path-specific tools for read requests", async () => {
    const events: AgentEmitEvent[] = [];

    const result = await runReadOnlyAgentTurn({
      session,
      root,
      message: "preview docs/plan.txt",
      emit: (event) => {
        events.push(event);
      }
    });

    expect(result.status).toBe("completed");
    expect(events.find((event) => event.type === "tool_call.started")?.payload).toMatchObject({
      name: "preview_file"
    });
  });

  it("does not execute mutation requests in the read-only phase", async () => {
    const events: AgentEmitEvent[] = [];

    const result = await runReadOnlyAgentTurn({
      session,
      root,
      message: "rename docs/plan.txt to final.txt",
      emit: (event) => {
        events.push(event);
      }
    });

    expect(result.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual([
      "agent.started",
      "agent.message",
      "agent.completed"
    ]);
    expect(events.at(-1)?.payload.summary).toContain("cannot modify files or create approval requests");
    await expect(readFile(path.join(tempDir, "docs", "plan.txt"), "utf8")).resolves.toBe("hello");
    await expect(readFile(path.join(tempDir, "docs", "final.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
