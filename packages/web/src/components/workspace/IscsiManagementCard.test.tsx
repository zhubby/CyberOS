import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { IscsiSummary } from "@cyberos/shared";
import { i18n, initI18n } from "../../i18n/index.js";
import { IscsiInventory } from "./IscsiManagementCard.js";

beforeAll(async () => { await initI18n(); await i18n.changeLanguage("en"); });

describe("iSCSI inventory", () => {
  const summary: IscsiSummary = {
    collectedAt: "2026-10-29T00:00:00Z", revision: "a".repeat(64), available: true, error: null,
    listenAddresses: ["192.168.1.2"], pools: [],
    targets: [{ id: "target", name: "Windows disk", iqn: "iqn.2026-10.local.cyberos:one", address: "192.168.1.2", port: 3260, enabled: true, chapEnabled: true, chapUsername: "client", credentialConfigured: true, initiators: ["iqn.2026-10.local.client:one"], status: "running", error: null, luns: [{ imageId: "attached", lun: 0 }], sessions: [{ initiator: "iqn.2026-10.local.client:one", address: "192.168.1.3" }] }],
    images: [{ id: "attached", name: "Data", storagePoolId: "pool", sizeBytes: 1024 ** 3, attachedTargetId: "target" }, { id: "retained", name: "Retained disk", storagePoolId: "pool", sizeBytes: 1024 ** 3, attachedTargetId: null }]
  };
  it("shows target connection identity and retained images without exposing credentials", () => {
    const html = renderToStaticMarkup(createElement(IscsiInventory, { summary, busy: false, locale: "en", onSelectTarget: () => undefined, onSelectImage: () => undefined }));
    expect(html).toContain("Windows disk");
    expect(html).toContain("iqn.2026-10.local.cyberos:one");
    expect(html).toContain("192.168.1.2:3260");
    expect(html).toContain("Retained disk");
    expect(html).toContain("Retained images");
    expect(html).toContain("1 sessions");
    expect(html).not.toContain("client");
  });
  it("keeps unavailable inventory visible and disables changes", () => {
    const html = renderToStaticMarkup(createElement(IscsiInventory, { summary: { ...summary, available: false }, busy: false, locale: "en", onSelectTarget: () => undefined, onSelectImage: () => undefined }));
    expect(html).toContain("Retained disk");
    expect(html).toContain('disabled=""');
  });
});
