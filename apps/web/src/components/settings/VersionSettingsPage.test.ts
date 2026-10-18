import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { VersionSettingsPage } from "./VersionSettingsPage.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("VersionSettingsPage", () => {
  it("renders the complete traceability metadata", () => {
    const html = renderToStaticMarkup(createElement(VersionSettingsPage, {
      buildInfo: {
        version: "0.2.0",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        commitShortSha: "0123456789ab",
        tag: "v0.2.0",
        branch: "main",
        builtAt: "2026-09-14T08:00:00.000Z",
        source: "release",
        dirty: false
      },
      error: null,
      loading: false,
      locale: "en"
    }));

    expect(html).toContain("v0.2.0");
    expect(html).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(html).toContain("v0.2.0");
    expect(html).toContain("main");
    expect(html).toContain("Release");
    expect(html).toContain("Clean");
    expect(html).toContain('aria-label="Copy full commit SHA"');
    expect(html).not.toContain("0123456789ab</dd>");
    expect(html).not.toContain("Short SHA");
  });

  it("renders an isolated unavailable state when metadata loading fails", () => {
    const html = renderToStaticMarkup(createElement(VersionSettingsPage, {
      buildInfo: null,
      error: "request failed",
      loading: false,
      locale: "en"
    }));

    expect(html).toContain("Build metadata could not be loaded");
    expect(html).toContain("request failed");
    expect(html).toContain("Unavailable");
  });
});
