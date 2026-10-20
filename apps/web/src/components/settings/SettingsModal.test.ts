import { createElement } from "react";
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
    const html = renderToStaticMarkup(createElement(SettingsModal, {
      activeSection: "overview",
      form: modelSettingsToForm(null),
      dockerForm: dockerSettingsToForm(null),
      loading: false,
      saving: false,
      dockerSettings: null,
      downloadSettings: null,
      indexerSettings: null,
      indexerStatus: null,
      roots: [],
      storagePools: [],
      photoSettings: null,
      photoStatus: null,
      photoProcessingSettings: null,
      settings: null,
      systemInfo: null,
      buildInfo: null,
      buildInfoError: null,
      toolPolicyForm: defaultToolPolicyForm(),
      languagePreference: "system",
      themePreference: "system",
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
      onLanguagePreferenceChange: vi.fn(),
      onThemePreferenceChange: vi.fn(),
      onPreviewFileSizeLimitChange: vi.fn(),
      onCodeFontSettingsChange: vi.fn(),
      onWifiStatus: vi.fn(),
      onBluetoothStatus: vi.fn(),
      onNetworkRefresh: vi.fn(async () => undefined),
      onNotifySuccess: vi.fn(),
      onNotifyError: vi.fn(),
      onSectionChange: vi.fn(),
      onSubmit: vi.fn()
    }));
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
});
