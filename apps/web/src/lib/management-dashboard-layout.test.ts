import { describe, expect, it } from "vitest";
import {
  MANAGEMENT_DASHBOARD_COLUMNS,
  MANAGEMENT_DASHBOARD_LAYOUT_VERSION,
  adjustManagementDashboardLayout,
  defaultManagementDashboardLayouts,
  managementDashboardStorageKey,
  managementDashboardWidgetDefinitions,
  orderedManagementDashboardWidgetIds,
  readManagementDashboardLayouts,
  resetManagementDashboardLayouts,
  writeManagementDashboardLayouts
} from "./management-dashboard-layout.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

describe("management dashboard layouts", () => {
  it("packs every dashboard widget inside each breakpoint without overlap", () => {
    for (const dashboardId of ["docker", "virtualMachines", "network", "storage", "shares", "monitoring"] as const) {
      const layouts = defaultManagementDashboardLayouts(dashboardId);
      const expectedIds = managementDashboardWidgetDefinitions(dashboardId).map((widget) => widget.id).sort();

      for (const breakpoint of ["desktop", "tablet"] as const) {
        const layout = layouts[breakpoint];
        expect(layout.map((item) => item.i).sort()).toEqual(expectedIds);
        for (const item of layout) {
          expect(item.x).toBeGreaterThanOrEqual(0);
          expect(item.x + item.w).toBeLessThanOrEqual(MANAGEMENT_DASHBOARD_COLUMNS[breakpoint]);
          expect(item.h).toBeGreaterThanOrEqual(item.minH ?? 1);
        }
        for (const [index, item] of layout.entries()) {
          for (const other of layout.slice(index + 1)) {
            const overlaps = item.x < other.x + other.w
              && item.x + item.w > other.x
              && item.y < other.y + other.h
              && item.y + item.h > other.y;
            expect(overlaps, `${dashboardId}/${breakpoint}: ${item.i} overlaps ${other.i}`).toBe(false);
          }
        }
      }
    }
  });

  it("persists layouts with a version and restores only known, valid widgets", () => {
    const storage = memoryStorage();
    const defaults = defaultManagementDashboardLayouts("storage");
    const changed = {
      ...defaults,
      desktop: defaults.desktop.map((item) => item.i === "overview" ? { ...item, x: 6, w: 6 } : item)
    };

    writeManagementDashboardLayouts("storage", changed, storage);
    const raw = JSON.parse(storage.values.get(managementDashboardStorageKey("storage")) ?? "{}") as {
      version?: number;
      layouts?: { desktop?: unknown[] };
    };
    expect(raw.version).toBe(MANAGEMENT_DASHBOARD_LAYOUT_VERSION);
    expect(raw.layouts?.desktop).toHaveLength(defaults.desktop.length);
    expect(readManagementDashboardLayouts("storage", storage).desktop.find((item) => item.i === "overview")?.x).toBe(6);

    storage.values.set(managementDashboardStorageKey("storage"), JSON.stringify({
      version: MANAGEMENT_DASHBOARD_LAYOUT_VERSION,
      layouts: {
        desktop: [
          { i: "overview", x: 999, y: 4, w: 999, h: 1 },
          { i: "removed-widget", x: 0, y: 0, w: 1, h: 1 },
          { i: "invalid", x: "bad", y: 0, w: 1, h: 1 }
        ]
      }
    }));
    const restored = readManagementDashboardLayouts("storage", storage);
    expect(restored.desktop.map((item) => item.i).sort()).toEqual(
      managementDashboardWidgetDefinitions("storage").map((widget) => widget.id).sort()
    );
    const overview = restored.desktop.find((item) => item.i === "overview");
    expect((overview?.x ?? 0) + (overview?.w ?? 0)).toBeLessThanOrEqual(MANAGEMENT_DASHBOARD_COLUMNS.desktop);
    expect(overview?.h).toBeGreaterThanOrEqual(overview?.minH ?? 1);
  });

  it("falls back for corrupt data and removes persisted state on reset", () => {
    const storage = memoryStorage();
    storage.values.set(managementDashboardStorageKey("network"), "not json");
    expect(readManagementDashboardLayouts("network", storage)).toEqual(defaultManagementDashboardLayouts("network"));

    writeManagementDashboardLayouts("network", defaultManagementDashboardLayouts("network"), storage);
    const reset = resetManagementDashboardLayouts("network", storage);
    expect(storage.values.has(managementDashboardStorageKey("network"))).toBe(false);
    expect(reset).toEqual(defaultManagementDashboardLayouts("network"));
  });

  it("adds new network widgets to layouts saved by an older release", () => {
    const storage = memoryStorage();
    const defaults = defaultManagementDashboardLayouts("network");
    const legacyLayouts = {
      desktop: defaults.desktop.filter((item) => item.i !== "ethernet"),
      tablet: defaults.tablet.map((item) => item.i === "ethernet"
        ? { ...item, w: 1, h: 1, minW: undefined, minH: undefined }
        : item)
    };
    storage.values.set(managementDashboardStorageKey("network"), JSON.stringify({
      version: MANAGEMENT_DASHBOARD_LAYOUT_VERSION,
      layouts: legacyLayouts
    }));

    const restored = readManagementDashboardLayouts("network", storage);
    for (const breakpoint of ["desktop", "tablet"] as const) {
      const ethernet = restored[breakpoint].find((item) => item.i === "ethernet");
      expect(ethernet?.w).toBe(MANAGEMENT_DASHBOARD_COLUMNS[breakpoint]);
      expect(ethernet?.h).toBe(14);
      for (const item of restored[breakpoint].filter((candidate) => candidate.i !== "ethernet")) {
        const overlaps = ethernet !== undefined
          && ethernet.x < item.x + item.w
          && ethernet.x + ethernet.w > item.x
          && ethernet.y < item.y + item.h
          && ethernet.y + ethernet.h > item.y;
        expect(overlaps, `${breakpoint}: ethernet overlaps ${item.i}`).toBe(false);
      }
    }
  });

  it("moves and resizes the active breakpoint while preserving the other layout", () => {
    const layouts = defaultManagementDashboardLayouts("docker");
    const originalTablet = layouts.tablet;
    const overview = layouts.desktop.find((item) => item.i === "overview");
    expect(overview).toBeDefined();

    const moved = adjustManagementDashboardLayout(layouts, "desktop", "overview", { kind: "move", dx: 1, dy: 2 });
    expect(moved.tablet).toBe(originalTablet);
    expect(moved.desktop.find((item) => item.i === "overview")?.y).toBeGreaterThanOrEqual(0);

    const resized = adjustManagementDashboardLayout(moved, "desktop", "overview", { kind: "resize", dw: -99, dh: -99 });
    const resizedOverview = resized.desktop.find((item) => item.i === "overview");
    expect(resizedOverview?.w).toBe(resizedOverview?.minW);
    expect(resizedOverview?.h).toBe(resizedOverview?.minH);
  });

  it("uses the tablet arrangement to order the narrow static layout", () => {
    const layouts = defaultManagementDashboardLayouts("shares");
    expect(orderedManagementDashboardWidgetIds(layouts)).toEqual(
      [...layouts.tablet].sort((left, right) => left.y - right.y || left.x - right.x).map((item) => item.i)
    );
  });
});
