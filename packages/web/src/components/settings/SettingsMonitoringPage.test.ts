import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsMonitoringContent } from "./SettingsMonitoringPage.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("SettingsMonitoringContent", () => {
  it("renders the monitoring switch, retention limits, and database ceiling", () => {
    const html = renderToStaticMarkup(createElement(SettingsMonitoringContent, {
      form: {
        enabled: true,
        rawRetentionDays: 7,
        minuteRetentionDays: 30,
        hourRetentionDays: 365,
        maxDatabaseBytes: 512 * 1024 * 1024,
        updatedAt: "2026-10-29T00:00:00.000Z"
      },
      busy: false,
      error: null,
      onFormChange: vi.fn(),
      onSubmit: vi.fn()
    }));

    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(html).toContain("Raw retention (days)");
    expect(html).toContain('value="7"');
    expect(html).toContain('value="30"');
    expect(html).toContain('value="365"');
    expect(html).toContain('value="512"');
    expect(html).toContain('min="1" max="14"');
    expect(html).toContain('min="7" max="180"');
    expect(html).toContain('min="30" max="1825"');
    expect(html).toContain('min="16" max="16384"');
  });
});
