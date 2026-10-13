import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShareAccountDialog, validateShareAccountDraft } from "./ShareAccountDialog.js";

describe("share account dialog", () => {
  it("validates usernames and matching replacement passwords", () => {
    expect(validateShareAccountDraft("Share User", "", "")).toBe("invalidUsername");
    expect(validateShareAccountDraft("share-user", "next-secret", "different")).toBe("passwordMismatch");
    expect(validateShareAccountDraft("share-user", "line\nbreak", "line\nbreak")).toBe("invalidPassword");
    expect(validateShareAccountDraft("share-user", "next-secret", "next-secret")).toBeNull();
  });

  it("renders configured state without exposing an existing password", () => {
    const html = renderToStaticMarkup(createElement(ShareAccountDialog, {
      settings: {
        account: {
          username: "sigma-share",
          passwordConfigured: true
        },
        updatedAt: "2026-10-13T00:00:00.000Z"
      },
      onClose: () => undefined,
      onSaved: () => undefined
    }));

    expect(html).toContain("sigma-share");
    expect(html).toContain("autoComplete=\"new-password\"");
    expect(html).toContain("data-configured=\"true\"");
    expect(html).not.toContain("current-password");
  });
});
