import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { MonitoringQueryResponse } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import {
  MonitoringPanel,
  mergeMonitoringSamples,
  mergeMonitoringSeries
} from "./MonitoringPanel.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("MonitoringPanel", () => {
  it("renders every time range and a stable dashboard skeleton", () => {
    const html = renderToStaticMarkup(createElement(MonitoringPanel, { locale: "en" }));

    expect(html).toContain("Monitoring");
    expect(html).toContain('class="view-tabs monitoring-view-tabs"');
    expect(html).toContain('class="monitoring-overview-stage"');
    expect(html).toContain('class="monitoring-toolbar" role="toolbar"');
    expect(html).toContain('class="monitoring-toolbar-selection"');
    expect(html).toContain('class="monitoring-range-wrap"');
    expect(html).toContain('role="tab" aria-selected="true">Overview</button>');
    for (const label of ["1h", "6h", "24h", "7d", "30d", "1y"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    for (const widget of ["overview", "cpu", "memory", "network", "disk", "capacity", "temperature", "services"]) {
      expect(html).toContain(`data-widget-id="${widget}"`);
    }
  });

  it("does not mount charts or polling while the mobile workspace is hidden", () => {
    const html = renderToStaticMarkup(createElement(MonitoringPanel, {
      locale: "en",
      visible: false
    }));

    expect(html).toBe("");
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

  it("merges committed samples without interpolating missing points", () => {
    const current = {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T00:01:00.000Z",
      series: [{
        metric: "zos_host_cpu_usage_ratio",
        labels: {},
        transform: "value",
        resolution: "raw",
        stepMs: 10_000,
        points: [
          { timestamp: "2026-01-01T00:00:00.000Z", value: 0.2 },
          { timestamp: "2026-01-01T00:00:10.000Z", value: null }
        ]
      }]
    } satisfies MonitoringQueryResponse;
    const next = mergeMonitoringSamples(current, {
      protocolVersion: 1,
      source: "monitor",
      sequence: 1,
      type: "samples",
      sampledAt: "2026-01-01T00:00:20.000Z",
      status: "ready",
      collectors: [],
      samples: [{
        metric: "zos_host_cpu_usage_ratio",
        labels: {},
        timestamp: "2026-01-01T00:00:20.000Z",
        value: 0.4,
        rate: null
      }]
    }, 60_000);
    expect(next.series[0]?.points.at(-1)?.value).toBe(0.4);
    expect(next.series[0]?.points.some((point) => point.value === null)).toBe(true);
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
