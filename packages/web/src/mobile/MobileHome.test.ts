import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../i18n/index.js";
import { MobileAppLoading, MobileDock, MobileHome } from "./MobileHome.js";
import { WORKSPACE_PANEL_IDS } from "../lib/workspace-panel-settings.js";

beforeAll(async () => { await initI18n(); await i18n.changeLanguage("en"); });

describe("mobile home", () => {
  it("exposes fourteen named app buttons across home and Dock", () => {
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(MobileHome, { connection: "online", unreadCount: 3, approvalCount: 0, onOpenApp: vi.fn(), onOpenNotifications: vi.fn() }),
      createElement(MobileDock, { approvalCount: 2, onOpenApp: vi.fn() })
    ));
    expect(html.match(/data-app-id=/gu)).toHaveLength(14);
    expect(html.match(/data-app-id="files"/gu)).toHaveLength(1);
    expect(html).toContain('aria-label="Open notifications, 3 unread"');
    expect(html).toContain('data-app-id="agent"');
    expect(html).toContain("Connected");
  });

  it("shows an offline connection without claiming the NAS is ready", () => {
    const html = renderToStaticMarkup(createElement(MobileHome, { connection: "offline", unreadCount: 0, approvalCount: 0, onOpenApp: vi.fn(), onOpenNotifications: vi.fn() }));
    expect(html).toContain("Disconnected");
    expect(html).not.toContain(">Connected<");
    expect(html).not.toContain('data-app-id="files"');
  });
});

describe("app module loading", () => {
  it.each([...WORKSPACE_PANEL_IDS, "agent", "settings"] as const)("keeps the %s titlebar and an accessible busy button during a cold load", (app) => {
    const html = renderToStaticMarkup(createElement(MobileAppLoading, { app }));
    const header = html.match(/<header\b[\s\S]*?<\/header>/u)?.[0] ?? "";
    expect(header).toContain("app-titlebar");
    expect(header).toMatch(/<h2[^>]*>[^<]+<\/h2>/u);
    expect(header).toContain('aria-busy="true"');
    expect(header).toContain('aria-label="Loading"');
    expect(html).toContain('class="panel-content-skeleton');
    expect(html).not.toContain('class="mobile-loading-status"');
  });
});
