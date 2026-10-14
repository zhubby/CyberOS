import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  createShareOperationApproval,
  createUserMessageAndJob,
  ensureNasRoots,
  getApproval,
  getShareOperation,
  getShareSettings,
  openZosDb,
  saveShareSettings,
  updateShareOperationStatus,
  type ZosDatabase
} from "./index.js";

let tempDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-db-"));
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: tempDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("operation repositories", () => {
  it("stores and normalizes share settings", () => {
    expect(getShareSettings(db)).toBeNull();

    const saved = saveShareSettings(db, {
      enabled: true,
      account: {
        username: "zos-share",
        password: "secret"
      },
      shares: [
        {
          id: "media",
          name: "Media",
          rootId: "local",
          path: "media",
          description: "Media share",
          protocols: {
            smb: {
              enabled: true,
              readOnly: false,
              browseable: true,
              allowGuest: false
            },
            webdav: {
              enabled: true,
              readOnly: true,
              allowGuest: false,
              port: 8088,
              pathPrefix: "/shares/media"
            },
            ftp: {
              enabled: false,
              readOnly: true,
              allowGuest: false,
              port: 2121,
              passivePortStart: 50000,
              passivePortEnd: 50100
            },
            nfs: {
              enabled: true,
              readOnly: true,
              allowedCidrs: ["192.168.1.0/24"],
              rootSquash: true
            },
            dlna: {
              enabled: true,
              mediaTypes: ["video"],
              bindInterface: "eth0",
              bindAddress: null,
              friendlyName: "Media"
            }
          }
        }
      ]
    });

    expect(saved).toMatchObject({
      enabled: true,
      account: {
        username: "zos-share",
        password: "secret"
      },
      shares: [
        {
          id: "media",
          protocols: {
            smb: {
              readOnly: false
            },
            nfs: {
              allowedCidrs: ["192.168.1.0/24"]
            }
          }
        }
      ]
    });
    expect(getShareSettings(db)).toMatchObject(saved);

    db.prepare("UPDATE system_settings SET value_json = ?, updated_at = ? WHERE key = ?").run(
      JSON.stringify({
        enabled: true,
        account: {
          username: "zos-share"
        },
        shares: [
          {
            id: "legacy",
            rootId: "local",
            path: "."
          }
        ]
      }),
      "2026-01-02T00:00:00.000Z",
      "share_settings"
    );

    expect(getShareSettings(db)).toMatchObject({
      enabled: true,
      account: {
        username: "zos-share",
        password: null
      },
      shares: [
        {
          id: "legacy",
          protocols: {
            smb: {
              enabled: false,
              readOnly: true,
              browseable: true,
              allowGuest: false
            },
            dlna: {
              mediaTypes: ["audio", "video", "pictures"]
            }
          }
        }
      ]
    });
  });

  it("creates share operation approvals without exposing the pending password in the proposal", () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Apply share settings",
      status: "waiting_approval"
    });
    const settings = {
      enabled: true,
      account: {
        username: "zos-share",
        password: "secret"
      },
      shares: [],
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    const { approval, operation } = createShareOperationApproval(db, {
      jobId: job.id,
      settings,
      proposal: {
        action: "apply_settings",
        risk: "high",
        summary: "Apply share services configuration",
        settings: {
          ...settings,
          account: {
            username: "zos-share",
            passwordConfigured: true
          }
        }
      }
    });

    expect(getApproval(db, approval.id)).toMatchObject({
      kind: "share_operation",
      proposal: [
        {
          action: "apply_settings",
          settings: {
            account: {
              username: "zos-share",
              passwordConfigured: true
            }
          }
        }
      ]
    });
    expect(JSON.stringify(getApproval(db, approval.id))).not.toContain("secret");
    expect(getShareOperation(db, operation.id)).toMatchObject({
      approvalId: approval.id,
      action: "apply_settings",
      targetId: "share-settings",
      status: "proposed",
      metadata: {
        settings: {
          account: {
            password: "secret"
          }
        }
      }
    });
    expect(updateShareOperationStatus(db, operation.id, "approved")).toMatchObject({
      status: "approved"
    });
  });
});
