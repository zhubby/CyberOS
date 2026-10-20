import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MonitoringAlertIncident, OperationNotification } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { NotificationCenter } from "./NotificationCenter.js";

function notification(
  id: string,
  status: OperationNotification["status"],
  readAt: string | null = null
): OperationNotification {
  return {
    id,
    jobId: `job-${id}`,
    sessionId: "session-1",
    kind: id === "docker" ? "docker" : "file",
    status,
    summary: `Operation ${id}`,
    error: status === "failed" ? "Operation failed" : null,
    readAt,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:01:00.000Z"
  };
}

function incident(): MonitoringAlertIncident {
  return {
    id: "incident-1", source: "metric", ruleId: "rule-1", healthAlertId: null,
    seriesKey: "host", labels: {}, status: "firing", severity: "critical",
    title: "CPU saturation", currentValue: 0.98, firingAt: "2026-09-18T00:00:00.000Z",
    resolvedAt: null, closeReason: null, acknowledgedAt: null, readAt: null,
    createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:01:00.000Z"
  };
}

describe("NotificationCenter", () => {
  it("renders unread state, operation statuses, and drawer controls", async () => {
    await initI18n();
    const notifications = [
      notification("pending", "pending_approval"),
      notification("docker", "running"),
      notification("success", "succeeded", "2026-09-18T00:02:00.000Z"),
      notification("failed", "failed"),
      notification("rejected", "rejected"),
      notification("cancelled", "cancelled")
    ];
    const html = renderToStaticMarkup(createElement(NotificationCenter, {
      open: true,
      loading: false,
      notifications,
      bluetoothTransfers: [],
      alertIncidents: [incident()],
      unreadCount: 105,
      operationUnreadCount: 104,
      bluetoothUnreadCount: 0,
      alertUnreadCount: 1,
      locale: "en",
      onClose: () => undefined,
      onRead: () => undefined,
      onReadAll: () => undefined,
      onReadBluetooth: () => undefined,
      onReadAllBluetooth: () => undefined,
      onReadAlert: () => undefined,
      onReadAllAlerts: () => undefined,
      onAcknowledgeAlert: () => undefined
    }));

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-status="pending_approval"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-status="succeeded"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('data-status="rejected"');
    expect(html).toContain('data-status="cancelled"');
    expect(html).toContain('data-unread="false"');
    expect(html).toContain("Operation failed");
    expect(html).toContain("105");
    expect(html).toContain("Alerts");
  });

  it("renders loading and empty states without overflowing content wrappers", async () => {
    await initI18n();
    await i18n.changeLanguage("zh-CN");
    const render = (loading: boolean) => renderToStaticMarkup(createElement(NotificationCenter, {
      open: true,
      loading,
      notifications: [],
      bluetoothTransfers: [],
      alertIncidents: [],
      unreadCount: 0,
      operationUnreadCount: 0,
      bluetoothUnreadCount: 0,
      alertUnreadCount: 0,
      locale: "zh-CN",
      onClose: () => undefined,
      onRead: () => undefined,
      onReadAll: () => undefined,
      onReadBluetooth: () => undefined,
      onReadAllBluetooth: () => undefined,
      onReadAlert: () => undefined,
      onReadAllAlerts: () => undefined,
      onAcknowledgeAlert: () => undefined
    }));

    expect(render(true)).toContain("正在加载通知");
    expect(render(false)).toContain("暂无操作通知");
  });
});
