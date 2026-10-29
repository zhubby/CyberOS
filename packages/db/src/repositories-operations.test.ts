import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createShareOperationRecord,
  getShareOperation,
  getShareSettings,
  openCyberOsDb,
  saveShareSettings,
  updateShareOperationStatus,
  type CyberOsDatabase
} from "./index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-db-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
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
        username: "cyberos-share",
        password: "secret"
      },
      shares: [
        {
          id: "media",
          name: "Media",
          storagePoolId: "local",
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
        username: "cyberos-share",
        password: null
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
          username: "cyberos-share"
        },
        shares: [
          {
            id: "incomplete",
            storagePoolId: "local",
            path: "."
          }
        ]
      }),
      "2026-01-02T00:00:00.000Z",
      "share_settings"
    );

    expect(() => getShareSettings(db)).toThrow("CyberOS 2.0 format");
  });

  it("keeps the pending password out of the public share proposal", () => {
    const settings = {
      enabled: true,
      account: {
        username: "cyberos-share",
        password: "secret"
      },
      shares: [],
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    const operation = createShareOperationRecord(db, {
      settings,
      proposal: {
        action: "apply_settings",
        risk: "high",
        summary: "Apply share services configuration",
        settings: {
          ...settings,
          account: {
            username: "cyberos-share",
            passwordConfigured: true
          }
        }
      }
    });

    expect(JSON.stringify(operation.metadata.proposal)).not.toContain("secret");
    expect(getShareOperation(db, operation.id)).toMatchObject({
      action: "apply_settings",
      targetId: "share-settings",
      status: "proposed",
      metadata: {
        settings: {
          account: {
            password: null
          }
        }
      }
    });
    expect(JSON.stringify(getShareOperation(db, operation.id)?.metadata)).not.toContain("secret");
    expect(updateShareOperationStatus(db, operation.id, "approved")).toMatchObject({
      status: "approved"
    });
  });
});
