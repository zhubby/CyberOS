import { Bell, ChevronLeft, Grid2X2, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { APP_REGISTRY, MOBILE_DOCK_APPS, MOBILE_GRID_APPS, type AppDefinition, type MobileAppId } from "./apps.js";
import { useMobileNavigation } from "./MobileNavigation.js";

export type ConnectionState = "connecting" | "online" | "offline";

export function useMobileConnection(enabled: boolean): ConnectionState {
  const [state, setState] = useState<ConnectionState>("connecting");
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let controller: AbortController | null = null;
    let timeout = 0;
    const check = async () => {
      controller?.abort();
      window.clearTimeout(timeout);
      const request = new AbortController();
      controller = request;
      timeout = window.setTimeout(() => request.abort(), 8_000);
      try {
        const response = await fetch("/health", { cache: "no-store", signal: request.signal });
        if (!disposed && controller === request) setState(response.ok ? "online" : "offline");
      } catch {
        if (!disposed && controller === request) setState("offline");
      } finally {
        if (controller === request) window.clearTimeout(timeout);
      }
    };
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    void check();
    const timer = window.setInterval(visible, 15_000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    window.addEventListener("offline", visible);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearTimeout(timeout);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
      window.removeEventListener("offline", visible);
    };
  }, [enabled]);
  return state;
}

function AppButton({ app, approvalCount, onOpenApp }: { app: AppDefinition; approvalCount: number; onOpenApp: (id: MobileAppId) => void }) {
  const { t } = useTranslation();
  const label = t(app.shortLabelKey);
  const count = app.id === "agent" ? approvalCount : 0;
  return (
    <button type="button" className="mobile-app-icon" data-app-id={app.id} onClick={() => onOpenApp(app.id)} aria-label={count ? `${label}, ${t("chat.pendingApprovalCount", { count })}` : label}>
      <span className="mobile-app-art" aria-hidden="true">
        <app.Icon size={27} strokeWidth={1.6} />
        {count > 0 ? <span className="mobile-app-badge">{count > 99 ? "99+" : count}</span> : null}
      </span>
      <span className="mobile-app-name">{label}</span>
    </button>
  );
}

export function MobileHome({ connection, unreadCount, approvalCount, onOpenApp, onOpenNotifications }: {
  connection: ConnectionState;
  unreadCount: number;
  approvalCount: number;
  onOpenApp: (app: MobileAppId) => void;
  onOpenNotifications: () => void;
}) {
  const { t } = useTranslation();
  const navigation = useMobileNavigation();
  useEffect(() => {
    if (!navigation?.lastApp) return;
    const frame = window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-app-id="${navigation.lastApp}"]`)?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [navigation?.lastApp]);
  return (
    <section className="mobile-home" aria-label={t("mobile.home")}>
      <header className="mobile-home-header">
        <div className="mobile-home-brand">
          <img src="/cyberos-icon.svg" alt="" aria-hidden="true" />
          <div><h1>CyberOS</h1><span className="mobile-connection" data-state={connection} role="status"><i aria-hidden="true" />{t(`mobile.connection.${connection}`)}</span></div>
        </div>
        <button className="mobile-notifications" type="button" onClick={onOpenNotifications} aria-label={t("notifications.center.openWithCount", { count: unreadCount })}>
          <Bell size={21} aria-hidden="true" />
          {unreadCount > 0 ? <span className="mobile-app-badge" aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
        </button>
      </header>
      <nav className="mobile-app-grid" aria-label={t("mobile.apps")}>
        {MOBILE_GRID_APPS.map((app) => <AppButton key={app.id} app={app} approvalCount={approvalCount} onOpenApp={onOpenApp} />)}
      </nav>
      <div className="mobile-home-signature" aria-hidden="true"><span>CYBEROS</span><span>PERSONAL NETWORK SYSTEM</span></div>
    </section>
  );
}

export function MobileDock({ approvalCount, onOpenApp }: { approvalCount: number; onOpenApp: (id: MobileAppId) => void }) {
  const { t } = useTranslation();
  return <nav className="mobile-home-dock" aria-label={t("mobile.dock")}>{MOBILE_DOCK_APPS.map((app) => <AppButton key={app.id} app={app} approvalCount={approvalCount} onOpenApp={onOpenApp} />)}</nav>;
}

export function MobileAppControls({ control }: { control?: "back" | "home" }) {
  const navigation = useMobileNavigation();
  const { t } = useTranslation();
  if (!navigation?.compact) return null;
  return <>
    {control !== "home" ? <button type="button" className="mobile-app-back" aria-label={t("mobile.back")} title={t("mobile.back")} onClick={navigation.goBack}><ChevronLeft size={22} aria-hidden="true" /></button> : null}
    {control !== "back" ? <button type="button" className="mobile-app-home" aria-label={t("mobile.home")} title={t("mobile.home")} onClick={navigation.goHome}><Grid2X2 size={20} aria-hidden="true" /></button> : null}
  </>;
}

export function useAppHeadingFocus() {
  const navigation = useMobileNavigation();
  const ref = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (!navigation?.compact) return;
    const frame = window.requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [navigation?.compact, navigation?.route]);
  return ref;
}

export function MobileAppLoading({ app, className = "" }: { app: MobileAppId; className?: string }) {
  const { t } = useTranslation();
  const compact = useMobileNavigation()?.compact ?? false;
  const headingRef = useAppHeadingFocus();
  const definition = APP_REGISTRY.find((item) => item.id === app)!;
  return (
    <section className={`mobile-app-loading ${className}`}>
      {compact ? <header className="management-header app-titlebar">
        <MobileAppControls control="back" />
        <div className="management-title-copy"><h2 ref={headingRef} tabIndex={-1}>{t(definition.labelKey)}</h2></div>
        <MobileAppControls control="home" />
      </header> : null}
      <div className="mobile-loading-status" role="status"><LoaderCircle className="spin" aria-hidden="true" />{t("status.loading")}</div>
    </section>
  );
}
