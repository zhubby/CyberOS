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

  it("rejects incomplete layouts instead of upgrading an older widget set", () => {
    const storage = memoryStorage();
    const defaults = defaultManagementDashboardLayouts("network");
    const incompleteLayouts = {
      desktop: defaults.desktop.filter((item) => item.i !== "ethernet"),
      tablet: defaults.tablet.filter((item) => item.i !== "ethernet")
    };
    storage.values.set(managementDashboardStorageKey("network"), JSON.stringify({
      version: MANAGEMENT_DASHBOARD_LAYOUT_VERSION,
      layouts: incompleteLayouts
    }));

    expect(readManagementDashboardLayouts("network", storage)).toEqual(defaults);
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

  it("uses the current full-width Shares layout without the removed account widget", () => {
    const definitions = managementDashboardWidgetDefinitions("shares");
    expect(MANAGEMENT_DASHBOARD_LAYOUT_VERSION).toBe(3);
    expect(managementDashboardStorageKey("shares")).toContain(":v3:shares");
    expect(definitions.some((widget) => widget.id === "account")).toBe(false);
    expect(definitions.find((widget) => widget.id === "services")?.size).toBe("wide");

    const layouts = defaultManagementDashboardLayouts("shares");
    expect(layouts.desktop.find((item) => item.i === "services")?.w).toBe(MANAGEMENT_DASHBOARD_COLUMNS.desktop);
    expect(layouts.desktop.find((item) => item.i === "directories")?.w).toBe(MANAGEMENT_DASHBOARD_COLUMNS.desktop);
  });

  it("keeps the Network Wi-Fi status widget compact", () => {
    const definitions = managementDashboardWidgetDefinitions("network");
    expect(definitions.find((widget) => widget.id === "wifi")?.size).toBe("status");

    const layouts = defaultManagementDashboardLayouts("network");
    expect(layouts.desktop.find((item) => item.i === "wifi")).toMatchObject({ w: 3, h: 10, maxW: 3, maxH: 10 });
    expect(layouts.tablet.find((item) => item.i === "wifi")).toMatchObject({ w: 4, h: 10, maxW: 4, maxH: 10 });
  });

  it("shrinks a previously saved large Wi-Fi widget without resetting the Network layout", () => {
    const storage = memoryStorage();
    const defaults = defaultManagementDashboardLayouts("network");
    const oversized = {
      desktop: defaults.desktop.map((item) => item.i === "wifi" ? { ...item, w: 12, h: 26 } : item),
      tablet: defaults.tablet.map((item) => item.i === "wifi" ? { ...item, w: 8, h: 26 } : item)
    };

    writeManagementDashboardLayouts("network", oversized, storage);
    const restored = readManagementDashboardLayouts("network", storage);
    expect(restored.desktop.find((item) => item.i === "wifi")).toMatchObject({ w: 3, h: 10 });
    expect(restored.tablet.find((item) => item.i === "wifi")).toMatchObject({ w: 4, h: 10 });
  });

  it("keeps the three-chart storage health widget full width", () => {
    const storage = memoryStorage();
    const defaults = defaultManagementDashboardLayouts("storage");
    expect(defaults.desktop.find((item) => item.i === "health")).toMatchObject({ w: 12, minW: 12 });
    expect(defaults.tablet.find((item) => item.i === "health")).toMatchObject({ w: 8, minW: 8 });

    writeManagementDashboardLayouts("storage", {
      desktop: defaults.desktop.map((item) => item.i === "health" ? { ...item, w: 6 } : item),
      tablet: defaults.tablet.map((item) => item.i === "health" ? { ...item, w: 4 } : item)
    }, storage);
    const restored = readManagementDashboardLayouts("storage", storage);
    expect(restored.desktop.find((item) => item.i === "health")?.w).toBe(12);
    expect(restored.tablet.find((item) => item.i === "health")?.w).toBe(8);
  });
});
