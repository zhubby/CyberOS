import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Cpu,
  Database,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  Network,
  RefreshCw,
  Server
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  getMonitoringOverview,
  queryMonitoringMetrics,
  type MonitoringOverview,
  type MonitoringQueryResponse
} from "../../api.js";
import { formatBytes, formatLocaleNumber, formatRelativeTime } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import {
  ManagementDashboardControls,
  ManagementDashboardGrid,
  useManagementDashboard
} from "./ManagementDashboard.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";
import { MonitoringAlertsView } from "./MonitoringAlertsView.js";

const RANGE_OPTIONS = [
  { id: "1h", durationMs: 60 * 60_000, refreshMs: 10_000 },
  { id: "6h", durationMs: 6 * 60 * 60_000, refreshMs: 10_000 },
  { id: "24h", durationMs: 24 * 60 * 60_000, refreshMs: 10_000 },
  { id: "7d", durationMs: 7 * 24 * 60 * 60_000, refreshMs: 60_000 },
  { id: "30d", durationMs: 30 * 24 * 60 * 60_000, refreshMs: 60_000 },
  { id: "1y", durationMs: 365 * 24 * 60 * 60_000, refreshMs: 60_000 }
] as const;

type MonitoringRange = (typeof RANGE_OPTIONS)[number]["id"];
type QuerySeries = MonitoringQueryResponse["series"][number];

const QUERY_SELECTORS = [
  { metric: "zos_host_cpu_usage_ratio" },
  { metric: "zos_host_load1" },
  { metric: "zos_host_memory_used_bytes" },
  { metric: "zos_host_memory_total_bytes" },
  { metric: "zos_host_network_receive_bytes_total", transform: "rate" as const },
  { metric: "zos_host_network_transmit_bytes_total", transform: "rate" as const },
  { metric: "zos_host_disk_read_bytes_total", transform: "rate" as const },
  { metric: "zos_host_disk_written_bytes_total", transform: "rate" as const },
  { metric: "zos_host_filesystem_available_bytes" },
  { metric: "zos_host_filesystem_size_bytes" },
  { metric: "zos_host_temperature_celsius" },
  { metric: "zos_queue_depth" }
];

const CHART_COLORS = [
  "var(--accent-soft-text)",
  "var(--success-text)",
  "var(--warning-text)",
  "var(--danger-text)",
  "var(--muted)"
];

export function monitoringRefreshInterval(range: MonitoringRange): number {
  return RANGE_OPTIONS.find((option) => option.id === range)?.refreshMs ?? 60_000;
}

