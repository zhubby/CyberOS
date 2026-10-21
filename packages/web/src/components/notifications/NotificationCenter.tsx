import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Ban,
  Bell,
  Bluetooth,
  CheckCheck,
  CircleCheck,
  CircleX,
  Clock3,
  Container,
  FileCog,
  HardDrive,
  Inbox,
  LoaderCircle,
  MonitorCog,
  Share2,
  Send,
  ShieldAlert,
  Volume2,
  X
} from "lucide-react";
import type { BluetoothTransfer, MonitoringAlertIncident, OperationNotification } from "../../api.js";
import { formatBytes } from "../../i18n/format.js";
import { formatDate, formatRelativeTime } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function NotificationCenter({
  open,
  loading,
  notifications,
  bluetoothTransfers,
  alertIncidents,
  unreadCount,
  operationUnreadCount,
  bluetoothUnreadCount,
  alertUnreadCount,
  locale,
  onClose,
  onRead,
  onReadAll,
  onReadBluetooth,
  onReadAllBluetooth,
  onReadAlert,
  onReadAllAlerts,
  onAcknowledgeAlert
}: {
  open: boolean;
  loading: boolean;
  notifications: OperationNotification[];
  bluetoothTransfers: BluetoothTransfer[];
  alertIncidents: MonitoringAlertIncident[];
  unreadCount: number;
  operationUnreadCount: number;
  bluetoothUnreadCount: number;
  alertUnreadCount: number;
  locale: SupportedLocale;
  onClose: () => void;
  onRead: (id: string) => void;
  onReadAll: () => void;
  onReadBluetooth: (id: string) => void;
  onReadAllBluetooth: () => void;
  onReadAlert: (id: string) => void;
  onReadAllAlerts: () => void;
  onAcknowledgeAlert: (id: string) => void;
}) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [activeTab, setActiveTab] = useState<"operations" | "bluetooth" | "alerts">("operations");
  const activeUnreadCount = activeTab === "operations"
    ? operationUnreadCount
    : activeTab === "bluetooth"
      ? bluetoothUnreadCount
      : alertUnreadCount;
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const focusable = [...(drawerRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="notification-drawer-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={drawerRef}
        className="notification-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-center-title"
        tabIndex={-1}
      >
        <header className="notification-drawer-header">
          <div>
            <span className="eyebrow">{t("notifications.center.eyebrow")}</span>
            <h2 id="notification-center-title">{t("notifications.center.title")}</h2>
          </div>
          <div className="notification-drawer-actions">
            <button
              type="button"
              onClick={activeTab === "operations" ? onReadAll : activeTab === "bluetooth" ? onReadAllBluetooth : onReadAllAlerts}
              disabled={activeUnreadCount === 0}
              title={t("notifications.center.markAllRead")}
              aria-label={t("notifications.center.markAllRead")}
            >
              <CheckCheck aria-hidden="true" size={17} />
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              title={t("common.actions.close")}
              aria-label={t("common.actions.close")}
            >
              <X aria-hidden="true" size={17} />
            </button>
          </div>
        </header>

        <div className="notification-drawer-summary" aria-live="polite">
          <Bell aria-hidden="true" size={14} />
          <span>{t("notifications.center.unreadCount", { count: unreadCount })}</span>
        </div>

        <div className="notification-tabs" role="tablist" aria-label={t("notifications.center.tabs.label")}>
          <button type="button" role="tab" aria-selected={activeTab === "operations"} onClick={() => setActiveTab("operations")}>
            {t("notifications.center.tabs.operations")}<span>{operationUnreadCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={activeTab === "bluetooth"} onClick={() => setActiveTab("bluetooth")}>
            {t("notifications.center.tabs.bluetooth")}<span>{bluetoothUnreadCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={activeTab === "alerts"} onClick={() => setActiveTab("alerts")}>
            {t("notifications.center.tabs.alerts")}<span>{alertUnreadCount}</span>
          </button>
        </div>

        <div className="notification-list" role="tabpanel">
          {activeTab === "operations" ? (
            <OperationsList
              loading={loading}
              notifications={notifications}
              locale={locale}
              now={now}
              onRead={onRead}
              t={translate}
            />
          ) : activeTab === "bluetooth" ? (
            <BluetoothTransfersList
              loading={loading}
              transfers={bluetoothTransfers}
              locale={locale}
              now={now}
              onRead={onReadBluetooth}
              t={translate}
            />
          ) : (
            <AlertsList
              loading={loading}
              incidents={alertIncidents}
              locale={locale}
              now={now}
              onRead={onReadAlert}
              onAcknowledge={onAcknowledgeAlert}
              t={translate}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function BluetoothTransfersList({ loading, transfers, locale, now, onRead, t }: {
  loading: boolean;
  transfers: BluetoothTransfer[];
  locale: SupportedLocale;
  now: number;
  onRead: (id: string) => void;
  t: Translate;
}) {
  if (loading && transfers.length === 0) {
    return <div className="notification-empty" role="status"><LoaderCircle className="notification-spinner" aria-hidden="true" size={20} /><span>{t("notifications.center.loading")}</span></div>;
  }
  if (transfers.length === 0) {
    return <div className="notification-empty"><Bluetooth aria-hidden="true" size={20} /><strong>{t("notifications.center.bluetooth.emptyTitle")}</strong><span>{t("notifications.center.bluetooth.emptyBody")}</span></div>;
  }
  return <>{transfers.map((transfer) => {
    const timestamp = transfer.finishedAt ?? transfer.updatedAt;
    const relativeTime = formatRelativeTime(timestamp, locale, now);
    const absoluteTime = formatDate(timestamp, locale);
    const Icon = transfer.direction === "send" ? Send : Inbox;
    return <button type="button" key={transfer.id} className="notification-item" data-status={transfer.status} data-unread={transfer.readAt === null ? "true" : "false"} onClick={() => onRead(transfer.id)} aria-label={`${transfer.displayName}. ${t(`settings.bluetooth.transfers.statuses.${transfer.status}`)}`}>
      <span className="notification-status-icon" aria-hidden="true"><Icon size={17} /></span>
      <span className="notification-item-content">
        <span className="notification-item-title"><Bluetooth aria-hidden="true" size={14} /><strong>{transfer.displayName}</strong></span>
        <span className="notification-item-summary">{t(`settings.bluetooth.transfers.directions.${transfer.direction}`)} · {t(`settings.bluetooth.transfers.statuses.${transfer.status}`)} · {formatBytes(transfer.transferredBytes, locale)}{transfer.totalBytes === null ? "" : ` / ${formatBytes(transfer.totalBytes, locale)}`}</span>
        {transfer.error ? <span className="notification-item-error">{transfer.error}</span> : null}
        <time dateTime={timestamp} title={absoluteTime}>{relativeTime}</time>
      </span>
      {transfer.readAt === null ? <span className="notification-unread-dot" aria-hidden="true" /> : null}
    </button>;
  })}</>;
}

function OperationsList({ loading, notifications, locale, now, onRead, t }: {
  loading: boolean;
  notifications: OperationNotification[];
  locale: SupportedLocale;
  now: number;
  onRead: (id: string) => void;
  t: Translate;
}) {
  return <>
          {loading && notifications.length === 0 ? (
            <div className="notification-empty" role="status">
              <LoaderCircle className="notification-spinner" aria-hidden="true" size={20} />
              <span>{t("notifications.center.loading")}</span>
            </div>
          ) : notifications.length === 0 ? (
            <div className="notification-empty">
              <Bell aria-hidden="true" size={20} />
              <strong>{t("notifications.center.emptyTitle")}</strong>
              <span>{t("notifications.center.emptyBody")}</span>
            </div>
          ) : (
            notifications.map((notification) => {
              const StatusIcon = notificationStatusIcon(notification.status);
              const KindIcon = notificationKindIcon(notification.kind);
              const relativeTime = formatRelativeTime(notification.updatedAt, locale, now);
              const absoluteTime = formatDate(notification.updatedAt, locale);
              return (
                <button
                  type="button"
                  key={notification.id}
                  className="notification-item"
                  data-status={notification.status}
                  data-unread={notification.readAt === null ? "true" : "false"}
                  onClick={() => onRead(notification.id)}
                  aria-label={`${notificationTitle(notification, t)}. ${notification.summary}`}
                >
                  <span className="notification-status-icon" aria-hidden="true">
                    <StatusIcon size={17} />
                  </span>
                  <span className="notification-item-content">
                    <span className="notification-item-title">
                      <KindIcon aria-hidden="true" size={14} />
                      <strong>{notificationTitle(notification, t)}</strong>
                    </span>
                    <span className="notification-item-summary">{notification.summary}</span>
                    {notification.error ? <span className="notification-item-error">{notification.error}</span> : null}
                    <time dateTime={notification.updatedAt} title={absoluteTime}>{relativeTime}</time>
                  </span>
                  {notification.readAt === null ? <span className="notification-unread-dot" aria-hidden="true" /> : null}
                </button>
              );
            })
          )}
  </>;
}

function AlertsList({ loading, incidents, locale, now, onRead, onAcknowledge, t }: {
  loading: boolean;
  incidents: MonitoringAlertIncident[];
  locale: SupportedLocale;
  now: number;
  onRead: (id: string) => void;
  onAcknowledge: (id: string) => void;
  t: Translate;
}) {
  if (loading && incidents.length === 0) {
    return <div className="notification-empty" role="status"><LoaderCircle className="notification-spinner" aria-hidden="true" size={20} /><span>{t("notifications.center.loading")}</span></div>;
  }
  if (incidents.length === 0) {
    return <div className="notification-empty"><ShieldAlert aria-hidden="true" size={20} /><strong>{t("notifications.center.alerts.emptyTitle")}</strong><span>{t("notifications.center.alerts.emptyBody")}</span></div>;
  }
  return <>{incidents.map((incident) => {
    const timestamp = incident.resolvedAt ?? incident.firingAt;
    const relativeTime = formatRelativeTime(timestamp, locale, now);
    const absoluteTime = formatDate(timestamp, locale);
    return <article key={incident.id} className="notification-item notification-alert-item" data-status={incident.status} data-severity={incident.severity} data-unread={incident.readAt === null ? "true" : "false"}>
      <span className="notification-status-icon" aria-hidden="true"><ShieldAlert size={17} /></span>
      <button type="button" className="notification-alert-content" onClick={() => onRead(incident.id)} aria-label={`${incident.title}. ${t(`notifications.center.alerts.statuses.${incident.status}`)}`}>
        <span className="notification-item-title"><strong>{incident.title}</strong></span>
        <span className="notification-item-summary">{t(`notifications.center.alerts.statuses.${incident.status}`)} · {t(`notifications.center.alerts.severity.${incident.severity}`)}{incident.occurrenceCount > 1 ? ` · ${t("notifications.center.alerts.occurrences", { count: incident.occurrenceCount })}` : ""}</span>
        <time dateTime={timestamp} title={absoluteTime}>{relativeTime}</time>
      </button>
      <span className="notification-alert-actions">
        {incident.status === "firing" && incident.acknowledgedAt === null ? <button type="button" onClick={() => onAcknowledge(incident.id)}>{t("notifications.center.alerts.acknowledge")}</button> : null}
        {incident.readAt === null ? <span className="notification-unread-dot" aria-hidden="true" /> : null}
      </span>
    </article>;
  })}</>;
}

export function notificationTitle(notification: OperationNotification, t: Translate): string {
  return t("notifications.center.itemTitle", {
    kind: t(`notifications.center.kinds.${notification.kind}`),
    status: t(`notifications.center.statuses.${notification.status}`)
  });
}

function notificationStatusIcon(status: OperationNotification["status"]) {
  if (status === "pending_approval") return Clock3;
  if (status === "running") return LoaderCircle;
  if (status === "succeeded") return CircleCheck;
  if (status === "rejected") return Ban;
  return CircleX;
}

function notificationKindIcon(kind: OperationNotification["kind"]) {
  if (kind === "docker") return Container;
  if (kind === "vm") return MonitorCog;
  if (kind === "storage") return HardDrive;
  if (kind === "share") return Share2;
  if (kind === "media") return Volume2;
  return FileCog;
}
