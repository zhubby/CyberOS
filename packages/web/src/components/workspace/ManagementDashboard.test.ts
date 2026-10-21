import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import {
  ManagementDashboardGrid,
  type ManagementDashboardController,
  type ManagementDashboardItem
} from "./ManagementDashboard.js";
import { ManagementWidgetSkeleton } from "./ManagementSkeleton.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

function dashboardController(): ManagementDashboardController {
  return {
    dashboardId: "storage",
    layouts: {
      desktop: [
        { i: "overview", x: 0, y: 0, w: 6, h: 12 },
        { i: "metric-pools", x: 6, y: 0, w: 3, h: 6 },
        { i: "pools", x: 0, y: 12, w: 12, h: 14 }
      ],
      tablet: [
        { i: "pools", x: 0, y: 0, w: 8, h: 14 },
        { i: "metric-pools", x: 0, y: 14, w: 4, h: 6 },
        { i: "overview", x: 0, y: 20, w: 8, h: 12 }
      ]
    },
    breakpoint: "desktop",
    editing: true,
    compact: false,
    announcement: "",
    setBreakpoint: vi.fn(),
    setCompact: vi.fn(),
    setEditing: vi.fn(),
    setLayouts: vi.fn(),
    reset: vi.fn(),
    adjust: vi.fn()
  };
}

const dashboardItems: ManagementDashboardItem[] = [
  { id: "overview", title: "Overview", content: createElement("span", null, "real overview") },
  { id: "metric-pools", title: "Pools metric", content: createElement("span", null, "real metric") },
  { id: "pools", title: "Pools", content: createElement("span", null, "real pools") },
  { id: "future-widget", title: "Future", content: createElement("span", null, "real future") }
];

describe("ManagementDashboardGrid loading layout", () => {
  it("keeps the current item structure while replacing only widget content", () => {
    const dashboard = dashboardController();
    const html = renderToStaticMarkup(createElement(ManagementDashboardGrid, {
      dashboard,
      items: dashboardItems,
      loading: true
    }));
    const loadedHtml = renderToStaticMarkup(createElement(ManagementDashboardGrid, {
      dashboard,
      items: dashboardItems
    }));
    const widgetIds = (markup: string) => [...markup.matchAll(/data-widget-id="([^"]+)"/g)].map((match) => match[1]);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading"');
    expect(html).not.toContain("real overview");
    expect(html).not.toContain("management-widget-drag-handle");
    expect(widgetIds(html)).toEqual(widgetIds(loadedHtml));
    expect(widgetIds(html).sort()).toEqual(dashboardItems.map((item) => item.id).sort());
    expect(html).toContain('data-skeleton-kind="overview"');
    expect(html).toContain('data-skeleton-kind="metric"');
    expect(html).toContain('data-skeleton-kind="table"');
    expect(html).toContain('data-skeleton-kind="list"');
  });

  it("renders the supplied content normally after loading", () => {
    const html = renderToStaticMarkup(createElement(ManagementDashboardGrid, {
      dashboard: dashboardController(),
      items: dashboardItems
    }));

    expect(html).toContain("real overview");
    expect(html).toContain("real metric");
    expect(html).toContain("real pools");
    expect(html).toContain("real future");
    expect(html).not.toContain("data-skeleton-kind");
    expect(html).not.toContain('aria-busy="true"');
    expect(html.match(/data-scroll-region="true"/g)).toHaveLength(dashboardItems.length);
    expect(html.match(/role="region"/g)).toHaveLength(dashboardItems.length);
    expect(html.match(/tabindex="0"/g)).toHaveLength(dashboardItems.length);
    for (const item of dashboardItems) {
      expect(html).toContain(`aria-label="${item.title}"`);
    }
  });
});

describe("management widget skeleton variants", () => {
  it.each([
    ["docker", "pressure", "chart"],
    ["virtualMachines", "instances", "table"],
    ["network", "wifi", "form"],
    ["storage", "health", "health"],
    ["shares", "services", "list"]
  ] as const)("renders the %s/%s skeleton as %s", (dashboardId, widgetId, kind) => {
    const html = renderToStaticMarkup(createElement(ManagementWidgetSkeleton, { dashboardId, widgetId }));
    expect(html).toContain(`data-skeleton-kind="${kind}"`);
    expect(html).toContain('aria-hidden="true"');
  });

  it("uses the generic list skeleton for an unknown widget", () => {
    const html = renderToStaticMarkup(createElement(ManagementWidgetSkeleton, {
      dashboardId: "docker",
      widgetId: "future-widget"
    }));
    expect(html).toContain('data-skeleton-kind="list"');
  });
});