export function MonitoringPanel({ locale }: { locale: SupportedLocale }) {
  const { t } = useTranslation();
  const dashboard = useManagementDashboard("monitoring");
  const [range, setRange] = useState<MonitoringRange>("1h");
  const [view, setView] = useState<"overview" | "rules" | "incidents">("overview");
  const [overview, setOverview] = useState<MonitoringOverview | null>(null);
  const [query, setQuery] = useState<MonitoringQueryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const rangeConfig = RANGE_OPTIONS.find((option) => option.id === range)!;

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setRefreshing(true);
    const end = new Date();
    const start = new Date(end.getTime() - rangeConfig.durationMs);
    try {
      const [nextOverview, nextQuery] = await Promise.all([
        getMonitoringOverview(),
        queryMonitoringMetrics({
          start: start.toISOString(),
          end: end.toISOString(),
          maxPoints: 720,
          selectors: QUERY_SELECTORS
        })
      ]);
      if (currentRequest !== requestId.current) return;
      setOverview(nextOverview);
      setQuery(nextQuery);
      setError(null);
    } catch (nextError) {
      if (currentRequest !== requestId.current) return;
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [rangeConfig.durationMs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const syncPolling = () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (document.visibilityState === "visible") {
        timer = setInterval(() => void refresh(), rangeConfig.refreshMs);
      }
    };
    const handleVisibility = () => {
      syncPolling();
      if (document.visibilityState === "visible") void refresh();
    };
    syncPolling();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [rangeConfig.refreshMs, refresh]);

  const series = query?.series ?? [];
  const cpuSeries = selectSeries(series, ["zos_host_cpu_usage_ratio", "zos_host_load1"]);
  const memorySeries = selectSeries(series, ["zos_host_memory_used_bytes", "zos_host_memory_total_bytes"]);
  const networkSeries = selectSeries(series, ["zos_host_network_receive_bytes_total", "zos_host_network_transmit_bytes_total"]);
  const diskSeries = selectSeries(series, ["zos_host_disk_read_bytes_total", "zos_host_disk_written_bytes_total"]);
  const temperatureSeries = selectSeries(series, ["zos_host_temperature_celsius"]);
  const currentCpu = latest(overview, "zos_host_cpu_usage_ratio");
  const memoryUsed = latest(overview, "zos_host_memory_used_bytes");
  const memoryTotal = latest(overview, "zos_host_memory_total_bytes");
  const memoryRatio = memoryUsed !== null && memoryTotal ? memoryUsed / memoryTotal : null;
  const networkRate = latestSeriesSum(networkSeries);
  const diskRate = latestSeriesSum(diskSeries);
  const dashboardItems = useMemo(() => [
    {
      id: "overview",
      title: String(t("workspace.monitoring.title")),
      content: <MonitoringOverviewCard overview={overview} locale={locale} />
    },
    metricItem("metric-cpu", String(t("workspace.monitoring.metrics.cpu")), formatPercent(currentCpu, locale), String(t("workspace.monitoring.metrics.current")), Cpu),
    metricItem("metric-memory", String(t("workspace.monitoring.metrics.memory")), formatPercent(memoryRatio, locale), memoryUsed === null ? "-" : formatBytes(memoryUsed, locale), MemoryStick),
    metricItem("metric-network", String(t("workspace.monitoring.metrics.network")), formatRate(networkRate, locale), String(t("workspace.monitoring.metrics.aggregate")), Network),
    metricItem("metric-storage", String(t("workspace.monitoring.metrics.disk")), formatRate(diskRate, locale), String(t("workspace.monitoring.metrics.aggregate")), HardDrive),
    {
      id: "cpu",
      title: String(t("workspace.monitoring.charts.cpu")),
      content: <MonitoringChart title={String(t("workspace.monitoring.charts.cpu"))} description={String(t("workspace.monitoring.charts.cpuDescription"))} series={cpuSeries} locale={locale} valueKind="cpu" />
    },
    {
      id: "memory",
      title: String(t("workspace.monitoring.charts.memory")),
      content: <MonitoringChart title={String(t("workspace.monitoring.charts.memory"))} description={String(t("workspace.monitoring.charts.memoryDescription"))} series={memorySeries} locale={locale} valueKind="bytes" />
    },
    {
      id: "network",
      title: String(t("workspace.monitoring.charts.network")),
      content: <MonitoringChart title={String(t("workspace.monitoring.charts.network"))} description={String(t("workspace.monitoring.charts.networkDescription"))} series={networkSeries} locale={locale} valueKind="rate" />
    },
    {
      id: "disk",
      title: String(t("workspace.monitoring.charts.disk")),
      content: <MonitoringChart title={String(t("workspace.monitoring.charts.disk"))} description={String(t("workspace.monitoring.charts.diskDescription"))} series={diskSeries} locale={locale} valueKind="rate" />
    },
    {
      id: "capacity",
      title: String(t("workspace.monitoring.capacity.title")),
      content: <CapacityPanel overview={overview} locale={locale} />
    },
    {
      id: "temperature",
      title: String(t("workspace.monitoring.charts.temperature")),
      content: <MonitoringChart title={String(t("workspace.monitoring.charts.temperature"))} description={String(t("workspace.monitoring.charts.temperatureDescription"))} series={temperatureSeries} locale={locale} valueKind="temperature" />
    },
    {
      id: "services",
      title: String(t("workspace.monitoring.services.title")),
      content: <ServicesPanel overview={overview} locale={locale} />
    }
  ], [cpuSeries, currentCpu, diskRate, diskSeries, locale, memoryRatio, memorySeries, memoryUsed, networkRate, networkSeries, overview, t, temperatureSeries]);

  const unavailable = error && !overview;
  const initial = loading && !overview;
  const disabled = overview?.status === "disabled";
  const starting = overview?.status === "starting";
  const noticeDetail = error
    ? t("workspace.monitoring.states.partialError")
    : overview?.status === "degraded"
      ? t("workspace.monitoring.states.degradedDetail")
      : t("workspace.monitoring.states.unavailableDetail");

  return (
    <section className="workspace-management monitoring-panel" aria-label={t("workspace.monitoring.title")}>
      <PanelHeader
        icon={<Activity aria-hidden="true" size={20} />}
        title={t("workspace.monitoring.title")}
        subtitle={t("workspace.monitoring.description")}
        actions={<PanelHeaderActions label={t("workspace.monitoring.actions")}>
          <ManagementDashboardControls dashboard={dashboard} disabled={initial || disabled || starting} />
          <PanelHeaderAction
            label={t("common.actions.refresh")}
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-busy={refreshing || undefined}
          >
            {refreshing ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={17} />}
          </PanelHeaderAction>
        </PanelHeaderActions>}
      />

      <nav className="monitoring-view-tabs" role="tablist" aria-label={t("workspace.monitoring.tabs.label")}>
        {(["overview", "rules", "incidents"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={view === tab}
            className={view === tab ? "is-active" : ""}
            onClick={() => setView(tab)}
          >
            {t(`workspace.monitoring.tabs.${tab}`)}
            {tab === "incidents" && overview?.alerts?.unreadCount ? (
              <span aria-label={t("workspace.monitoring.alerts.unread", { count: overview.alerts.unreadCount })}>
                {overview.alerts.unreadCount > 99 ? "99+" : overview.alerts.unreadCount}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {view === "overview" ? <><div className="monitoring-toolbar">
        <div className="monitoring-range" role="group" aria-label={t("workspace.monitoring.range.label")}>
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={range === option.id ? "is-active" : ""}
              aria-pressed={range === option.id}
              onClick={() => setRange(option.id)}
            >
              {t(`workspace.monitoring.range.${option.id}`)}
            </button>
          ))}
        </div>
        {overview ? <MonitoringStatus status={overview.status} sampledAt={overview.sampledAt} locale={locale} /> : null}
      </div>

      {unavailable ? (
        <MonitoringState icon={<Server size={26} />} state="offline" title={t("workspace.monitoring.states.unavailable")} detail={t("workspace.monitoring.states.unavailableDetail")} />
      ) : disabled ? (
        <MonitoringState icon={<Activity size={26} />} state="disabled" title={t("workspace.monitoring.states.disabled")} detail={t("workspace.monitoring.states.disabledDetail")} />
      ) : starting ? (
        <MonitoringState icon={<LoaderCircle className="is-spinning" size={26} />} state="starting" title={t("workspace.monitoring.states.starting")} detail={t("workspace.monitoring.states.startingDetail")} />
      ) : (
        <div className="management-body monitoring-body">
          {overview?.status === "degraded" || overview?.status === "unavailable" || error ? (
            <div className="monitoring-notice" data-state={overview?.status ?? "unavailable"} role="status">
              <Activity aria-hidden="true" size={16} />
              <span>{noticeDetail}</span>
            </div>
          ) : null}
          <ManagementDashboardGrid dashboard={dashboard} items={dashboardItems} loading={initial} />
        </div>
      )}</> : <MonitoringAlertsView view={view} locale={locale} />}
    </section>
  );
}

function MonitoringOverviewCard({ overview, locale }: { overview: MonitoringOverview | null; locale: SupportedLocale }) {
  const { t } = useTranslation();
  const load = ["zos_host_load1", "zos_host_load5", "zos_host_load15"]
    .map((metric) => latest(overview, metric))
    .map((value) => value === null ? "-" : formatLocaleNumber(value, locale, { maximumFractionDigits: 2 }))
    .join(" / ");
  const queues = latestValues(overview, "zos_queue_depth").reduce((total, value) => total + value.value, 0);
  const issues = latestValues(overview, "zos_health_problem_count").reduce((total, value) => total + value.value, 0);
  return (
    <section className="management-command-panel monitoring-overview">
      <div className="management-emblem" aria-hidden="true"><Activity size={31} /></div>
      <div className="management-command-copy">
        <div>
          <span className="management-status-pill" data-state={statusTone(overview?.status)}>
            {t(`workspace.monitoring.states.${overview?.status ?? "starting"}`)}
          </span>
          <h3>{t("workspace.monitoring.overview.title")}</h3>
          <p>{t("workspace.monitoring.overview.detail")}</p>
        </div>
        <dl className="management-fact-list">
          <div><dt>{t("workspace.monitoring.overview.load")}</dt><dd>{load}</dd></div>
          <div><dt>{t("workspace.monitoring.overview.queues")}</dt><dd>{formatLocaleNumber(queues, locale)}</dd></div>
          <div><dt>{t("workspace.monitoring.overview.issues")}</dt><dd>{formatLocaleNumber(issues, locale)}</dd></div>
          <div><dt>{t("workspace.monitoring.overview.database")}</dt><dd>{overview ? formatBytes(overview.retention.databaseBytes, locale) : "-"}</dd></div>
        </dl>
      </div>
    </section>
  );
}

function MonitoringChart({
  title,
  description,
  series,
  locale,
  valueKind
}: {
  title: string;
  description: string;
  series: QuerySeries[];
  locale: SupportedLocale;
  valueKind: "cpu" | "bytes" | "rate" | "temperature";
}) {
  const { t } = useTranslation();
  const definitions = series.map((item, index) => ({
    item,
    key: `value${index}`,
    label: seriesLabel(item, t)
  }));
  const data = mergeMonitoringSeries(definitions, locale, valueKind);
  return (
    <section className="management-section monitoring-chart-section">
      <header className="management-section-header">
        <div><h3>{title}</h3><p>{description}</p></div>
      </header>
      <div className="monitoring-chart" aria-label={title}>
        {data.some((row) => definitions.some((definition) => row[definition.key] !== null && row[definition.key] !== undefined)) ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--line-soft)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "var(--muted-2)", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={28} />
              <YAxis tickFormatter={(value) => shortValue(Number(value), locale, valueKind)} tick={{ fill: "var(--muted-2)", fontSize: 10 }} tickLine={false} axisLine={false} width={48} />
              <Tooltip
                contentStyle={{ background: "var(--modal-bg)", border: "1px solid var(--line)", borderRadius: 5, color: "var(--text)", fontSize: 11 }}
                labelStyle={{ color: "var(--muted)", marginBottom: 4 }}
                formatter={(value, name) => [formatChartValue(Number(value), locale, valueKind), String(name)]}
              />
              {definitions.map((definition, index) => (
                <Line
                  key={definition.key}
                  type="linear"
                  dataKey={definition.key}
                  name={definition.label}
                  connectNulls={false}
                  dot={false}
                  stroke={CHART_COLORS[index % CHART_COLORS.length] ?? "var(--accent-soft-text)"}
                  strokeWidth={1.8}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="monitoring-chart-empty"><Activity aria-hidden="true" size={18} /><span>{t("workspace.monitoring.noData")}</span></div>
        )}
      </div>
      <div className="monitoring-chart-legend" aria-hidden="true">
        {definitions.slice(0, 8).map((definition, index) => (
          <span key={definition.key}><i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />{definition.label}</span>
        ))}
      </div>
    </section>
  );
}

function CapacityPanel({ overview, locale }: { overview: MonitoringOverview | null; locale: SupportedLocale }) {
  const { t } = useTranslation();
  const totals = latestValues(overview, "zos_host_filesystem_size_bytes");
  const available = new Map(latestValues(overview, "zos_host_filesystem_available_bytes")
    .map((value) => [value.labels.filesystem, value.value]));
  return (
    <section className="management-section monitoring-resource-section">
      <header className="management-section-header"><div><h3>{t("workspace.monitoring.capacity.title")}</h3><p>{t("workspace.monitoring.capacity.description")}</p></div></header>
      <div className="management-resource-list">
        {totals.length ? totals.map((total) => {
          const free = available.get(total.labels.filesystem ?? "") ?? 0;
          const used = Math.max(0, total.value - free);
          const ratio = total.value > 0 ? used / total.value : 0;
          return (
            <div key={total.labels.filesystem} className="monitoring-capacity-row">
              <div><strong>{filesystemLabel(total.labels.filesystem ?? "", t)}</strong><span>{formatBytes(used, locale)} / {formatBytes(total.value, locale)}</span></div>
              <div className="monitoring-capacity-track"><span style={{ width: `${Math.min(100, ratio * 100)}%` }} /></div>
              <small>{formatPercent(ratio, locale)}</small>
            </div>
          );
        }) : <div className="monitoring-inline-empty">{t("workspace.monitoring.noData")}</div>}
      </div>
    </section>
  );
}

function ServicesPanel({ overview, locale }: { overview: MonitoringOverview | null; locale: SupportedLocale }) {
  const { t } = useTranslation();
  const services = latestValues(overview, "zos_systemd_unit_active");
  return (
    <section className="management-section monitoring-services-section">
      <header className="management-section-header"><div><h3>{t("workspace.monitoring.services.title")}</h3><p>{t("workspace.monitoring.services.description")}</p></div></header>
      <div className="monitoring-service-grid">
        {services.map((service) => (
          <div key={service.labels.unit} className="monitoring-service-row">
            <Server aria-hidden="true" size={15} />
            <span>{shortUnit(service.labels.unit ?? "")}</span>
            <strong data-state={service.value === 1 ? "ready" : "offline"}>{service.value === 1 ? t("workspace.monitoring.services.active") : t("workspace.monitoring.services.inactive")}</strong>
          </div>
        ))}
        {(overview?.collectors ?? []).map((collector) => (
          <div key={`collector:${collector.collector}`} className="monitoring-service-row">
            <Database aria-hidden="true" size={15} />
            <span>{t("workspace.monitoring.services.collector", { name: collector.collector })}</span>
            <strong data-state={collector.state === "ready" || collector.state === "unsupported" ? "ready" : "offline"}>
              {t(`workspace.monitoring.collectorStates.${collector.state}`)}
            </strong>
            <small>{collector.lastSuccessAt ? formatRelativeTime(collector.lastSuccessAt, locale) : "-"}</small>
          </div>
        ))}
        {!services.length && !overview?.collectors.length ? <div className="monitoring-inline-empty">{t("workspace.monitoring.noData")}</div> : null}
      </div>
    </section>
  );
}

function MonitoringStatus({ status, sampledAt, locale }: { status: MonitoringOverview["status"]; sampledAt: string; locale: SupportedLocale }) {
  const { t } = useTranslation();
  return <span className="monitoring-live-status" data-state={statusTone(status)}><i />{t(`workspace.monitoring.states.${status}`)} · {formatRelativeTime(sampledAt, locale)}</span>;
}

function MonitoringState({ icon, state, title, detail }: { icon: ReactNode; state: string; title: ReactNode; detail: ReactNode }) {
  return <div className="monitoring-state" data-state={state} role="status">{icon}<strong>{title}</strong><p>{detail}</p></div>;
}

function metricItem(
  id: string,
  label: string,
  value: string,
  detail: string,
  Icon: typeof Cpu
) {
  return {
    id,
    title: label,
    content: <article className="management-metric"><Icon aria-hidden="true" size={18} /><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>
  };
}

function selectSeries(series: QuerySeries[], metrics: string[]): QuerySeries[] {
  const selected = new Set(metrics);
  return series.filter((item) => selected.has(item.metric));
}

function latest(overview: MonitoringOverview | null, metric: string): number | null {
  return latestValues(overview, metric)[0]?.value ?? null;
}

function latestValues(overview: MonitoringOverview | null, metric: string) {
  return overview?.latest.filter((item) => item.metric === metric) ?? [];
}

function latestSeriesSum(series: QuerySeries[]): number | null {
  const values = series.flatMap((item) => {
    const value = [...item.points].reverse().find((point) => point.value !== null)?.value;
    return value === null || value === undefined ? [] : [value];
  });
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

export function mergeMonitoringSeries(
  definitions: Array<{ item: QuerySeries; key: string; label: string }>,
  locale: SupportedLocale,
  valueKind: "cpu" | "bytes" | "rate" | "temperature"
): Array<Record<string, string | number | null>> {
  const rows = new Map<string, Record<string, string | number | null>>();
  for (const definition of definitions) {
    for (const point of definition.item.points) {
      const row = rows.get(point.timestamp) ?? {
        timestamp: point.timestamp,
        label: formatChartTimestamp(point.timestamp, locale)
      };
      row[definition.key] = point.value === null
        ? null
        : valueKind === "cpu" && definition.item.metric === "zos_host_cpu_usage_ratio"
          ? point.value * 100
          : point.value;
      rows.set(point.timestamp, row);
    }
  }
  return [...rows.values()].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
}

function seriesLabel(series: QuerySeries, t: (key: string) => unknown): string {
  const direction = series.metric.includes("receive") || series.metric.includes("read_") ? t("workspace.monitoring.series.read")
    : series.metric.includes("transmit") || series.metric.includes("written") ? t("workspace.monitoring.series.write")
      : series.metric.includes("cpu_usage") ? t("workspace.monitoring.metrics.cpu")
        : series.metric.includes("load1") ? t("workspace.monitoring.overview.load1")
          : series.metric.includes("memory_used") ? t("workspace.monitoring.series.used")
            : series.metric.includes("memory_total") ? t("workspace.monitoring.series.total")
              : t("workspace.monitoring.series.value");
  const labels = Object.values(series.labels);
  return labels.length ? `${direction} · ${labels.join(" · ")}` : String(direction);
}

function formatChartTimestamp(value: string, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatChartValue(value: number, locale: SupportedLocale, kind: "cpu" | "bytes" | "rate" | "temperature"): string {
  if (kind === "bytes") return formatBytes(value, locale);
  if (kind === "rate") return `${formatBytes(value, locale)}/s`;
  if (kind === "temperature") return `${formatLocaleNumber(value, locale, { maximumFractionDigits: 1 })} °C`;
  return `${formatLocaleNumber(value, locale, { maximumFractionDigits: 2 })}${value > 10 ? "%" : ""}`;
}

function shortValue(value: number, locale: SupportedLocale, kind: "cpu" | "bytes" | "rate" | "temperature"): string {
  if (kind === "bytes" || kind === "rate") return formatBytes(value, locale);
  if (kind === "temperature") return `${formatLocaleNumber(value, locale, { maximumFractionDigits: 0 })}°`;
  return formatLocaleNumber(value, locale, { maximumFractionDigits: 1 });
}

function formatPercent(value: number | null, locale: SupportedLocale): string {
  return value === null ? "-" : `${formatLocaleNumber(value * 100, locale, { maximumFractionDigits: 1 })}%`;
}

function formatRate(value: number | null, locale: SupportedLocale): string {
  return value === null ? "-" : `${formatBytes(value, locale)}/s`;
}

function statusTone(status: MonitoringOverview["status"] | undefined): "ready" | "warning" | "offline" | "neutral" {
  if (status === "ready") return "ready";
  if (status === "degraded") return "warning";
  if (status === "unavailable") return "offline";
  return "neutral";
}

function filesystemLabel(value: string, t: (key: string) => unknown): string {
  if (value === "state") return String(t("workspace.monitoring.capacity.state"));
  return value.startsWith("nas:") ? `${t("workspace.monitoring.capacity.nas")} · ${value.slice(4)}` : value;
}

function shortUnit(value: string): string {
  return value.replace(/^zos-/u, "").replace(/\.service$/u, "");
}
