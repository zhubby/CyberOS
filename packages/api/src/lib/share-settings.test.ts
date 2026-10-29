import { describe, expect, it } from "vitest";
import type { ShareSettingsRecord } from "@cyberos/shared";
import { normalizeShareSettingsInput } from "./share-settings.js";

const settings: ShareSettingsRecord = {
  enabled: false,
  account: { username: "cyberos-share", password: null },
  shares: [],
  updatedAt: "2026-10-29T00:00:00.000Z"
};

describe("share account identity", () => {
  it.each(["root", "cyberos"])("rejects reserved identity %s", async (username) => {
    await expect(normalizeShareSettingsInput({ account: { username } }, settings, []))
      .rejects.toThrow("privileged system identity");
  });

  it("accepts the dedicated sharing identity", async () => {
    const result = await normalizeShareSettingsInput(undefined, settings, []);
    expect(result.account.username).toBe("cyberos-share");
  });
});
