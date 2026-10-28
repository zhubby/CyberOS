import { describe, expect, it } from "vitest";
import type { ShareSettingsRecord } from "@cyberos/shared";
import { collectShareSummary } from "./share-service.js";

describe("share service status", () => {
  it("reports the dedicated WebDAV service rather than the host's default Apache", async () => {
    const queried: string[] = [];
    const settings: ShareSettingsRecord = {
      enabled: true,
      account: { username: "cyberos-share", password: null },
      updatedAt: "2026-09-22T00:00:00.000Z",
      shares: [{
        id: "shares",
        name: "Shares",
        storagePoolId: "pool-1",
        path: "pool1/Shares",
        description: "",
        protocols: {
          smb: { enabled: false, readOnly: true, browseable: true, allowGuest: false },
          webdav: { enabled: true, readOnly: false, allowGuest: false, port: 8088, pathPrefix: "/shares/shares" },
          ftp: { enabled: false, readOnly: true, allowGuest: false, port: 2121, passivePortStart: 50000, passivePortEnd: 50100 },
          nfs: { enabled: false, readOnly: true, allowedCidrs: [], rootSquash: true },
          dlna: { enabled: false, mediaTypes: ["audio"], bindInterface: "eth0", bindAddress: null, friendlyName: "Shares" }
        }
      }]
    };

    const summary = await collectShareSummary(settings, {
      commandRunner: {
        async run(command, args) {
          expect(command).toBe("systemctl");
          queried.push(args[1]!);
          return "active\n";
        }
      }
    });

    expect(queried).toContain("cyberos-webdav.service");
    expect(queried).not.toContain("apache2.service");
    expect(summary.protocols.webdav.services).toEqual([
      { name: "cyberos-webdav.service", status: "active", error: null }
    ]);
    expect(summary.capabilities).toEqual({
      canApplyConfiguration: true,
      hostMutationPolicy: "mutable"
    });
  });

  it("reports declarative share configuration as read-only", async () => {
    const summary = await collectShareSummary({
      enabled: false,
      account: { username: "cyberos-share", password: null },
      updatedAt: "2026-09-22T00:00:00.000Z",
      shares: []
    }, { mutationPolicy: "declarative" });

    expect(summary.capabilities).toEqual({
      canApplyConfiguration: false,
      hostMutationPolicy: "declarative"
    });
  });
});
