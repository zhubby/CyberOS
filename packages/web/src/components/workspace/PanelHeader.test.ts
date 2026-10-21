import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RefreshCw } from "lucide-react";
import { describe, expect, it } from "vitest";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";

describe("PanelHeader", () => {
  it("renders icon, two-line title copy, and actions in a fixed order", () => {
    const html = renderToStaticMarkup(createElement(PanelHeader, {
      className: "example-header",
      icon: createElement(RefreshCw, { "aria-hidden": true, size: 20 }),
      title: "Downloads",
      subtitle: "Queue and monitor downloads.",
      actions: createElement(
        PanelHeaderActions,
        {
          label: "Panel actions",
          children: createElement(
            PanelHeaderAction,
            { label: "Refresh", type: "button" },
            createElement(RefreshCw, { "aria-hidden": true, size: 17 })
          )
        }
      )
    }));

    expect(html).toContain('class="management-header example-header"');
    expect(html).toContain('<h2>Downloads</h2>');
    expect(html).toContain('<p>Queue and monitor downloads.</p>');
    expect(html.indexOf("management-title-icon")).toBeLessThan(html.indexOf("management-title-copy"));
    expect(html.indexOf("management-title-copy")).toBeLessThan(html.indexOf("panel-header-actions"));
    expect(html).not.toContain("eyebrow");
    expect(html).not.toContain("panel-inline-status");
  });

  it("renders icon-only actions with an accessible label and tooltip", () => {
    const html = renderToStaticMarkup(createElement(
      PanelHeaderActions,
      {
        label: "Panel actions",
        children: createElement(
          PanelHeaderAction,
          { label: "Refresh", type: "button" },
          createElement(RefreshCw, { "aria-hidden": true, size: 17 })
        )
      }
    ));
    const button = html.match(/<button[\s\S]*?<\/button>/u)?.[0] ?? "";

    expect(html).toContain('class="management-actions panel-header-actions"');
    expect(button).toContain('aria-label="Refresh"');
    expect(button).toContain('title="Refresh"');
    expect(button.replace(/<[^>]+>/gu, "").trim()).toBe("");
  });

});
