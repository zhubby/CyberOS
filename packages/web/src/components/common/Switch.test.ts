import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "./Switch.js";

describe("Switch", () => {
  it("renders an accessible checked switch with visible context", () => {
    const html = renderToStaticMarkup(createElement(Switch, {
      checked: true,
      onCheckedChange: () => undefined,
      label: "Enable service",
      description: "Starts after the settings are saved."
    }));

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('checked=""');
    expect(html).toContain("Enable service");
    expect(html).toContain("Starts after the settings are saved.");
  });

  it("requires an accessible label when no visible label is rendered", () => {
    const html = renderToStaticMarkup(createElement(Switch, {
      checked: false,
      onCheckedChange: () => undefined,
      ariaLabel: "Agent MCP"
    }));

    expect(html).toContain('aria-label="Agent MCP"');
    expect(html).toContain('aria-checked="false"');
  });
});
