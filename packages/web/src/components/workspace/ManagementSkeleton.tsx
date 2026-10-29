import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  managementDashboardWidgetDefinitions,
  type ManagementDashboardId,
  type ManagementDashboardWidgetSize
} from "../../lib/management-dashboard-layout.js";

export function SkeletonBlock({ className = "", width }: { className?: string; width?: string }) {
  const style = width ? ({ "--skeleton-width": width } as CSSProperties) : undefined;
  return <span className={`management-skeleton-block ${className}`.trim()} style={style} aria-hidden="true" />;
}

type WidgetSkeletonKind = "table" | "list" | "chart" | "inventory" | "resources" | "form" | "health";

interface WidgetSkeletonSpec {
  kind: WidgetSkeletonKind;
  columns?: number;
  rows?: number;
}

const MANAGEMENT_WIDGET_SKELETONS = {
  monitoring: {
    cpu: { kind: "chart" },
    memory: { kind: "chart" },
    network: { kind: "chart" },
    disk: { kind: "chart" },
    capacity: { kind: "resources" },
    temperature: { kind: "chart" },
    services: { kind: "list", rows: 5 }
  },
  docker: {
    containers: { kind: "table", columns: 6, rows: 4 },
    images: { kind: "table", columns: 4, rows: 4 },
    pressure: { kind: "chart" },
    networks: { kind: "inventory" },
    storage: { kind: "inventory" },
    compose: { kind: "list", rows: 3 }
  },
  virtualMachines: {
    instances: { kind: "table", columns: 6, rows: 4 },
    resources: { kind: "resources" }
  },
  network: {
    wifi: { kind: "form" },
    traffic: { kind: "chart" },
    interfaces: { kind: "table", columns: 8, rows: 4 },
    routes: { kind: "list", rows: 3 },
    readiness: { kind: "resources", rows: 3 }
  },
  storage: {
    pools: { kind: "table", columns: 6, rows: 4 },
    disks: { kind: "list", rows: 3 },
    health: { kind: "health" }
  },
  shares: {
    account: { kind: "form" },
    services: { kind: "list", rows: 4 },
    directories: { kind: "form" }
  }
} as const satisfies Record<ManagementDashboardId, Record<string, WidgetSkeletonSpec>>;

export function ManagementWidgetSkeleton({
  dashboardId,
  widgetId
}: {
  dashboardId: ManagementDashboardId;
  widgetId: string;
}) {
  const size = managementDashboardWidgetDefinitions(dashboardId).find((widget) => widget.id === widgetId)?.size;
  if (size === "overview") {
    return <OverviewSkeleton />;
  }
  if (size === "metric") {
    return <MetricSkeleton />;
  }

  const spec = (MANAGEMENT_WIDGET_SKELETONS[dashboardId] as Record<string, WidgetSkeletonSpec>)[widgetId]
    ?? fallbackSkeletonSpec(size);
  switch (spec.kind) {
    case "table":
      return <TableSkeleton columns={spec.columns ?? 5} rows={spec.rows ?? 4} />;
    case "list":
      return <ListSkeleton rows={spec.rows ?? 3} />;
    case "chart":
      return <ChartSkeleton />;
    case "inventory":
      return <InventorySkeleton rows={spec.rows ?? 3} />;
    case "resources":
      return <ResourcesSkeleton rows={spec.rows ?? 4} />;
    case "form":
      return <FormSkeleton rows={spec.rows ?? 4} />;
    case "health":
      return <HealthSkeleton />;
  }
}

function fallbackSkeletonSpec(size: ManagementDashboardWidgetSize | undefined): WidgetSkeletonSpec {
  if (size === "wide" || size === "large") {
    return { kind: "table", columns: 5, rows: 4 };
  }
  return { kind: "list", rows: 3 };
}

