import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authenticateMcpClient,
  cancelOwnedCapabilityRun,
  createCapabilityProposal,
  createCapabilityRun,
  createMcpClient,
  decideCapabilityApproval,
  expireCapabilityApprovals,
  getCapabilityApprovalByRun,
  getCapabilityRun,
  listCapabilityRunEvents,
  listOwnedCapabilityRuns,
  listPendingCapabilityApprovals,
  openZosDb,
  revokeMcpClient,
  rotateMcpClientToken,
  transitionCapabilityRun,
  type ZosDatabase
} from "./index.js";

let tempDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-capability-runs-"));
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("MCP clients and capability runs", () => {
  it("stores only a digest and supports rotation", () => {
    const created = createMcpClient(db, {
      name: "Studio Mac",
      kind: "local",
      scopes: ["zos:files:read", "zos:catalog:read"]
    });
    expect(created.token).toMatch(/^zos_mcp_/u);
    const stored = db.prepare("SELECT token_digest, token_prefix FROM mcp_clients WHERE id = ?").get(created.id) as {
      token_digest: string;
      token_prefix: string;
    };
    expect(stored.token_digest).not.toContain(created.token);
    expect(stored.token_digest).toHaveLength(64);
    expect(authenticateMcpClient(db, created.token)?.id).toBe(created.id);

    const rotated = rotateMcpClientToken(db, created.id);
    expect(rotated.token).not.toBe(created.token);
    expect(authenticateMcpClient(db, created.token)).toBeNull();
    expect(authenticateMcpClient(db, rotated.token)?.id).toBe(created.id);
  });

  it("deduplicates runs and rejects an idempotency collision", () => {
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:propose"] });
    const first = createCapabilityRun(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "pi",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { operation: "mkdir", rootId: "primary", path: "Photos" },
      idempotencyKey: "mkdir-photos"
    });
    const repeated = createCapabilityRun(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "pi",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { path: "Photos", rootId: "primary", operation: "mkdir" },
      idempotencyKey: "mkdir-photos"
    });
    expect(repeated.id).toBe(first.id);
    expect(() => createCapabilityRun(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "pi",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { operation: "mkdir", rootId: "primary", path: "Other" },
      idempotencyKey: "mkdir-photos"
    })).toThrow("Idempotency key conflicts");
  });

  it("moves immutable proposals through first-party approval", () => {
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:propose"] });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const pending = createCapabilityProposal(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "pi",
      capabilityId: "zos.files.mutate",
      risk: "critical",
      redactedInput: { device: "wlan0", action: "disconnect" },
      proposal: { target: "wlan0", action: "disconnect", revision: "wifi-r7" },
      requiresConfirmation: true,
      expiresAt
    });
    expect(pending.run.state).toBe("waiting_approval");
    expect(listPendingCapabilityApprovals(db)).toHaveLength(1);
    expect(decideCapabilityApproval(db, {
      approvalId: pending.approval.id,
      expectedRevision: 1,
      decision: "approved",
      decidedBy: "admin"
    })).toBeNull();
    const approved = decideCapabilityApproval(db, {
      approvalId: pending.approval.id,
      expectedRevision: 1,
      decision: "approved",
      decidedBy: "admin",
      confirmed: true
    });
    expect(approved?.run.state).toBe("queued");
    expect(transitionCapabilityRun(db, {
      runId: pending.run.id,
      expectedRevision: approved!.run.revision,
      from: ["queued"],
      to: "running",
      cancellable: false
    })?.state).toBe("running");
    expect(listCapabilityRunEvents(db, pending.run.id).map((event) => event.type)).toEqual([
      "run.created",
      "approval.requested",
      "approval.approved",
      "run.running"
    ]);
  });

  it("rejects capability approvals from external MCP subjects", () => {
    const client = createMcpClient(db, { name: "LAN Agent", kind: "lan", scopes: ["zos:files:propose"] });
    expect(() => createCapabilityProposal(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "lan" as never,
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { operation: "mkdir" },
      proposal: { target: "Archive" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })).toThrow("Only the built-in Pi agent");
    expect(listPendingCapabilityApprovals(db)).toHaveLength(0);
  });

  it("expires pending approvals into a durable terminal run", () => {
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:propose"] });
    const pending = createCapabilityProposal(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "pi",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { operation: "mkdir" },
      proposal: { target: "Archive", revision: "r1" },
      expiresAt: "2026-01-01T00:00:00.000Z"
    });

    expect(expireCapabilityApprovals(db, "2026-01-01T00:00:01.000Z")).toBe(1);
    expect(getCapabilityRun(db, pending.run.id)).toMatchObject({
      state: "expired",
      errorCode: "APPROVAL_EXPIRED",
      cancellable: false,
      expiresAt: "2026-01-01T00:00:00.000Z"
    });
    expect(listPendingCapabilityApprovals(db)).toHaveLength(0);
    expect(listCapabilityRunEvents(db, pending.run.id).map((event) => event.type)).toEqual([
      "run.created",
      "approval.requested",
      "approval.expired",
      "run.expired"
    ]);
    expect(expireCapabilityApprovals(db, "2026-01-01T00:00:02.000Z")).toBe(0);
  });

  it("does not decide an approval after its run leaves the approval state", () => {
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:propose"] });
    const pending = createCapabilityProposal(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "pi",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { operation: "mkdir" },
      proposal: { target: "Archive", revision: "r1" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    db.prepare("UPDATE capability_runs SET state = 'failed' WHERE id = ?").run(pending.run.id);

    expect(decideCapabilityApproval(db, {
      approvalId: pending.approval.id,
      expectedRevision: pending.approval.revision,
      decision: "approved",
      decidedBy: "admin"
    })).toBeNull();
    expect(getCapabilityApprovalByRun(db, pending.run.id)?.status).toBe("pending");
  });

  it("expires pending work when a client is revoked but leaves non-interruptible work running", () => {
    const client = createMcpClient(db, { name: "LAN Agent", kind: "lan", scopes: ["zos:files:propose"] });
    const pending = createCapabilityRun(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "lan",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: {}
    });
    const running = createCapabilityRun(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "lan",
      capabilityId: "zos.files.export-propose",
      risk: "medium",
      redactedInput: {},
      state: "running",
      cancellable: false
    });
    expect(revokeMcpClient(db, client.id)).toBe(true);
    expect(getCapabilityRun(db, pending.id)).toMatchObject({ state: "expired", cancellable: false });
    expect(getCapabilityRun(db, running.id)?.state).toBe("running");
    expect(authenticateMcpClient(db, client.token)).toBeNull();
  });

  it("only lets the owning client cancel interruptible work", () => {
    const owner = createMcpClient(db, { name: "Owner", kind: "local", scopes: ["zos:files:propose"] });
    const other = createMcpClient(db, { name: "Other", kind: "local", scopes: ["zos:files:propose"] });
    const run = createCapabilityRun(db, {
      clientId: owner.id,
      subjectId: owner.id,
      subjectKind: "local",
      capabilityId: "zos.files.export-propose",
      risk: "medium",
      redactedInput: {}
    });
    expect(cancelOwnedCapabilityRun(db, other.id, run.id)).toBeNull();
    expect(cancelOwnedCapabilityRun(db, owner.id, run.id)).toMatchObject({ state: "cancelled", cancellable: false });
  });

  it("paginates runs without skipping equal timestamps", () => {
    const client = createMcpClient(db, { name: "Owner", kind: "local", scopes: ["zos:runs:read"] });
    const runs = ["first", "second", "third"].map((name) => createCapabilityRun(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "local",
      capabilityId: "zos.files.read",
      risk: "read",
      redactedInput: { name }
    }));
    const sharedTimestamp = "2026-10-20T00:00:00.000Z";
    db.prepare("UPDATE capability_runs SET created_at = ?, updated_at = ? WHERE client_id = ?")
      .run(sharedTimestamp, sharedTimestamp, client.id);

    const expected = runs.map((run) => run.id).toSorted().reverse();
    const firstPage = listOwnedCapabilityRuns(db, { clientId: client.id, limit: 2 });
    const secondPage = listOwnedCapabilityRuns(db, {
      clientId: client.id,
      limit: 2,
      before: { createdAt: firstPage[1]!.createdAt, id: firstPage[1]!.id }
    });

    expect([...firstPage, ...secondPage].map((run) => run.id)).toEqual(expected);
  });
});
