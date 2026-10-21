import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, GripVertical, PanelsTopLeft, RotateCcw } from "lucide-react";
import {
  Responsive,
  useContainerWidth,
  verticalCompactor,
  type ResponsiveLayouts
} from "react-grid-layout";
import { absoluteStrategy } from "react-grid-layout/core";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  MANAGEMENT_DASHBOARD_BREAKPOINTS,
  MANAGEMENT_DASHBOARD_COLUMNS,
  MANAGEMENT_DASHBOARD_MOBILE_MAX_WIDTH,
  adjustManagementDashboardLayout,
  orderedManagementDashboardWidgetIds,
  readManagementDashboardLayouts,
  resetManagementDashboardLayouts,
  writeManagementDashboardLayouts,
  type DashboardKeyboardAdjustment,
  type ManagementDashboardBreakpoint,
  type ManagementDashboardId,
  type ManagementDashboardLayouts
} from "../../lib/management-dashboard-layout.js";
import { ManagementWidgetSkeleton } from "./ManagementSkeleton.js";
import { PanelHeaderAction } from "./PanelHeader.js";

export interface ManagementDashboardItem {
  id: string;
  title: string;
  content: ReactNode;
}

export interface ManagementDashboardController {
  dashboardId: ManagementDashboardId;
  layouts: ManagementDashboardLayouts;
  breakpoint: ManagementDashboardBreakpoint;
  editing: boolean;
  compact: boolean;
  announcement: string;
  setBreakpoint: (breakpoint: ManagementDashboardBreakpoint) => void;
  setCompact: (compact: boolean) => void;
  setEditing: (editing: boolean) => void;
  setLayouts: (layouts: ResponsiveLayouts<ManagementDashboardBreakpoint>) => void;
  reset: () => void;
  adjust: (widgetId: string, adjustment: DashboardKeyboardAdjustment, announcement: string) => void;
}

export function useManagementDashboard(dashboardId: ManagementDashboardId): ManagementDashboardController {
  const [layouts, updateLayouts] = useState<ManagementDashboardLayouts>(() => readManagementDashboardLayouts(dashboardId));
  const [breakpoint, setBreakpoint] = useState<ManagementDashboardBreakpoint>("desktop");
  const [editing, setEditing] = useState(false);
  const [compact, setCompact] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const setLayouts = useCallback((next: ResponsiveLayouts<ManagementDashboardBreakpoint>) => {
    updateLayouts((current) => {
      const complete: ManagementDashboardLayouts = {
        desktop: next.desktop ?? current.desktop,
        tablet: next.tablet ?? current.tablet
      };
      if (JSON.stringify(complete) === JSON.stringify(current)) {
        return current;
      }
      writeManagementDashboardLayouts(dashboardId, complete);
      return complete;
    });
  }, [dashboardId]);

  const reset = useCallback(() => {
    const defaults = resetManagementDashboardLayouts(dashboardId);
    updateLayouts(defaults);
    setAnnouncement("");
  }, [dashboardId]);

  const adjust = useCallback((widgetId: string, adjustment: DashboardKeyboardAdjustment, message: string) => {
    updateLayouts((current) => {
      const next = adjustManagementDashboardLayout(current, breakpoint, widgetId, adjustment);
      writeManagementDashboardLayouts(dashboardId, next);
      return next;
    });
    setAnnouncement(message);
  }, [breakpoint, dashboardId]);

  return {
    dashboardId,
    layouts,
    breakpoint,
    editing,
    compact,
    announcement,
    setBreakpoint,
    setCompact,
    setEditing,
    setLayouts,
    reset,
    adjust
  };
}

