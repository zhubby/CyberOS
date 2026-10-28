import { moveElement, verticalCompactor, type Layout, type LayoutItem } from "react-grid-layout";

export type ManagementDashboardId = "docker" | "virtualMachines" | "network" | "storage" | "shares" | "monitoring";
export type ManagementDashboardBreakpoint = "desktop" | "tablet";
export type ManagementDashboardWidgetSize = "overview" | "metric" | "wide" | "half" | "narrow" | "large";

export interface ManagementDashboardWidgetDefinition {
  id: string;
  size: ManagementDashboardWidgetSize;
}

export interface ManagementDashboardLayouts {
  desktop: Layout;
  tablet: Layout;
}

export const MANAGEMENT_DASHBOARD_BREAKPOINTS: Record<ManagementDashboardBreakpoint, number> = {
  desktop: 900,
  tablet: 0
};

export const MANAGEMENT_DASHBOARD_COLUMNS: Record<ManagementDashboardBreakpoint, number> = {
  desktop: 12,
  tablet: 8
};

export const MANAGEMENT_DASHBOARD_MOBILE_MAX_WIDTH = 620;
export const MANAGEMENT_DASHBOARD_LAYOUT_VERSION = 1;

const STORAGE_KEY_PREFIX = `cyberos:management-dashboard-layout:v${MANAGEMENT_DASHBOARD_LAYOUT_VERSION}`;

const MANAGEMENT_DASHBOARD_WIDGETS: Record<ManagementDashboardId, readonly ManagementDashboardWidgetDefinition[]> = {
  monitoring: [
    { id: "overview", size: "overview" },
    { id: "metric-cpu", size: "metric" },
    { id: "metric-memory", size: "metric" },
    { id: "metric-network", size: "metric" },
    { id: "metric-storage", size: "metric" },
    { id: "cpu", size: "half" },
    { id: "memory", size: "half" },
    { id: "network", size: "half" },
    { id: "disk", size: "half" },
    { id: "capacity", size: "half" },
    { id: "temperature", size: "half" },
    { id: "services", size: "wide" }
  ],
  docker: [
    { id: "overview", size: "overview" },
    { id: "metric-containers", size: "metric" },
    { id: "metric-images", size: "metric" },
    { id: "metric-networks", size: "metric" },
    { id: "metric-volumes", size: "metric" },
    { id: "containers", size: "wide" },
    { id: "images", size: "wide" },
    { id: "pressure", size: "half" },
    { id: "networks", size: "narrow" },
    { id: "storage", size: "narrow" },
    { id: "compose", size: "wide" }
  ],
  virtualMachines: [
    { id: "overview", size: "overview" },
    { id: "metric-instances", size: "metric" },
    { id: "metric-vcpu", size: "metric" },
    { id: "metric-memory", size: "metric" },
    { id: "metric-network", size: "metric" },
    { id: "instances", size: "wide" },
    { id: "resources", size: "wide" }
  ],
  network: [
    { id: "overview", size: "overview" },
    { id: "metric-interfaces", size: "metric" },
    { id: "metric-connected", size: "metric" },
    { id: "metric-addresses", size: "metric" },
    { id: "metric-defaultRoutes", size: "metric" },
    { id: "ethernet", size: "wide" },
    { id: "wifi", size: "large" },
    { id: "traffic", size: "large" },
    { id: "interfaces", size: "wide" },
    { id: "routes", size: "half" },
    { id: "readiness", size: "half" }
  ],
  storage: [
    { id: "overview", size: "overview" },
    { id: "metric-pools", size: "metric" },
    { id: "metric-disks", size: "metric" },
    { id: "metric-smart", size: "metric" },
    { id: "metric-capacity", size: "metric" },
    { id: "pools", size: "wide" },
    { id: "disks", size: "half" },
    { id: "health", size: "half" }
  ],
  shares: [
    { id: "overview", size: "overview" },
    { id: "metric-shares", size: "metric" },
    { id: "metric-protocols", size: "metric" },
    { id: "metric-authenticated", size: "metric" },
    { id: "metric-issues", size: "metric" },
    { id: "account", size: "half" },
    { id: "services", size: "half" },
    { id: "directories", size: "large" }
  ]
};

interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredManagementDashboardLayout {
  version: number;
  layouts: Partial<ManagementDashboardLayouts>;
}

interface GridSize {
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export type DashboardKeyboardAdjustment =
  | { kind: "move"; dx: number; dy: number }
  | { kind: "resize"; dw: number; dh: number };

function browserStorage(): LayoutStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function managementDashboardStorageKey(dashboardId: ManagementDashboardId): string {
  return `${STORAGE_KEY_PREFIX}:${dashboardId}`;
}

export function managementDashboardWidgetDefinitions(
  dashboardId: ManagementDashboardId
): readonly ManagementDashboardWidgetDefinition[] {
  return MANAGEMENT_DASHBOARD_WIDGETS[dashboardId];
}

export function defaultManagementDashboardLayouts(dashboardId: ManagementDashboardId): ManagementDashboardLayouts {
  const definitions = managementDashboardWidgetDefinitions(dashboardId);
  return {
    desktop: packLayout(definitions, "desktop"),
    tablet: packLayout(definitions, "tablet")
  };
}

export function readManagementDashboardLayouts(
  dashboardId: ManagementDashboardId,
  storage: LayoutStorage | null = browserStorage()
): ManagementDashboardLayouts {
  const defaults = defaultManagementDashboardLayouts(dashboardId);
  try {
    const raw = storage?.getItem(managementDashboardStorageKey(dashboardId));
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as StoredManagementDashboardLayout;
    if (parsed.version !== MANAGEMENT_DASHBOARD_LAYOUT_VERSION || !parsed.layouts || typeof parsed.layouts !== "object") {
      return defaults;
    }
    return mergeDashboardLayouts(parsed.layouts, defaults);
  } catch {
    return defaults;
  }
}

export function writeManagementDashboardLayouts(
  dashboardId: ManagementDashboardId,
  layouts: ManagementDashboardLayouts,
  storage: LayoutStorage | null = browserStorage()
): void {
  try {
    storage?.setItem(
      managementDashboardStorageKey(dashboardId),
      JSON.stringify({ version: MANAGEMENT_DASHBOARD_LAYOUT_VERSION, layouts })
    );
  } catch {
    // Layout persistence is best-effort; the dashboard remains usable without storage access.
  }
}

export function resetManagementDashboardLayouts(
  dashboardId: ManagementDashboardId,
  storage: LayoutStorage | null = browserStorage()
): ManagementDashboardLayouts {
  try {
    storage?.removeItem(managementDashboardStorageKey(dashboardId));
  } catch {
    // Ignore storage failures and still reset the in-memory layout.
  }
  return defaultManagementDashboardLayouts(dashboardId);
}

export function orderedManagementDashboardWidgetIds(layouts: ManagementDashboardLayouts): string[] {
  const layout = layouts.tablet.length ? layouts.tablet : layouts.desktop;
  return [...layout]
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((item) => item.i);
}

export function adjustManagementDashboardLayout(
  layouts: ManagementDashboardLayouts,
  breakpoint: ManagementDashboardBreakpoint,
  widgetId: string,
  adjustment: DashboardKeyboardAdjustment
): ManagementDashboardLayouts {
  const cols = MANAGEMENT_DASHBOARD_COLUMNS[breakpoint];
  const current = layouts[breakpoint].map((item) => ({ ...item }));
  const item = current.find((candidate) => candidate.i === widgetId);
  if (!item) {
    return layouts;
  }

  let nextLayout: Layout;
  if (adjustment.kind === "move") {
    const x = clamp(item.x + adjustment.dx, 0, cols - item.w);
    const y = Math.max(0, item.y + adjustment.dy);
    nextLayout = moveElement(current, item, x, y, true, false, "vertical", cols, false);
  } else {
    const minW = item.minW ?? 1;
    const minH = item.minH ?? 1;
    item.w = clamp(item.w + adjustment.dw, minW, Math.min(item.maxW ?? cols, cols - item.x));
    item.h = Math.max(minH, Math.min(item.h + adjustment.dh, item.maxH ?? Number.POSITIVE_INFINITY));
    nextLayout = current;
  }

  return {
    ...layouts,
    [breakpoint]: verticalCompactor.compact(nextLayout, cols)
  };
}

function mergeDashboardLayouts(
  stored: Partial<ManagementDashboardLayouts>,
  defaults: ManagementDashboardLayouts
): ManagementDashboardLayouts {
  return {
    desktop: mergeBreakpointLayout(stored.desktop, defaults.desktop, MANAGEMENT_DASHBOARD_COLUMNS.desktop),
    tablet: mergeBreakpointLayout(stored.tablet, defaults.tablet, MANAGEMENT_DASHBOARD_COLUMNS.tablet)
  };
}

function mergeBreakpointLayout(stored: Layout | undefined, defaults: Layout, cols: number): Layout {
  if (!Array.isArray(stored)) {
    return defaults;
  }
  const storedById = new Map(
    stored.filter(isValidLayoutItem).map((item) => [item.i, item] as const)
  );
  const merged = defaults.map((fallback) => sanitizeLayoutItem(storedById.get(fallback.i), fallback, cols));
  return verticalCompactor.compact(merged, cols);
}

function sanitizeLayoutItem(stored: LayoutItem | undefined, fallback: LayoutItem, cols: number): LayoutItem {
  if (!stored) {
    return fallback;
  }
  const minW = fallback.minW ?? 1;
  const minH = fallback.minH ?? 1;
  if (stored.w < minW || stored.h < minH) {
    return fallback;
  }
  const w = clamp(stored.w, minW, Math.min(fallback.maxW ?? cols, cols));
  const h = Math.max(minH, Math.min(stored.h, fallback.maxH ?? Number.POSITIVE_INFINITY));
  return {
    ...fallback,
    x: clamp(stored.x, 0, cols - w),
    y: Math.max(0, stored.y),
    w,
    h
  };
}

function isValidLayoutItem(value: unknown): value is LayoutItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<LayoutItem>;
  return typeof item.i === "string" && [item.x, item.y, item.w, item.h].every(isNonNegativeInteger) && (item.w ?? 0) > 0 && (item.h ?? 0) > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function packLayout(
  definitions: readonly ManagementDashboardWidgetDefinition[],
  breakpoint: ManagementDashboardBreakpoint
): Layout {
  const cols = MANAGEMENT_DASHBOARD_COLUMNS[breakpoint];
  const layout: LayoutItem[] = [];
  for (const definition of definitions) {
    const size = gridSize(definition.size, breakpoint);
    const position = firstAvailablePosition(layout, size.w, size.h, cols);
    layout.push({ i: definition.id, ...position, ...size, maxW: cols });
  }
  return layout;
}

function gridSize(size: ManagementDashboardWidgetSize, breakpoint: ManagementDashboardBreakpoint): GridSize {
  const tablet = breakpoint === "tablet";
  switch (size) {
    case "overview":
      return { w: tablet ? 8 : 6, h: 12, minW: tablet ? 4 : 4, minH: 9 };
    case "metric":
      return { w: tablet ? 4 : 3, h: 6, minW: 2, minH: 5 };
    case "half":
      return { w: tablet ? 4 : 6, h: 16, minW: tablet ? 4 : 4, minH: 9 };
    case "narrow":
      return { w: tablet ? 4 : 3, h: 16, minW: tablet ? 4 : 3, minH: 9 };
    case "large":
      return { w: colsFor(breakpoint), h: 26, minW: tablet ? 4 : 6, minH: 12 };
    case "wide":
      return { w: colsFor(breakpoint), h: 14, minW: tablet ? 4 : 6, minH: 8 };
  }
}

function colsFor(breakpoint: ManagementDashboardBreakpoint): number {
  return MANAGEMENT_DASHBOARD_COLUMNS[breakpoint];
}

function firstAvailablePosition(layout: Layout, w: number, h: number, cols: number): { x: number; y: number } {
  for (let y = 0; ; y += 1) {
    for (let x = 0; x <= cols - w; x += 1) {
      if (!layout.some((item) => rectanglesOverlap({ x, y, w, h }, item))) {
        return { x, y };
      }
    }
  }
}

function rectanglesOverlap(
  left: Pick<LayoutItem, "x" | "y" | "w" | "h">,
  right: Pick<LayoutItem, "x" | "y" | "w" | "h">
): boolean {
  return left.x < right.x + right.w && left.x + left.w > right.x && left.y < right.y + right.h && left.y + left.h > right.y;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
