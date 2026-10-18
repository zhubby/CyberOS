import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureNasRoots, openZosDb } from "@zos/db";
import { loadConfig } from "@zos/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFastHostCollector,
  createTemperatureCollector,
  createZosCollector
} from "./collectors.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("monitor collectors", () => {
  it("parses proc fixtures and waits for a CPU baseline", async () => {
    let stat = "cpu 100 0 100 800 0 0 0 0\n";
    const fixture: Record<string, string> = {
      "/proc/loadavg": "0.10 0.20 0.30 1/100 1\n",
      "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n",
      "/proc/diskstats": "8 0 sda 1 0 2 0 3 0 4 0 0 0 0\n7 0 loop0 1 0 9 0 1 0 9 0 0 0 0\n",
      "/proc/net/dev": "Inter-| Receive | Transmit\n eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n lo: 50 0 0 0 0 0 0 0 50 0 0 0 0 0 0 0\n"
    };
    const collector = createFastHostCollector(10_000, {
      async readText(file) {
        if (file === "/proc/stat") return stat;
        return fixture[file] ?? "";
      }
    });

    const first = await collector.collect(1_000);
    expect(first.samples.find((item) => item.metric === "zos_host_cpu_usage_ratio")).toBeUndefined();
    expect(first.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "zos_host_memory_used_bytes", value: 600 * 1024 }),
      expect.objectContaining({ metric: "zos_host_disk_read_bytes_total", value: 1024, labels: { device: "sda" } }),
      expect.objectContaining({ metric: "zos_host_network_transmit_bytes_total", value: 200, labels: { interface: "eth0" } })
    ]));

    stat = "cpu 150 0 150 900 0 0 0 0\n";
    const second = await collector.collect(11_000);
    expect(second.samples.find((item) => item.metric === "zos_host_cpu_usage_ratio")?.value).toBe(0.5);
  });

  it("reports temperature as unsupported when sysfs is unavailable", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const collector = createTemperatureCollector(300_000, {
      async listDirectory() { throw denied; },
      async readText() { return ""; }
    });
    await expect(collector.collect(1_000)).resolves.toEqual({ samples: [], state: "unsupported" });
  });

  it("discovers thermal zones without exposing sysfs paths as labels", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-thermal-"));
    const zone = path.join(tempDir, "thermal_zone0");
    await mkdir(zone);
    await writeFile(path.join(zone, "type"), "cpu package\n");
    await writeFile(path.join(zone, "temp"), "42500\n");

    const result = await createTemperatureCollector(300_000, undefined, tempDir).collect(2_000);
    expect(result.samples).toEqual([expect.objectContaining({
      metric: "zos_host_temperature_celsius",
      value: 42.5,
      labels: { sensor: "cpu_package:0" }
    })]);
  });

  it("recovers after the main database is temporarily unavailable", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-monitor-main-db-"));
    const config = loadConfig({
      ZOS_CONFIG: path.join(tempDir, "missing.toml"),
      ZOS_ROOT: path.join(tempDir, "root")
    } as NodeJS.ProcessEnv, tempDir);
    const collector = createZosCollector(config);
    await expect(collector.collect(1_000)).rejects.toThrow();

    const db = openZosDb(config.databasePath);
    ensureNasRoots(db, config.nasRoots);
    db.close();
    await expect(collector.collect(2_000)).resolves.toEqual(expect.objectContaining({
      samples: expect.arrayContaining([
        expect.objectContaining({ metric: "zos_queue_depth", labels: { queue: "agent" } }),
        expect.objectContaining({ metric: "zos_health_problem_count", labels: { severity: "critical" } })
      ])
    }));
    collector.close?.();
  });
});
