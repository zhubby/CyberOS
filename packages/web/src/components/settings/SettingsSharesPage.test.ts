import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ShareSettings } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsSharesContent } from "./SettingsSharesPage.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

const settings: ShareSettings = {
  enabled: true,
  account: {
    username: "cyberos-share",
    passwordConfigured: true
  },
  shares: [],
  updatedAt: "2026-10-29T00:00:00.000Z"
};

describe("SettingsSharesContent", () => {
  it("renders global sharing and credentials as settings controls", () => {
    const html = renderContent();

    expect(html).toContain("Global sharing");
    expect(html).toContain("Share account");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(html).toContain('value="cyberos-share"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('data-configured="true"');
    expect(html).not.toContain("current-password");
  });

  it("shows credential validation without exposing a stored password", () => {
    const html = renderContent({
      password: "next-secret",
      passwordConfirmation: "different"
    });

    expect(html).toContain("The passwords do not match.");
    expect(html).not.toContain("stored-secret");
  });
});

function renderContent(
  overrides: Partial<ComponentProps<typeof SettingsSharesContent>> = {}
): string {
  const props: ComponentProps<typeof SettingsSharesContent> = {
    settings,
    enabled: true,
    username: "cyberos-share",
    password: "",
    passwordConfirmation: "",
    busy: null,
    error: null,
    onEnabledChange: vi.fn(),
    onUsernameChange: vi.fn(),
    onPasswordChange: vi.fn(),
    onPasswordConfirmationChange: vi.fn(),
    onPublishingSubmit: vi.fn(),
    onAccountSubmit: vi.fn(),
    ...overrides
  };
  return renderToStaticMarkup(createElement(SettingsSharesContent, props));
}
