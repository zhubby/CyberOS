import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsBackupContent } from "./SettingsBackupPage.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

const handlers = {
  onFormChange: vi.fn(),
  onPasswordChange: vi.fn(),
  onSubmit: vi.fn(),
  onClearCredential: vi.fn(),
  onSaveCredential: vi.fn(),
  onValidate: vi.fn(),
  onInitialize: vi.fn()
};

describe("SettingsBackupContent", () => {
  it("renders only the credential marker and exposes repository actions", () => {
    const html = renderToStaticMarkup(createElement(SettingsBackupContent, {
      form: {
        enabled: true,
        repositoryPath: "/cyberos/backup",
        requireMount: true,
        keepDaily: 7,
        keepWeekly: 4,
        passwordConfigured: true,
        validatedAt: "2026-10-29T00:00:00.000Z",
        updatedAt: "2026-10-29T00:00:00.000Z"
      },
      password: "",
      busy: null,
      error: null,
      ...handlers
    }));

    expect(html).toContain("A password is configured; its value is never returned.");
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain("Validate repository");
    expect(html).toContain("Initialize repository");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(html).not.toContain('class="hud-switch-copy"');
    expect(html).not.toContain("restic-password");
  });

  it("disables credential-dependent actions when no password is configured", () => {
    const html = renderToStaticMarkup(createElement(SettingsBackupContent, {
      form: {
        enabled: false,
        repositoryPath: "/cyberos/backup",
        requireMount: true,
        keepDaily: 7,
        keepWeekly: 4,
        passwordConfigured: false,
        validatedAt: null,
        updatedAt: "2026-10-29T00:00:00.000Z"
      },
      password: "",
      busy: null,
      error: null,
      ...handlers
    }));

    expect(html).toContain("No repository password is configured.");
    expect(html.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/u);
  });
});
