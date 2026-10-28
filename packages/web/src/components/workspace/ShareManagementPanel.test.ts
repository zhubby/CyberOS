import { describe, expect, it } from "vitest";
import type { ShareSummary } from "../../api.js";
import { shareStatusDetail, shareStatusLabel, shareStatusTone } from "./ShareManagementPanel.js";

const translate = (key: string) => key;
const summary: ShareSummary = {
  collectedAt: "2026-09-22T00:00:00.000Z",
  enabled: true,
  settingsUpdatedAt: "2026-09-22T00:00:00.000Z",
  capabilities: { canApplyConfiguration: true, hostMutationPolicy: "mutable" },
  metrics: { shares: 1, enabledProtocols: 5, authenticatedProtocols: 3 },
  protocols: {
    smb: { protocol: "smb", enabledShares: 1, services: [{ name: "smbd.service", status: "active", error: null }] },
    webdav: { protocol: "webdav", enabledShares: 1, services: [{ name: "cyberos-webdav.service", status: "active", error: null }] },
    ftp: { protocol: "ftp", enabledShares: 1, services: [{ name: "vsftpd.service", status: "active", error: null }] },
    nfs: { protocol: "nfs", enabledShares: 1, services: [{ name: "nfs-server.service", status: "active", error: null }] },
    dlna: { protocol: "dlna", enabledShares: 1, services: [{ name: "minidlna.service", status: "active", error: null }] }
  },
  shares: [],
  issues: []
};

describe("share panel status", () => {
  it("keeps the saved service status when a form validation fails", () => {
    const validationError = "Share account password is required";
    expect(shareStatusTone(summary, false, validationError)).toBe("ready");
    expect(shareStatusLabel(summary, false, validationError, translate))
      .toBe("workspace.management.shares.states.enabled");
    expect(shareStatusDetail(summary, false, validationError, translate))
      .toBe("workspace.management.shares.readyDetail");
  });

  it("reports a real loading failure when no service summary is available", () => {
    expect(shareStatusTone(null, false, "Failed to fetch")).toBe("warning");
    expect(shareStatusLabel(null, false, "Failed to fetch", translate))
      .toBe("common.states.unavailable");
    expect(shareStatusDetail(null, false, "Failed to fetch", translate)).toBe("Failed to fetch");
  });

  it("warns when an enabled protocol has an inactive host service", () => {
    const inactiveSummary: ShareSummary = {
      ...summary,
      protocols: {
        ...summary.protocols,
        smb: {
          ...summary.protocols.smb,
          services: [{ name: "smbd.service", status: "inactive", error: null }]
        }
      }
    };

    expect(shareStatusTone(inactiveSummary, false, null)).toBe("warning");
    expect(shareStatusLabel(inactiveSummary, false, null, translate))
      .toBe("workspace.management.shares.states.enabled");
    expect(shareStatusDetail(inactiveSummary, false, null, translate))
      .toBe("workspace.management.shares.partialDetail");
  });
});
