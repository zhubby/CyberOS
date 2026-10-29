import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsSystemProfileContent } from "./SettingsSystemProfilePage.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("SettingsSystemProfileContent", () => {
  it("renders the persisted administrator name and busy state", () => {
    const html = renderToStaticMarkup(createElement(SettingsSystemProfileContent, {
      displayName: "Cyber Operator",
      busy: true,
      error: "Unable to save",
      onDisplayNameChange: vi.fn(),
      onSubmit: vi.fn()
    }));

    expect(html).toContain("Administrator display name");
    expect(html).toContain('value="Cyber Operator"');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-busy="true"');
  });
});
