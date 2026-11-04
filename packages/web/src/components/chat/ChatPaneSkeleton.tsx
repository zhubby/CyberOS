import { Bot, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MobileAppHeader, useAppHeadingFocus } from "../../mobile/MobileAppHeader.js";
import { useMobileNavigation } from "../../mobile/MobileNavigation.js";
import { PanelHeaderAction, PanelHeaderActions } from "../workspace/PanelHeader.js";

export function ChatPaneSkeleton({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const compact = useMobileNavigation()?.compact ?? false;
  const headingRef = useAppHeadingFocus();
  const busyAction = <PanelHeaderActions label={t("mobile.more")}>
    <PanelHeaderAction label={t("status.loading")} disabled aria-busy="true" mobilePrimary>
      <LoaderCircle className="composer-spinner" size={17} aria-hidden="true" />
    </PanelHeaderAction>
  </PanelHeaderActions>;

  return (
    <section className={`chat-pane chat-loading ${active ? "is-mobile-active" : ""}`} aria-label={t("chat.agents")} aria-busy="true" aria-hidden={compact && !active ? true : undefined} inert={compact && !active ? true : undefined}>
      <span className="visually-hidden" role="status">{t("status.loading")}</span>
      {!compact ? <aside className="agent-list" aria-hidden="true">
        <div className="brand"><img className="agent-brand-logo" src="/cyberos-icon.svg" alt="" /></div>
        <div className="agent-list-head"><span className="management-skeleton-block chat-skeleton-control" /></div>
        <div className="session-list">{[0, 1, 2].map((index) => <span key={index} className="management-skeleton-block chat-skeleton-control" />)}</div>
        <div className="agent-footer">{[0, 1, 2, 3].map((index) => <span key={index} className="management-skeleton-block chat-skeleton-control" />)}</div>
      </aside> : null}
      {!compact || active ? <section className="chat-main" aria-label={t("chat.agentChat")}>
        {compact ? <MobileAppHeader
          className="chat-header"
          icon={<Bot size={20} />}
          title={t("mobile.agent")}
          subtitle={<span className="management-skeleton-block chat-skeleton-title" aria-hidden="true" />}
          headingRef={headingRef}
          actions={busyAction}
        /> : <header className="chat-header app-titlebar">
          <span className="management-skeleton-block chat-skeleton-control" aria-hidden="true" />
          <div className="chat-header-copy"><h2 ref={headingRef}><span className="visually-hidden">{t("mobile.agent")}</span><span className="management-skeleton-block chat-skeleton-title" aria-hidden="true" /></h2></div>
          {busyAction}
        </header>}
        <div className="transcript" role="log" aria-label={t("chat.transcript")} aria-busy="true"><TranscriptSkeleton /></div>
        <div className="composer" aria-hidden="true">
          <span className="management-skeleton-block chat-skeleton-input" />
          <div className="composer-footer"><span className="management-skeleton-block chat-skeleton-title" /><span className="management-skeleton-block chat-skeleton-control" /></div>
        </div>
      </section> : null}
    </section>
  );
}

export function TranscriptSkeleton() {
  return (
    <div className="transcript-skeleton" aria-hidden="true">
      {["assistant", "user", "assistant", "user"].map((role, index) => (
        <div key={`${role}-${index}`} className={`transcript-skeleton-row is-${role}`}>
          <span className="transcript-skeleton-avatar" />
          <span className="transcript-skeleton-copy">
            <span className="transcript-skeleton-heading" />
            <span className="transcript-skeleton-line" />
            <span className="transcript-skeleton-line is-short" />
          </span>
        </div>
      ))}
    </div>
  );
}