function OverviewSkeleton() {
  return (
    <section className="management-command-panel management-skeleton-command management-widget-skeleton" data-skeleton-kind="overview" aria-hidden="true">
      <SkeletonBlock className="management-skeleton-emblem" />
      <div className="management-command-copy">
        <SkeletonBlock className="management-skeleton-status" width="92px" />
        <SkeletonBlock className="management-skeleton-title" width="42%" />
        <SkeletonBlock className="management-skeleton-copy-line" width="76%" />
        <dl className="management-fact-list management-skeleton-facts">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index}>
              <SkeletonBlock width="48%" />
              <SkeletonBlock width={index % 2 ? "68%" : "82%"} />
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function MetricSkeleton() {
  return (
    <article className="management-metric management-skeleton-metric management-widget-skeleton" data-skeleton-kind="metric" aria-hidden="true">
      <SkeletonBlock className="management-skeleton-icon" />
      <SkeletonBlock width="62%" />
      <SkeletonBlock className="management-skeleton-metric-value" width="42%" />
      <SkeletonBlock width="74%" />
    </article>
  );
}

function TableSkeleton({ columns, rows }: { columns: number; rows: number }) {
  return (
    <section className="management-section management-table-section management-widget-skeleton" data-skeleton-kind="table" aria-hidden="true">
      <SkeletonSectionHeader />
      <div className="management-table-wrap">
        <div className="management-skeleton-table" style={{ "--skeleton-columns": columns } as CSSProperties}>
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="management-skeleton-table-row">
              {Array.from({ length: columns }, (_, column) => (
                <SkeletonBlock key={column} width={column === 0 ? "72%" : column === columns - 1 ? "48%" : "62%"} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <section className="management-section management-widget-skeleton" data-skeleton-kind="list" aria-hidden="true">
      <SkeletonSectionHeader />
      <SkeletonWorkloadList rows={rows} />
    </section>
  );
}

function SkeletonWorkloadList({ rows }: { rows: number }) {
  return (
    <div className="management-workload-list management-skeleton-list">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="management-workload management-skeleton-workload">
          <SkeletonBlock className="management-skeleton-icon" />
          <div><SkeletonBlock width={index % 2 ? "58%" : "72%"} /><SkeletonBlock width="84%" /></div>
          <SkeletonBlock className="management-skeleton-status" width="52px" />
          <SkeletonBlock width="42px" />
        </div>
      ))}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <section className="management-section management-widget-skeleton" data-skeleton-kind="chart" aria-hidden="true">
      <SkeletonSectionHeader />
      <div className="management-skeleton-chart-body">
        <div className="docker-pressure-stat-grid">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="docker-pressure-stat management-skeleton-pressure-stat">
              <SkeletonBlock width="52%" />
              <SkeletonBlock width="42%" />
              <SkeletonBlock width="64%" />
            </div>
          ))}
        </div>
        <SkeletonBlock className="management-skeleton-pressure-chart" />
        <SkeletonBlock width="56%" />
      </div>
    </section>
  );
}

function InventorySkeleton({ rows }: { rows: number }) {
  return (
    <section className="management-section management-widget-skeleton" data-skeleton-kind="inventory" aria-hidden="true">
      <SkeletonSectionHeader />
      <div className="docker-inventory-list management-skeleton-inventory-list">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="docker-inventory-row">
            <SkeletonBlock className="management-skeleton-icon" />
            <div><SkeletonBlock width={index % 2 ? "62%" : "76%"} /><SkeletonBlock width="48%" /></div>
            <SkeletonBlock width="34px" />
          </div>
        ))}
      </div>
    </section>
  );
}

function ResourcesSkeleton({ rows }: { rows: number }) {
  return (
    <section className="management-section management-widget-skeleton" data-skeleton-kind="resources" aria-hidden="true">
      <SkeletonSectionHeader />
      <div className="management-resource-list management-skeleton-resources">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="management-skeleton-resource">
            <SkeletonBlock width={index % 2 ? "46%" : "58%"} />
            <SkeletonBlock className="management-skeleton-gauge" />
            <SkeletonBlock width="34%" />
          </div>
        ))}
      </div>
    </section>
  );
}

function FormSkeleton({ rows }: { rows: number }) {
  return (
    <section className="management-section management-widget-skeleton" data-skeleton-kind="form" aria-hidden="true">
      <SkeletonSectionHeader />
      <div className="management-skeleton-form">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="management-skeleton-form-field">
            <SkeletonBlock width={index % 2 ? "42%" : "56%"} />
            <SkeletonBlock className="management-skeleton-input" />
          </div>
        ))}
      </div>
    </section>
  );
}

function HealthSkeleton() {
  return (
    <section className="management-section management-widget-skeleton" data-skeleton-kind="health" aria-hidden="true">
      <SkeletonSectionHeader />
      <StorageHealthSkeleton />
    </section>
  );
}

function SkeletonSectionHeader() {
  return (
    <header className="management-section-header management-skeleton-section-header">
      <div>
        <SkeletonBlock className="management-skeleton-section-title" width="42%" />
        <SkeletonBlock width="68%" />
      </div>
    </header>
  );
}

function StorageHealthSkeleton() {
  return (
    <div className="storage-health-chart management-skeleton-storage-health">
      <div className="storage-health-plot-grid">
        {Array.from({ length: 3 }, (_, index) => (
          <div className="storage-health-plot management-skeleton-storage-plot" key={index}>
            <div><SkeletonBlock width={index % 2 ? "58%" : "72%"} /><SkeletonBlock width="38%" /></div>
            <SkeletonBlock width="100%" />
            <SkeletonBlock width={index % 2 ? "64%" : "82%"} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FileListSkeleton({ rows = 7 }: { rows?: number }) {
  const { t } = useTranslation();

  return (
    <div className="file-list-skeleton" role="status" aria-label={t("common.states.loading")}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="file-row file-row-skeleton" aria-hidden="true">
          <span className="file-name"><SkeletonBlock className="file-skeleton-icon" /><SkeletonBlock width={index % 3 === 0 ? "48%" : "64%"} /></span>
          <span className="file-row-actions"><SkeletonBlock className="file-skeleton-action" /><SkeletonBlock className="file-skeleton-action" /></span>
          <SkeletonBlock width={index % 2 ? "34%" : "24%"} />
          <SkeletonBlock width={index % 2 ? "48%" : "38%"} />
        </div>
      ))}
    </div>
  );
}
