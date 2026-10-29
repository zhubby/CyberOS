import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultToolPolicyForm,
  dockerSettingsToForm,
  modelSettingsToForm,
  vmSettingsToForm,
  SETTINGS_SECTIONS
} from "../../config/settings.js";
import type { SystemInfo } from "../../api.js";
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

  it("separates Pi Agent, MCP, and Skills in the AI navigation", () => {
    const html = renderSettings({
      activeSection: "pi-agent"
    });

    expect(html.indexOf("Model Providers")).toBeLessThan(html.indexOf("Pi Agent"));
    expect(html.indexOf("Pi Agent")).toBeLessThan(html.indexOf(">MCP<"));
    expect(html.indexOf(">MCP<")).toBeLessThan(html.indexOf(">Skills<"));
    expect(html).not.toContain("Agent MCP");
  });

  it("keeps language preferences without rendering a theme selector", () => {
    const html = renderSettings({ activeSection: "appearance" });

    expect(html).toContain("Interface language");
    expect(html).toContain('id="language-select"');
    expect(html).not.toContain('id="theme-select"');
    expect(html).not.toContain("Interface theme");
  });

  it("renders Docker enablement as a switch instead of a native checkbox control", () => {
    const html = renderSettings({
      activeSection: "docker",
      dockerForm: { ...dockerSettingsToForm(null), enabled: true }
    });

    expect(html).toContain("Enable Docker management");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(html).toContain("hud-switch-track");
  });

  it("renders virtual machine enablement in its own settings section", () => {
    const html = renderSettings({
      activeSection: "virtual-machines",
      vmForm: { ...vmSettingsToForm(null), enabled: true }
    });

    expect(html).toContain("Enable virtual machine management");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(html).toContain("QEMU, KVM, and libvirt");
  });

  it("includes sharing in the administration settings navigation", () => {
    const html = renderSettings({ activeSection: "shares" });

    expect(html).toContain("Global publishing state and credentials");
    expect(html).toContain("Shares");
  });

  it("moves hardware and runtime details into Overview without the Advanced section", () => {
    const html = renderSettings({
      systemInfo: systemInfoFixture()
    });

    expect(SETTINGS_SECTIONS.map((section) => section.id)).not.toContain("advanced");
    expect(html).not.toContain("Storage pool namespace");
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain(">Advanced<");
    expect(html).toContain("CPU model");
    expect(html).toContain("Cortex-A76");
    expect(html).toContain("arm64 / aarch64");
    expect(html).toContain("Physical memory");
    expect(html).toContain("Service");
    expect(html).toContain("Process");
    expect(html).toContain("Paths");
    expect(html).toContain("127.0.0.1:3010");
    expect(html).toContain("/cyberos/state/cyberos.sqlite");
  });
});

function systemInfoFixture(): SystemInfo {
  return {
    collectedAt: "2026-10-29T00:00:00.000Z",
    identity: {
      hostname: "cyberos-cm5",
      adminDisplayName: "Admin",
      authMode: "local-only",
      timezone: "Asia/Shanghai"
    },
    operatingSystem: {
      type: "Linux",
      platform: "linux",
      release: "6.12.0",
      version: "Debian GNU/Linux 13",
      arch: "arm64",
      machine: "aarch64",
      endianness: "LE",
      uptimeSeconds: 86_400,
      loadAverage: [0.2, 0.3, 0.4],
      availableParallelism: 4
    },
    hardware: {
      cpuModel: "Cortex-A76",
      cpuSpeedMHz: 2_400,
      cpuThreads: 4,
      cpus: [],
      memory: {
        totalBytes: 8 * 1024 * 1024 * 1024,
        freeBytes: 3 * 1024 * 1024 * 1024,
        usedBytes: 5 * 1024 * 1024 * 1024,
        usedPercent: 62.5
      }
    },
    storage: { volumes: [] },
    network: { interfaces: [] },
    runtime: {
      nodeVersion: "v22.12.0",
      versions: {},
      pid: 1024,
      uptimeSeconds: 3_600,
      cwd: "/usr/lib/cyberos",
      execPath: "/usr/bin/node",
      memory: {
        rssBytes: 256 * 1024 * 1024,
        heapTotalBytes: 128 * 1024 * 1024,
        heapUsedBytes: 64 * 1024 * 1024,
        externalBytes: 0,
        arrayBuffersBytes: 0
      }
    },
    cyberos: {
      rootDir: "/cyberos",
      stateDir: "/cyberos/state",
      dataRoot: "/cyberos/data",
      appsRoot: "/cyberos/apps",
      isoRoot: "/cyberos/data/iso",
      vmRoot: "/cyberos/data/vm",
      backupRoot: "/cyberos/state/backup",
      databasePath: "/cyberos/state/cyberos.sqlite",
      apiHost: "127.0.0.1",
      apiPort: 3010,
      allowedOriginCount: 1,
      workerPollMs: 1_000,
      dockerEnabled: true,
      photos: {
        dataDir: "/cyberos/state/photos",
        maxFileSizeBytes: 1024,
        thumbnailSizePx: 512,
        previewMaxEdgePx: 2048,
        supportedExtensions: ["jpg"]
      }
    }
  };
}

function renderSettings(overrides: Partial<ComponentProps<typeof SettingsModal>> = {}): string {
  const props: ComponentProps<typeof SettingsModal> = {
    activeSection: "overview",
    activeSessionId: "",
    form: modelSettingsToForm(null),
    dockerForm: dockerSettingsToForm(null),
    vmForm: vmSettingsToForm(null),
    loading: false,
    saving: false,
    dockerSettings: null,
    vmSettings: null,
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
    languagePreference: "system",
    previewFileSizeLimitBytes: 10 * 1024 * 1024,
    codeFontSettings: { familyId: "system", fontSizePx: 12 },
    networkSummary: null,
    bluetoothStatus: null,
    resolvedLocale: "en",
    onClose: vi.fn(),
    onFormChange: vi.fn(),
    onDockerFormChange: vi.fn(),
    onVmFormChange: vi.fn(),
    onDownloadSettingsChange: vi.fn(async () => undefined),
    onIndexerSettingsChange: vi.fn(async () => undefined),
    onIndexerReindex: vi.fn(async () => undefined),
    onPhotoLibrarySettingsChange: vi.fn(async (input) => ({
      ...input,
      updatedAt: new Date(0).toISOString()
    })),
    onPhotoProcessingSettingsChange: vi.fn(async () => undefined),
    onRequestCreateFolder: vi.fn(async () => undefined),
    onToolPolicyFormChange: vi.fn(),
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
