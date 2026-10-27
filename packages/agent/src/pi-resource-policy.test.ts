import type { AgentSessionRecord } from "@zos/shared";
import { describe, expect, it } from "vitest";
import { PiResourcePolicy } from "./pi-resource-policy.js";

describe("PiResourcePolicy", () => {
  it("blocks project resources by default and never permits arbitrary extensions", () => {
    const policy = new PiResourcePolicy();

    expect(policy.evaluate(session())).toEqual({
      allowProjectSkills: false,
      allowProjectPrompts: false,
      allowProjectContext: false,
      allowUserExtensions: false,
      allowProjectExtensions: false
    });
  });

  it("enables declarative project resources only after explicit trust", () => {
    const policy = new PiResourcePolicy();

    expect(policy.evaluate(session({ piResourcesTrusted: true }))).toEqual({
      allowProjectSkills: true,
      allowProjectPrompts: true,
      allowProjectContext: true,
      allowUserExtensions: false,
      allowProjectExtensions: false
    });
  });
});

function session(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: "session-1",
    rootId: "local",
    currentPath: ".",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    ...overrides
  };
}
