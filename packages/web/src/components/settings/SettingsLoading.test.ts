import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsSystemProfilePage } from "./SettingsSystemProfilePage.js";
import { SettingsMonitoringPage } from "./SettingsMonitoringPage.js";
import { SettingsBackupPage } from "./SettingsBackupPage.js";
import { SettingsSharesPage } from "./SettingsSharesPage.js";
import { SettingsAlertsPage } from "./SettingsAlertsPage.js";
import { SettingsSkillsPage } from "./SettingsSkillsPage.js";
import { SettingsMcpPage } from "./SettingsMcpPage.js";

beforeAll(async () => { await initI18n(); await i18n.changeLanguage("en"); });

const pages: [string, ReactElement][] = [
  ["system profile", createElement(SettingsSystemProfilePage)],
  ["monitoring", createElement(SettingsMonitoringPage)],
  ["backup", createElement(SettingsBackupPage, { locale: "en" })],
  ["shares", createElement(SettingsSharesPage, { onNotifySuccess: vi.fn(), onNotifyError: vi.fn() })],
  ["alerts", createElement(SettingsAlertsPage, { locale: "en" })],
  ["skills", createElement(SettingsSkillsPage, { activeSessionId: "test", storagePools: [], locale: "en" })],
  ["MCP", createElement(SettingsMcpPage)]
];

describe("settings initial data loading", () => {
  it.each(pages)("keeps %s loading inside the content area without a standalone loading line", (_name, page) => {
    const html = renderToStaticMarkup(page);
    expect(html).toContain('class="settings-content-body"');
    expect(html).toContain('class="panel-content-skeleton" role="status" aria-label="Loading"');
    expect(html.replace(/<[^>]+>/gu, "").trim()).toBe("");
    expect(html).not.toContain("<button");
  });
});
