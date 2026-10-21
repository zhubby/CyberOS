import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initI18n } from "../../i18n/index.js";
import { PowerDialog } from "./PowerControl.js";

await initI18n();

const noop = () => undefined;

describe("PowerDialog", () => {
  it("renders restart and shutdown choices before confirmation", () => {
    const html = renderToStaticMarkup(
      createElement(PowerDialog, {
        dialogRef: createRef<HTMLElement>(),
        action: null,
        busy: false,
        onSelect: noop,
        onBack: noop,
        onClose: noop,
        onConfirm: noop
      })
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-action="reboot"');
    expect(html).toContain('data-action="shutdown"');
    expect(html).toContain("Restart");
    expect(html).toContain("Shut down");
    expect(html).not.toContain("Restart now");
  });

  it("renders a separate destructive confirmation state", () => {
    const html = renderToStaticMarkup(
      createElement(PowerDialog, {
        dialogRef: createRef<HTMLElement>(),
        action: "shutdown",
        busy: false,
        onSelect: noop,
        onBack: noop,
        onClose: noop,
        onConfirm: noop
      })
    );

    expect(html).toContain("Shut down this device?");
    expect(html).toContain("Shut down now");
    expect(html).toContain('class="danger-button power-confirm-button"');
    expect(html).not.toContain('data-action="reboot"');
  });

  it("disables navigation and marks confirmation busy while submitting", () => {
    const html = renderToStaticMarkup(
      createElement(PowerDialog, {
        dialogRef: createRef<HTMLElement>(),
        action: "reboot",
        busy: true,
        onSelect: noop,
        onBack: noop,
        onClose: noop,
        onConfirm: noop
      })
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Requesting restart");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});
