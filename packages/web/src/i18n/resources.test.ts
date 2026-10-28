import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { en, resources, zhCN } from "./resources.js";

describe("i18n resources", () => {
  it("keeps simplified Chinese keys in parity with English", () => {
    expect(flattenKeys(zhCN)).toEqual(flattenKeys(en));
  });

  it("translates interpolated action text", async () => {
    const instance = i18next.createInstance();
    await instance.init({
      resources,
      lng: "en",
      fallbackLng: "en",
      defaultNS: "translation",
      interpolation: {
        escapeValue: false
      }
    });

    expect(instance.t("chat.deleteSessionBody", { title: "Workspace agent" })).toBe(
      "Workspace agent and its chat history will be removed from CyberOS."
    );

    await instance.changeLanguage("zh-CN");
    expect(instance.t("chat.deleteSessionBody", { title: "工作区 agent" })).toBe(
      "工作区 agent 及其聊天记录将从 CyberOS 中移除。"
    );
    expect(instance.t("preview.cannotPreview", { size: "8 KB" })).toBe("8 KB 无法内联预览。");
  });

  it("describes file panel mutations as direct actions", () => {
    const englishActions = Object.values(en.workspace.actions).join(" ").toLocaleLowerCase("en");
    const chineseActions = Object.values(zhCN.workspace.actions).join(" ");

    expect(englishActions).not.toContain("approval");
    expect(englishActions).not.toContain("request ");
    expect(chineseActions).not.toContain("审批");
    expect(chineseActions).not.toContain("请求");
  });
});

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") {
    return [prefix];
  }

  return Object.entries(value)
    .flatMap(([key, nextValue]) => flattenKeys(nextValue, prefix ? `${prefix}.${key}` : key))
    .sort();
}
