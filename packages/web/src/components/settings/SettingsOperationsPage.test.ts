import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import {
  OPERATIONS_HISTORY_LIMIT,
  operationsPollInterval,
  SettingsOperationsPage
} from "./SettingsOperationsPage.js";

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
    expect(html).toContain('aria-label="Run now"');
    const runButtons = html.match(/<button[^>]*settings-operations-run-button[^>]*>[\s\S]*?<\/button>/gu) ?? [];
    expect(runButtons).toHaveLength(2);
    expect(runButtons.every((button) => button.replace(/<[^>]+>/gu, "").trim() === "")).toBe(true);
    expect(html).toContain("Run history");
    expect(html).toContain('role="tablist"');
  });

  it("renders only the five most recent history entries", () => {
    const runs = Array.from({ length: 6 }, (_, index) => ({
      id: `run-${index + 1}`,
      task: "health" as const,
      status: "completed" as const,
      startedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      heartbeatAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:10.000Z`,
      finishedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:10.000Z`,
      summary: {},
      error: null
    }));
    const html = renderToStaticMarkup(createElement(SettingsOperationsPage, {
      locale: "en",
      onClose: vi.fn(),
      initialData: {
        tasks: {
          health: { task: "health", status: "ready", lastRunAt: null, lastSuccessAt: null, lastDurationMs: null, error: null },
          maintenance: { task: "maintenance", status: "never_run", lastRunAt: null, lastSuccessAt: null, lastDurationMs: null, error: null }
        },
        runs
      },
      loadOperations: vi.fn(),
      runOperation: vi.fn()
    }));

    expect(OPERATIONS_HISTORY_LIMIT).toBe(5);
    expect(html.match(/class="settings-operations-run"/gu)).toHaveLength(5);
    expect(html).not.toContain("Oct 6, 2026");
  });

  it("uses five-second active polling and thirty-second idle polling", () => {
    expect(operationsPollInterval(true)).toBe(5_000);
    expect(operationsPollInterval(false)).toBe(30_000);
  });
});
