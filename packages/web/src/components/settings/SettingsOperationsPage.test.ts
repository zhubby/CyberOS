import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { operationsPollInterval, SettingsOperationsPage } from "./SettingsOperationsPage.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("SettingsOperationsPage", () => {
  it("shows task status, schedules, run controls, and recent history", () => {
    const html = renderToStaticMarkup(createElement(SettingsOperationsPage, {
      locale: "en",
      onClose: vi.fn(),
      initialData: {
        tasks: {
          health: { task: "health", status: "ready", lastRunAt: "2026-10-12T00:00:00.000Z", lastSuccessAt: "2026-10-12T00:00:10.000Z", lastDurationMs: 10_000, error: null },
          maintenance: { task: "maintenance", status: "failed", lastRunAt: "2026-10-11T04:30:00.000Z", lastSuccessAt: null, lastDurationMs: 2_000, error: "checkpoint failed" }
        },
        runs: [
          { id: "run-1", task: "health", status: "completed", startedAt: "2026-10-12T00:00:00.000Z", heartbeatAt: "2026-10-12T00:00:10.000Z", finishedAt: "2026-10-12T00:00:10.000Z", summary: {}, error: null }
        ]
      },
      loadOperations: vi.fn(),
      runOperation: vi.fn()
    }));

    expect(html).toContain("Every 15 minutes");
    expect(html).toContain("Daily at 04:30");
    expect(html).toContain("checkpoint failed");
    expect(html).toContain("Run now");
    expect(html).toContain("Run history");
    expect(html).toContain('role="tablist"');
  });

  it("uses five-second active polling and thirty-second idle polling", () => {
    expect(operationsPollInterval(true)).toBe(5_000);
    expect(operationsPollInterval(false)).toBe(30_000);
  });
});
