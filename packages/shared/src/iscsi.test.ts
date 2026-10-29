import { describe, expect, it } from "vitest";
import { parseIscsiAction, parseIscsiSummary, type IscsiSummary } from "./iscsi.js";

const targetId = "fe5925a1-f084-411e-af49-4ed4c80fe205";
const imageId = "5b58872e-16c2-4ef1-a3df-93e4b1a82416";
const base = { confirmed: true, expectedRevision: "a".repeat(64) };
const create = {
  ...base, action: "create_target", name: "Windows disk", address: "192.168.1.5", port: 3260,
  enabled: true, initiators: ["iqn.1991-05.com.microsoft:desktop"],
  chap: { enabled: true, username: "storage", password: "123456789012" }
};

export const iscsiSummaryFixture: IscsiSummary = {
  collectedAt: "2026-10-29T02:00:00Z", revision: "a".repeat(64), available: true, error: null,
  listenAddresses: ["192.168.1.5"],
  pools: [{ id: "pool-1", name: "pool-1", availableBytes: 10 * 1024 ** 3, ready: true }],
  targets: [{ id: targetId, name: "Windows disk", iqn: `iqn.2026-10.local.cyberos:${targetId}`,
    address: "192.168.1.5", port: 3260, enabled: true, chapEnabled: true, chapUsername: "storage",
    credentialConfigured: true, initiators: create.initiators, status: "running", error: null,
    luns: [{ imageId, lun: 0 }], sessions: [{ initiator: create.initiators[0]!, address: "192.168.1.10" }] }],
  images: [{ id: imageId, name: "Disk 1", storagePoolId: "pool-1", sizeBytes: 1024 ** 3, attachedTargetId: targetId }]
};

describe("iSCSI public contracts", () => {
  it("accepts every supported management action", () => {
    const actions = [create,
      { ...base, action: "update_target", targetId, name: create.name, address: create.address,
        port: create.port, initiators: create.initiators, chap: create.chap },
      { ...base, action: "set_target_enabled", targetId, enabled: false },
      { ...base, action: "delete_target", targetId, destroyImages: false },
      { ...base, action: "create_lun", targetId, name: "Disk 1", storagePoolId: "pool-1", sizeBytes: 1024 ** 3 },
      { ...base, action: "attach_lun", targetId, imageId },
      { ...base, action: "detach_lun", targetId, imageId, destroyImage: false },
      { ...base, action: "destroy_image", imageId, confirmation: "Disk 1" }
    ];
    for (const action of actions) expect(parseIscsiAction(action)).toEqual(action);
  });

  it("rejects missing approval, stale-shaped revision, unknown fields and destructive actions without confirmation", () => {
    for (const value of [null, {}, { ...create, confirmed: false }, { ...create, expectedRevision: "old" },
      { ...create, command: "arbitrary" }, { ...create, initiators: [] }, { ...create, chap: { ...create.chap, password: "short" } },
      { ...base, action: "delete_target", targetId, destroyImages: true },
      { ...base, action: "attach_lun", targetId: "../bad", imageId },
      { ...base, action: "create_lun", targetId, name: "Disk", storagePoolId: "../pool", sizeBytes: 1024 ** 3 },
      { ...base, action: "create_lun", targetId, name: "Disk", storagePoolId: "pool-1", sizeBytes: 512 }
    ]) expect(parseIscsiAction(value)).toBeNull();
  });

  it("accepts snapshots and refuses leaked credentials or malformed nested objects", () => {
    expect(parseIscsiSummary(iscsiSummaryFixture)).toEqual(iscsiSummaryFixture);
    expect(parseIscsiSummary({ ...iscsiSummaryFixture, password: "secret" })).toBeNull();
    expect(parseIscsiSummary({ ...iscsiSummaryFixture, targets: [{ ...iscsiSummaryFixture.targets[0], password: "secret" }] })).toBeNull();
    expect(parseIscsiSummary({ ...iscsiSummaryFixture, images: [{ ...iscsiSummaryFixture.images[0], sizeBytes: -1 }] })).toBeNull();
    expect(parseIscsiSummary({ ...iscsiSummaryFixture, targets: [{ ...iscsiSummaryFixture.targets[0], sessions: [{ initiator: 42 }] }] })).toBeNull();
  });
});
