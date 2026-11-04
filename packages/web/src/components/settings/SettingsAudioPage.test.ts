import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { AudioDiagnostics, audioSettingsPatch } from "./SettingsAudioPage.js";
import { defaultAudioSettings } from "@cyberos/db";
import { publicAudioSettings } from "@cyberos/shared";

beforeAll(async () => { await initI18n(); });
describe("Audio settings", () => {
  it("preserves a write-only token unless replacement or clearing is explicit", () => {
    const settings = publicAudioSettings(defaultAudioSettings());
    expect(audioSettingsPatch(settings, "", false)).not.toHaveProperty("cyberAudioToken");
    expect(audioSettingsPatch(settings, "new-token", false).cyberAudioToken).toBe("new-token");
    expect(audioSettingsPatch(settings, "", true).cyberAudioToken).toBeNull();
    expect(audioSettingsPatch(settings, "", false)).not.toHaveProperty("tokenConfigured");
  });
  it.each(["zh-CN", "en"])("shows independent service states in %s", async (locale) => {
    await i18n.changeLanguage(locale);
    const html = renderToStaticMarkup(createElement(AudioDiagnostics, { service: { reachable: true, authenticated: false, sttReady: true, ttsReady: false, voices: [], error: "Authentication failed" } }));
    expect(html).toContain("STT");
    expect(html).toContain("TTS");
    expect(html).toContain("Authentication failed");
    expect(html).not.toContain("settings.audio.");
  });
});
