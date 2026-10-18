import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { MonitoringQueryResponse } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import {
  MonitoringPanel,
  mergeMonitoringSeries,
  monitoringRefreshInterval
} from "./MonitoringPanel.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("MonitoringPanel", () => {
  it("renders every time range and a stable dashboard skeleton", () => {
    const html = renderToStaticMarkup(createElement(MonitoringPanel, { locale: "en" }));

    expect(html).toContain("Monitoring");
    for (const label of ["1h", "6h", "24h", "7d", "30d", "1y"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    for (const widget of ["overview", "cpu", "memory", "network", "disk", "capacity", "temperature", "services"]) {
      expect(html).toContain(`data-widget-id="${widget}"`);
    }
  });

  it("keeps missing points null so charts render collection gaps", () => {
    const series = [
      metricSeries("zos_host_memory_used_bytes", [1, null, 3]),
      metricSeries("zos_host_memory_total_bytes", [4, 4, null])
    ];
    const rows = mergeMonitoringSeries(series.map((item, index) => ({
      item,
      key: `value${index}`,
      label: item.metric
    })), "en", "bytes");

    expect(rows.map((row) => [row.value0, row.value1])).toEqual([
      [1, 4],
      [null, 4],
      [3, null]
    ]);
  });

  it("uses fast foreground refresh for short ranges and slow refresh for long ranges", () => {
    expect(monitoringRefreshInterval("1h")).toBe(10_000);
    expect(monitoringRefreshInterval("24h")).toBe(10_000);
    expect(monitoringRefreshInterval("7d")).toBe(60_000);
    expect(monitoringRefreshInterval("1y")).toBe(60_000);
  });
});

function metricSeries(
  metric: string,
  values: Array<number | null>
): MonitoringQueryResponse["series"][number] {
  return {
    metric,
    labels: {},
    transform: "value",
    resolution: "raw",
    stepMs: 10_000,
    points: values.map((value, index) => ({
      timestamp: new Date(index * 10_000).toISOString(),
      value
    }))
  };
}
