import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { StorageSummary } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { NetworkReadinessSummary, StorageHealthCharts } from "./SystemManagementPanel.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("NetworkReadinessSummary", () => {
  it("renders ratio, count, and status as separate data dimensions", () => {
    const html = renderToStaticMarkup(createElement(NetworkReadinessSummary, {
      metrics: { interfaces: 11, connected: 7, addresses: 17, defaultRoutes: 1 },
      locale: "en"
    }));

    expect(html).toContain('data-kind="ratio"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="7"');
    expect(html).toContain('aria-valuemax="11"');
    expect(html).toContain('aria-valuetext="7 / 11"');
    expect(html).toContain('data-kind="count"');
    expect(html).toContain('<data value="17">17</data>');
    expect(html).toContain('data-kind="status"');
    expect(html).toContain('>Ready<');
    expect(html).toContain('>Outbound path available<');
    expect(html).not.toContain("recharts");
  });

  it("reports missing network prerequisites without converting them to percentages", () => {
    const html = renderToStaticMarkup(createElement(NetworkReadinessSummary, {
      metrics: { interfaces: 2, connected: 0, addresses: 0, defaultRoutes: 0 },
      locale: "en"
    }));

    expect(html).toContain('data-kind="status" data-state="warning"');
    expect(html).toContain('>Missing<');
    expect(html).toContain('>No outbound path detected<');
    expect(html).toContain('<data value="0">0</data>');
  });
});

describe("StorageHealthCharts", () => {
  const summary: StorageSummary = {
    collectedAt: "2026-10-29T00:00:00Z",
    status: "partial",
    capabilities: {
      backend: "mdadm",
      canCreatePool: true,
      canDeletePool: true,
      canApplyConfiguration: false
    },
    metrics: {
      pools: 2,
      arrays: 2,
      disks: 4,
      totalBytes: 1_000,
      usedBytes: 250,
      availableBytes: 750,
      smartPassed: 2,
      smartFailed: 1,
      smartUnknown: 1
    },
    pools: [
      {
        id: "pool-ready",
        name: "Ready pool",
        raidPath: "/dev/md0",
        raidLevel: "raid1",
        status: "ready",
        mountpoint: "/cyberos/data/ready",
        filesystem: "btrfs",
        totalBytes: 500,
        usedBytes: 100,
        availableBytes: 400,
        usedPercent: 0.2,
        memberDevices: ["/dev/sda", "/dev/sdb"]
      },
      {
        id: "pool-offline",
        name: "Offline pool",
        raidPath: "/dev/md1",
        raidLevel: "raid1",
        status: "offline",
        mountpoint: null,
        filesystem: null,
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        usedPercent: null,
        memberDevices: ["/dev/sdc", "/dev/sdd"]
      }
    ],
    arrays: [],
    disks: [],
    mounts: [],
    issues: []
  };
  const translate = (key: string, options?: Record<string, unknown>) => String(i18n.t(key as never, options));

  it("renders capacity, SMART, and pool readiness as independent charts", () => {
    const html = renderToStaticMarkup(createElement(StorageHealthCharts, {
      summary,
      locale: "en",
      t: translate
    }));

    expect(html).toContain('data-kind="capacity"');
    expect(html).toContain('data-kind="smart"');
    expect(html).toContain('data-kind="pools"');
    expect(html).toContain('aria-label="Used storage capacity"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('aria-label="SMART results by disk"');
    expect(html).toContain('aria-valuemax="4"');
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain('2 passed, 1 failed, 1 unknown');
    expect(html).toContain('role="list"');
    expect(html).toContain('aria-label="Ready pool: Ready"');
    expect(html).toContain('aria-label="Offline pool: Offline"');
    expect(html).not.toContain("storage-health-chart-center");
  });
});