export function ManagementDashboardControls({
  dashboard,
  disabled = false
}: {
  dashboard: ManagementDashboardController;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const unavailable = disabled || dashboard.compact;
  const unavailableTitle = dashboard.compact
    ? t("workspace.management.layout.mobileReadOnly")
    : t("workspace.management.layout.edit");

  return (
    <div className="management-layout-controls">
      {dashboard.editing ? (
        <>
          <PanelHeaderAction
            label={t("workspace.management.layout.reset")}
            type="button"
            onClick={dashboard.reset}
            disabled={unavailable}
          >
            <RotateCcw aria-hidden="true" size={16} />
          </PanelHeaderAction>
          <PanelHeaderAction
            label={t("workspace.management.layout.done")}
            type="button"
            onClick={() => dashboard.setEditing(false)}
            disabled={unavailable}
            aria-pressed="true"
          >
            <Check aria-hidden="true" size={16} />
          </PanelHeaderAction>
        </>
      ) : (
        <PanelHeaderAction
          label={t("workspace.management.layout.edit")}
          tooltip={unavailableTitle}
          type="button"
          onClick={() => dashboard.setEditing(true)}
          disabled={unavailable}
          aria-pressed="false"
        >
          <PanelsTopLeft aria-hidden="true" size={16} />
        </PanelHeaderAction>
      )}
    </div>
  );
}

export function ManagementDashboardGrid({
  dashboard,
  items,
  loading = false
}: {
  dashboard: ManagementDashboardController;
  items: readonly ManagementDashboardItem[];
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 900 });
  const compact = mounted && width < MANAGEMENT_DASHBOARD_MOBILE_MAX_WIDTH;
  const { editing, layouts, setCompact, setEditing } = dashboard;
  const editable = editing && !loading;
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const orderedItems = useMemo(() => {
    const known = new Set<string>();
    const sorted = orderedManagementDashboardWidgetIds(layouts)
      .map((id) => itemById.get(id))
      .filter((item): item is ManagementDashboardItem => {
        if (!item || known.has(item.id)) {
          return false;
        }
        known.add(item.id);
        return true;
      });
    return [...sorted, ...items.filter((item) => !known.has(item.id))];
  }, [itemById, items, layouts]);

  useEffect(() => {
    setCompact(compact);
    if (compact && editing) {
      setEditing(false);
    }
  }, [compact, editing, setCompact, setEditing]);

  return (
    <div
      className="management-dashboard-container"
      ref={containerRef}
      role={loading ? "status" : undefined}
      aria-busy={loading || undefined}
      aria-label={loading ? t("common.states.loading") : undefined}
    >
      {!mounted || compact ? (
        <div className={loading ? "management-dashboard-static is-loading" : "management-dashboard-static"}>
          {orderedItems.map((item) => (
            <DashboardWidget key={item.id} item={item} dashboard={dashboard} editable={false} loading={loading} />
          ))}
        </div>
      ) : (
        <Responsive<ManagementDashboardBreakpoint>
          className={`management-dashboard-grid${editable ? " is-editing" : ""}${loading ? " is-loading" : ""}`}
          width={width}
          layouts={dashboard.layouts}
          breakpoints={MANAGEMENT_DASHBOARD_BREAKPOINTS}
          cols={MANAGEMENT_DASHBOARD_COLUMNS}
          rowHeight={9}
          margin={[12, 12]}
          containerPadding={[0, 0]}
          dragConfig={{ enabled: editable, handle: ".management-widget-drag-handle", bounded: true }}
          resizeConfig={{ enabled: editable, handles: ["se"] }}
          positionStrategy={absoluteStrategy}
          compactor={verticalCompactor}
          onBreakpointChange={dashboard.setBreakpoint}
          onLayoutChange={(_layout, layouts) => dashboard.setLayouts(layouts)}
        >
          {items.map((item) => (
            <div key={item.id}>
              <DashboardWidget item={item} dashboard={dashboard} editable={editable} loading={loading} />
            </div>
          ))}
        </Responsive>
      )}
      <span className="visually-hidden" id={`${dashboard.dashboardId}-layout-instructions`}>
        {t("workspace.management.layout.keyboardInstructions")}
      </span>
      <span className="visually-hidden" role="status" aria-live="polite">{dashboard.announcement}</span>
    </div>
  );
}

function DashboardWidget({
  item,
  dashboard,
  editable,
  loading
}: {
  item: ManagementDashboardItem;
  dashboard: ManagementDashboardController;
  editable: boolean;
  loading: boolean;
}) {
  const { t } = useTranslation();

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const adjustment = keyboardAdjustment(event);
    if (!adjustment || !editable) {
      return;
    }
    event.preventDefault();
    dashboard.adjust(
      item.id,
      adjustment,
      t(adjustment.kind === "move" ? "workspace.management.layout.moved" : "workspace.management.layout.resized", {
        title: item.title
      })
    );
  }

  return (
    <div className="management-dashboard-widget" data-widget-id={item.id} data-editing={editable || undefined}>
      {editable ? (
        <div className="management-widget-chrome">
          <button
            type="button"
            className="management-widget-drag-handle"
            onKeyDown={handleKeyDown}
            title={t("workspace.management.layout.dragHandle", { title: item.title })}
            aria-label={t("workspace.management.layout.dragHandle", { title: item.title })}
            aria-describedby={`${dashboard.dashboardId}-layout-instructions`}
          >
            <GripVertical aria-hidden="true" size={15} />
          </button>
          <span>{item.title}</span>
        </div>
      ) : null}
      <div
        className="management-widget-content"
        data-scroll-region="true"
        role="region"
        tabIndex={0}
        aria-label={item.title}
      >
        {loading ? <ManagementWidgetSkeleton dashboardId={dashboard.dashboardId} widgetId={item.id} /> : item.content}
      </div>
    </div>
  );
}

function keyboardAdjustment(event: KeyboardEvent<HTMLButtonElement>): DashboardKeyboardAdjustment | null {
  const direction = event.key;
  if (!direction.startsWith("Arrow")) {
    return null;
  }
  if (event.shiftKey) {
    if (direction === "ArrowLeft") return { kind: "resize", dw: -1, dh: 0 };
    if (direction === "ArrowRight") return { kind: "resize", dw: 1, dh: 0 };
    if (direction === "ArrowUp") return { kind: "resize", dw: 0, dh: -1 };
    return { kind: "resize", dw: 0, dh: 1 };
  }
  if (direction === "ArrowLeft") return { kind: "move", dx: -1, dy: 0 };
  if (direction === "ArrowRight") return { kind: "move", dx: 1, dy: 0 };
  if (direction === "ArrowUp") return { kind: "move", dx: 0, dy: -1 };
  return { kind: "move", dx: 0, dy: 1 };
}
