import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultToolPolicyForm,
  dockerSettingsToForm,
  modelSettingsToForm,
  SETTINGS_SECTIONS
} from "../../config/settings.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsModal } from "./SettingsModal.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("SettingsModal", () => {
  it("renders a title-only navigation and a header without persistent status labels", () => {
    const html = renderSettings();
    const header = html.match(/<header class="settings-content-header">[\s\S]*?<\/header>/u)?.[0] ?? "";
    const navigation = html.match(/<nav class="settings-nav">[\s\S]*?<\/nav>/u)?.[0] ?? "";

    expect(header).toContain("Overview");
    expect(header).not.toContain("Configured");
    expect(header).not.toContain("Secrets masked");
    expect(html).not.toContain("settings-header-meta");
    expect(navigation).not.toContain("<small");
    expect(navigation).not.toContain("Security");
    expect(navigation.match(/<button/gu)).toHaveLength(SETTINGS_SECTIONS.length);
  });

  it("renders the Agent MCP switch with its pairing status", () => {
    const html = renderSettings({
      activeSection: "agents",
      agentMcpSettings: {
        enabled: true,
        available: true,
        paired: true,
        status: "ready",
        updatedAt: "2026-10-23T00:00:00.000Z"
      }
    });

    expect(html).toContain("Agent MCP");
    expect(html).toContain("Paired and ready for new Agent tasks.");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
  });

  it("keeps the Agent MCP switch enabled when its credential needs attention", () => {
    const html = renderSettings({
      activeSection: "agents",
      agentMcpSettings: {
        enabled: true,
        available: true,
        paired: false,
        status: "attention",
        updatedAt: "2026-10-23T00:00:00.000Z"
      }
    });

    expect(html).toContain("Enabled, but the protected credential needs repair");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
  });

  it("keeps language preferences without rendering a theme selector", () => {
    const html = renderSettings({ activeSection: "appearance" });

    expect(html).toContain("Interface language");
    expect(html).toContain('id="language-select"');
    expect(html).not.toContain('id="theme-select"');
    expect(html).not.toContain("Interface theme");
  });
});

function renderSettings(overrides: Partial<ComponentProps<typeof SettingsModal>> = {}): string {
  const props: ComponentProps<typeof SettingsModal> = {
    activeSection: "overview",
    form: modelSettingsToForm(null),
    dockerForm: dockerSettingsToForm(null),
    loading: false,
    saving: false,
    dockerSettings: null,
    downloadSettings: null,
    indexerSettings: null,
    indexerStatus: null,
    storagePools: [],
    photoSettings: null,
    photoStatus: null,
    photoProcessingSettings: null,
    settings: null,
    systemInfo: null,
    buildInfo: null,
    buildInfoError: null,
    toolPolicyForm: defaultToolPolicyForm(),
    agentMcpSettings: {
      enabled: false,
      available: true,
      paired: false,
      status: "disabled",
      updatedAt: new Date(0).toISOString()
    },
    languagePreference: "system",
    previewFileSizeLimitBytes: 10 * 1024 * 1024,
    codeFontSettings: { familyId: "system", fontSizePx: 12 },
    networkSummary: null,
    bluetoothStatus: null,
    resolvedLocale: "en",
    onClose: vi.fn(),
    onFormChange: vi.fn(),
    onDockerFormChange: vi.fn(),
    onDownloadSettingsChange: vi.fn(async () => undefined),
    onIndexerSettingsChange: vi.fn(async () => undefined),
    onIndexerReindex: vi.fn(async () => undefined),
    onPhotoProcessingSettingsChange: vi.fn(async () => undefined),
    onToolPolicyFormChange: vi.fn(),
    onAgentMcpEnabledChange: vi.fn(async () => undefined),
    onLanguagePreferenceChange: vi.fn(),
    onPreviewFileSizeLimitChange: vi.fn(),
    onCodeFontSettingsChange: vi.fn(),
    onWifiStatus: vi.fn(),
    onBluetoothStatus: vi.fn(),
    onNetworkRefresh: vi.fn(async () => undefined),
    onNotifySuccess: vi.fn(),
    onNotifyError: vi.fn(),
    onSectionChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides
  };
  return renderToStaticMarkup(createElement(SettingsModal, props));
}
