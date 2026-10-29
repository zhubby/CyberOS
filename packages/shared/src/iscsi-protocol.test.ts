import { describe, expect, it } from "vitest";
import { parseHostdResult, type HostdRequest, type HostdResult } from "./hostd-protocol.js";
import type { IscsiAction, IscsiSummary } from "./iscsi.js";

const summary: IscsiSummary = {
  collectedAt: "2026-10-29T03:00:00Z", revision: "b".repeat(64), available: false,
  error: "LIO unavailable", listenAddresses: [], pools: [], targets: [], images: []
};

describe("iSCSI hostd contract", () => {
  it("pairs read and mutation requests with the same validated public snapshot", () => {
    const read = { action: "read" } satisfies HostdRequest<"iscsi.manager">;
    const mutation = { action: "destroy_image", imageId: "160894ff-af2f-415b-83e3-80b8411d7e5e",
      confirmed: true, expectedRevision: summary.revision, confirmation: "Disk" } satisfies IscsiAction & HostdRequest<"iscsi.manager">;
    const readResult: HostdResult<"iscsi.manager", typeof read> | null = parseHostdResult("iscsi.manager", read, summary);
    expect(readResult).toEqual(summary);
    expect(parseHostdResult("iscsi.manager", mutation, summary)).toEqual(summary);
    expect(parseHostdResult("iscsi.manager", read, { ...summary, chapPassword: "secret" })).toBeNull();
  });
});
