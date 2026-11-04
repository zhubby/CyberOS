import { ModalPortal } from "../common/ModalPortal.js";
import { Fragment, FormEvent, KeyboardEvent, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Bell,
  Check,
  CircleStop,
  CornerDownLeft,
  ListEnd,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Trash2,
  X
} from "lucide-react";
import remarkGfm from "remark-gfm";
import type {
  CapabilityApproval,
  AgentToolActivity,
  JobStatus,
  ModelProviderSettings,
  StoragePool,
  SessionSummary,
  SystemPowerAction,
  TranscriptMessage
} from "../../api.js";
import type { AppStatus } from "../../config/status.js";
import { providerLabel } from "../../config/settings.js";
import { formatDate, formatRelativeTime, formatTime } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { highlightSource } from "../../preview-utils.js";
import {
  remarkWorkspacePaths,
  resolveWorkspaceMessageLink,
  resolveWorkspaceMessagePath,
  splitWorkspaceMessagePaths
} from "../../lib/chat-paths.js";
import { sessionTitle } from "../../lib/session.js";
import type { TranscriptPhase } from "../../lib/transcript.js";
import { PowerControl } from "../power/PowerControl.js";
import { MobileAppHeader, useAppHeadingFocus } from "../../mobile/MobileAppHeader.js";
import { useMobileNavigation } from "../../mobile/MobileNavigation.js";
import { useModalDialog } from "../workspace/useModalDialog.js";
import { PanelHeaderAction, PanelHeaderActions } from "../workspace/PanelHeader.js";
import { hasActiveAgentTurn } from "../../lib/agent-composer.js";
import { ChatPaneSkeleton } from "./ChatPaneSkeleton.js";
import { useTranscriptScroll } from "./useTranscriptScroll.js";
export { composeAgentMessage, hasActiveAgentTurn } from "../../lib/agent-composer.js";

type CapabilityApprovalRisk = CapabilityApproval["risk"];
type ComposerKeyDownEvent = Pick<KeyboardEvent<HTMLTextAreaElement>, "key" | "shiftKey" | "nativeEvent">;
type ComposerFeedbackState = "sending" | "queued" | "running" | "reconnecting";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type CapabilityDecisionOptions = { confirmed: boolean; secretInput?: Record<string, string> };
export type AgentDeliveryMode = "prompt" | "steer" | "follow_up";
type CapabilitySecretRequirement = {
  name: string;
  label: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
};

export function shouldSubmitComposerMessage(event: ComposerKeyDownEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
}

export function agentSessionHeaderTitle(
  session: SessionSummary | undefined,
  newSessionTitle: string,
  workspaceFallback: string,
  voiceTitle = "System voice session"
): string {
  if (session?.kind === "voice") return voiceTitle;
  if (!session?.firstMessage?.trim() && !session?.lastMessage?.trim()) {
    return newSessionTitle;
  }
  return sessionTitle(session, workspaceFallback);
}

export function composerFeedbackState({
  activeJobId,
  activeJobStatus,
  messageSubmitting,
  status
}: {
  activeJobId: string | null;
  activeJobStatus: JobStatus | null;
  messageSubmitting: boolean;
  status: AppStatus;
}): ComposerFeedbackState | null {
  if (messageSubmitting) {
    return "sending";
  }
  if (!activeJobId) {
    return null;
  }
  if (status === "reconnecting") {
    return "reconnecting";
  }
  if (activeJobStatus === "queued") {
    return "queued";
  }
  if (activeJobStatus === "running") {
    return "running";
  }
  return null;
}

export function composerFeedbackLabel(state: ComposerFeedbackState | null, t: Translate): string | null {
  if (state === "sending") {
    return t("chat.messageStatus.sending");
  }
  if (state === "queued") {
    return t("chat.messageStatus.queued");
  }
  if (state === "running") {
    return t("chat.messageStatus.running");
  }
  if (state === "reconnecting") {
    return t("chat.messageStatus.reconnecting");
  }
  return null;
}

function SessionList({
  sessions,
  activeSessionId,
  workspaceAgentTitle,
  locale,
  ariaLabel,
  onSelectSession
}: {
  sessions: SessionSummary[];
  activeSessionId: string;
  workspaceAgentTitle: string;
  locale: SupportedLocale;
  ariaLabel: string;
  onSelectSession: (session: SessionSummary) => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <nav className="session-list" aria-label={ariaLabel}>
      {sessions.map((item) => {
        const title = item.kind === "voice" ? t("settings.audio.voiceSession") : sessionTitle(item, workspaceAgentTitle);
        const relativeTime = formatRelativeTime(item.updatedAt, locale, now);
        const baseLabel = `${title} - ${relativeTime} (${formatDate(item.updatedAt, locale)})`;
        const label = item.pendingApprovalCount > 0
          ? `${baseLabel}; ${t("chat.pendingApprovalCount", { count: item.pendingApprovalCount })}`
          : baseLabel;

        return (
          <button
            key={item.id}
            type="button"
            className={item.id === activeSessionId ? "session-item is-active" : "session-item"}
            onClick={() => onSelectSession(item)}
            data-tooltip={label}
            aria-label={label}
            aria-current={item.id === activeSessionId ? "page" : undefined}
          >
            {item.kind === "voice" ? <Mic aria-hidden="true" size={19} /> : <Bot aria-hidden="true" size={19} />}
            {item.pendingApprovalCount > 0 ? (
              <span className="session-approval-badge" aria-hidden="true">
                {item.pendingApprovalCount > 9 ? "9+" : item.pendingApprovalCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

export function ChatPane(props: Parameters<typeof ChatPaneContent>[0] & { initialDataLoading?: boolean }) {
  if (props.initialDataLoading || props.transcriptPhase === "idle" || props.transcriptPhase === "loading") {
    return <ChatPaneSkeleton active={props.active} />;
  }
  return <ChatPaneContent {...props} />;
}

function ChatPaneContent({
  active,
  selectedRoot,
  activeSessionSummary,
  sessions,
  activeSessionId,
  transcript,
  transcriptPhase,
  activeCapabilityApprovals,
  agentToolActivities = [],
  message,
  composerPath,
  status,
  locale,
  modelSettings,
  activeJobId,
  activeJobStatus,
  retryJobId = null,
  messageSubmitting,
  hasSession,
  transcriptRef,
  onCreateAgent,
  onDeleteSession,
  onOpenSettings,
  settingsLoading = false,
  onOpenNotifications,
  onRequestSystemPower,
  notificationUnreadCount,
  playbackEntry,
  onSelectSession,
  onApproveCapability,
  onRejectCapability,
  onSubmitMessage,
  onMessageChange,
  onClearComposerPath,
  onCancelActiveJob,
  onRetryInterruptedJob = () => undefined,
  onOpenWorkspacePath
}: {
  active: boolean;
  selectedRoot: StoragePool | undefined;
  activeSessionSummary: SessionSummary | undefined;
  sessions: SessionSummary[];
  activeSessionId: string;
  transcript: TranscriptMessage[];
  transcriptPhase: TranscriptPhase;
  activeCapabilityApprovals: CapabilityApproval[];
  agentToolActivities?: AgentToolActivity[];
  message: string;
  composerPath: string | null;
  status: AppStatus;
  locale: SupportedLocale;
  modelSettings: ModelProviderSettings | null;
  activeJobId: string | null;
  activeJobStatus: JobStatus | null;
  retryJobId?: string | null;
  messageSubmitting: boolean;
  hasSession: boolean;
  transcriptRef: RefObject<HTMLDivElement | null>;
  onCreateAgent: () => void;
  onDeleteSession: () => void;
  onOpenSettings: () => void;
  settingsLoading?: boolean;
  onOpenNotifications: () => void;
  onRequestSystemPower: (action: SystemPowerAction) => Promise<boolean>;
  notificationUnreadCount: number;
  playbackEntry?: ReactNode;
  onSelectSession: (session: SessionSummary) => void;
  onApproveCapability: (approval: CapabilityApproval, options: CapabilityDecisionOptions) => void;
  onRejectCapability: (approval: CapabilityApproval) => void;
  onSubmitMessage: (event: FormEvent<HTMLFormElement>, deliveryMode: AgentDeliveryMode) => void;
  onMessageChange: (message: string) => void;
  onClearComposerPath: () => void;
  onCancelActiveJob: () => void;
  onRetryInterruptedJob?: () => void;
  onOpenWorkspacePath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const compact = useMobileNavigation()?.compact ?? false;
  const headingRef = useAppHeadingFocus();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const sessionsRef = useModalDialog(() => setSessionsOpen(false), false, sessionsOpen && active);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const deleteRef = useModalDialog(() => setDeleteConfirmOpen(false), false, deleteConfirmOpen && active);
  const [approvalDialog, setApprovalDialog] = useState<CapabilityApproval | null>(null);
  const [deliveryMode, setDeliveryMode] = useState<Exclude<AgentDeliveryMode, "prompt">>("follow_up");
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  useTranscriptScroll(transcriptRef, activeSessionId, active, transcript.at(-1));
  const approvalDialogRef = useRef<HTMLElement | null>(null);
  const approvalDialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceAgentTitle = t("chat.workspaceAgent");
  const hasConversationContent = transcript.length > 0
    || activeCapabilityApprovals.length > 0
    || agentToolActivities.length > 0;
  const activeSessionTitle = agentSessionHeaderTitle(activeSessionSummary, t("chat.newSessionTitle"), workspaceAgentTitle, t("settings.audio.voiceSession"));
  const activeSessionIndex = sessions.findIndex((item) => item.id === activeSessionId);
  const activeSessionCode = String((activeSessionIndex >= 0 ? activeSessionIndex : 0) + 1).padStart(2, "0");
  const composerFeedback = composerFeedbackState({ activeJobId, activeJobStatus, messageSubmitting, status });
  const activeAgentTurn = hasActiveAgentTurn(activeJobId, activeJobStatus);
  const deleteDisabled = !activeSessionSummary || activeSessionSummary.kind === "voice" || composerFeedback !== null || status === "cancelling";
  const composerStatusId = "composer-status";
  const ComposerIcon = composerFeedback ? LoaderCircle : Send;
  const composerIconClass = composerFeedback ? "composer-spinner" : undefined;
  const composerStatusLabel = composerFeedbackLabel(composerFeedback, t);
  const modelRoute = modelSettings
    ? `${providerLabel(modelSettings.providerName, t)}/${modelSettings.model || t("settings.modelProvider.notSet")}`
    : t("settings.modelProvider.notLoaded");

  useEffect(() => {
    if (composerPath) {
      composerTextareaRef.current?.focus();
    }
  }, [composerPath]);

  useEffect(() => {
    if (!approvalDialog) return;
    approvalDialogRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeApprovalDialog();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [approvalDialog]);

  function closeApprovalDialog() {
    setApprovalDialog(null);
    queueMicrotask(() => approvalDialogTriggerRef.current?.focus());
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composerPath && !message && (event.key === "Backspace" || event.key === "Delete")) {
      event.preventDefault();
      onClearComposerPath();
      return;
    }
    if (!shouldSubmitComposerMessage(event)) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  const renderCapabilityApprovalCard = (approval: CapabilityApproval) => {
    const proposal = approval.proposal;
    const request = isRecord(proposal.request) ? proposal.request : null;
    const changes = proposal.changes ?? proposal.args ?? request;
    const summary = typeof proposal.summary === "string"
      ? proposal.summary
      : t("chat.capabilityApproval.detail");
    const preview = changes === null || changes === undefined
      ? null
      : typeof changes === "string" ? changes : JSON.stringify(changes, null, 2);
    const proposalTarget = formatApprovalValue(proposal.target);
    const requestTarget = [request?.storagePoolId, request?.sourcePath, request?.targetPath]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" -> ");
    const target = proposalTarget ?? requestTarget;
    const secrets = capabilitySecretRequirements(approval);
    const title = typeof proposal.title === "string" ? proposal.title : approval.run.capabilityId;
    return (
      <article className="approval-card" aria-label={t("chat.pendingApprovals")}>
        <div className="approval-card-icon" aria-hidden="true" data-kind="capability">
          <Settings size={18} />
        </div>
        <div className="approval-card-body">
          <div className="approval-card-head">
            <div>
              <span className="approval-card-kicker">{t("chat.capabilityApproval.kicker")}</span>
              <strong>{title}</strong>
            </div>
            <span className="risk-pill" data-risk={approval.risk}>
              {t("chat.risk", { risk: approvalRiskLabel(approval.risk, translate) })}
            </span>
          </div>
          <p>{summary}</p>
          {preview ? (
            <section className="approval-card-preview">
              <span>{t("chat.capabilityApproval.preview")}</span>
              <pre>{preview}</pre>
            </section>
          ) : null}
          <dl className="approval-card-details">
            <div>
              <dt>{t("chat.capabilityApproval.client")}</dt>
              <dd>{approval.client ? `${approval.client.name} (${approval.client.kind})` : approval.run.subjectKind}</dd>
            </div>
            <div>
              <dt>{t("chat.capabilityApproval.revision")}</dt>
              <dd>{formatApprovalValue(proposal.revision) ?? String(approval.revision)}</dd>
            </div>
            {target ? (
              <div>
                <dt>{t("chat.capabilityApproval.target")}</dt>
                <dd data-tooltip={target}>{target}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t("chat.capabilityApproval.expires")}</dt>
              <dd>{formatTime(approval.expiresAt, locale)}</dd>
            </div>
            {secrets.length ? (
              <div>
                <dt>{t("chat.capabilityApproval.secrets")}</dt>
                <dd>{secrets.map((secret) => secret.label).join(", ")}</dd>
              </div>
            ) : null}
          </dl>
        </div>
        <div className="approval-actions">
          <button
            type="button"
            className="approval-approve"
            onClick={(event) => {
              if (secrets.length > 0 || approval.requiresConfirmation) {
                approvalDialogTriggerRef.current = event.currentTarget;
                setApprovalDialog(approval);
              }
              else onApproveCapability(approval, { confirmed: false });
            }}
            data-tooltip={t("common.actions.approve")}
          >
            <Check aria-hidden="true" size={15} />
            <span>{t("common.actions.approve")}</span>
          </button>
          <button
            type="button"
            className="approval-reject"
            onClick={() => onRejectCapability(approval)}
            data-tooltip={t("common.actions.reject")}
          >
            <X aria-hidden="true" size={15} />
            <span>{t("common.actions.reject")}</span>
          </button>
        </div>
      </article>
    );
  };

  return (
    <section className={`chat-pane ${active ? "is-mobile-active" : ""}`} aria-hidden={compact && !active ? true : undefined} inert={compact && !active ? true : undefined} aria-label={t("chat.agents")}>
      {!compact ? <aside className="agent-list" aria-label={t("chat.agentSessions")}>
        <div className="brand">
          <img className="agent-brand-logo" src="/cyberos-icon.svg" alt="" aria-hidden="true" />
          <h1 className="visually-hidden">{t("common.appName")}</h1>
        </div>

        <div className="agent-list-head">
          <button
            type="button"
            onClick={onCreateAgent}
            data-tooltip={t("common.actions.newAgent")}
            aria-label={t("common.actions.newAgent")}
          >
            <Plus aria-hidden="true" size={18} />
          </button>
        </div>

        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          workspaceAgentTitle={workspaceAgentTitle}
          locale={locale}
          ariaLabel={t("chat.agentSessions")}
          onSelectSession={onSelectSession}
        />

        <div className="agent-footer">
          <div
            className="agent-status-indicator"
            data-state={status}
            role="status"
            data-tooltip={t(`status.${status}`)}
            aria-label={t(`status.${status}`)}
          >
            <span aria-hidden="true" />
          </div>
          <button
            className="agent-notification-button"
            type="button"
            onClick={onOpenNotifications}
            data-tooltip={t("notifications.center.open")}
            aria-label={t("notifications.center.openWithCount", { count: notificationUnreadCount })}
          >
            <Bell aria-hidden="true" size={18} />
            {notificationUnreadCount > 0 ? (
              <span className="notification-badge" aria-hidden="true">
                {notificationUnreadCount > 99 ? "99+" : notificationUnreadCount}
              </span>
            ) : null}
          </button>
          {playbackEntry}
          {/* Keep focus on the trigger while loading so the dialog can restore it on close. */}
          <button
            className="settings-button agent-settings-button"
            type="button"
            onClick={() => { if (!settingsLoading) onOpenSettings(); }}
            aria-disabled={settingsLoading || undefined}
            aria-busy={settingsLoading || undefined}
            data-tooltip={t("common.actions.systemSettings")}
            aria-label={t("common.actions.systemSettings")}
          >
            {settingsLoading ? <LoaderCircle aria-hidden="true" className="spin" size={18} /> : <Settings aria-hidden="true" size={18} />}
          </button>
          <PowerControl onRequest={onRequestSystemPower} />
        </div>
      </aside> : null}

      {!compact || active ? <section className="chat-main" aria-label={t("chat.agentChat")}>
        {compact ? <MobileAppHeader
          className="chat-header"
          icon={<Bot size={20} />}
          title={t("mobile.agent")}
          subtitle={activeSessionTitle}
          headingRef={headingRef}
          actions={<PanelHeaderActions label={t("mobile.more")}>
            <PanelHeaderAction mobilePrimary label={t("mobile.sessions")} onClick={() => setSessionsOpen(true)}><MessageSquare size={20} aria-hidden="true" /></PanelHeaderAction>
            <PanelHeaderAction label={t("chat.deleteSession")} disabled={deleteDisabled} onClick={() => setDeleteConfirmOpen(true)}><Trash2 size={18} aria-hidden="true" /></PanelHeaderAction>
          </PanelHeaderActions>}
        /> : <header className="chat-header app-titlebar">
          <span className="chat-header-index" aria-hidden="true">{activeSessionCode}</span>
          <div className="chat-header-copy">
            <h2 ref={headingRef} tabIndex={compact ? -1 : undefined}>{activeSessionTitle}</h2>
          </div>
          <button
            type="button"
            className="icon-button chat-delete-session-button"
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={deleteDisabled}
            data-tooltip={deleteDisabled && activeSessionSummary ? t("chat.deleteSessionBusy") : t("chat.deleteSession")}
            aria-label={t("chat.deleteSession")}
          >
            <Trash2 aria-hidden="true" size={17} />
          </button>
        </header>}

        <div
          ref={transcriptRef}
          className="transcript"
          role="log"
          aria-label={t("chat.transcript")}
          aria-busy={false}
        >
          <div className="transcript-content">
          {hasConversationContent ? (
            <>
              {transcript.map((item) => (
                <article key={item.id} className={`message message-${item.role}${item.streaming ? " is-streaming" : ""}`}>
                  <div className="avatar" aria-hidden="true">
                    {item.role === "assistant" ? <Bot size={17} /> : <MessageSquare size={17} />}
                  </div>
                  <div>
                    <header>
                      <strong>{item.role === "assistant" ? t("chat.cyberosAgent") : t("chat.you")}</strong>
                      {item.streaming ? <span className="message-meta">{t("chat.streaming")}</span> : null}
                      <time>{formatTime(item.createdAt, locale)}</time>
                    </header>
                    <ChatMessageContent
                      role={item.role}
                      content={item.content}
                      rootPath={selectedRoot?.path ?? null}
                      onOpenWorkspacePath={onOpenWorkspacePath}
                    />
                  </div>
                </article>
              ))}
              {activeCapabilityApprovals.map((approval) => (
                <article key={`capability-approval-${approval.id}`} className="message message-assistant message-approval">
                  <div className="avatar" aria-hidden="true">
                    <Bot size={17} />
                  </div>
                  <div>
                    <header>
                      <strong>{t("chat.cyberosAgent")}</strong>
                      <span className="message-meta">{t("chat.approvals")}</span>
                    </header>
                    {renderCapabilityApprovalCard(approval)}
                  </div>
                </article>
              ))}
              {agentToolActivities.length ? (
                <div className="agent-tool-activity" role="status" aria-live="polite">
                  {agentToolActivities.map((tool) => (
                    <div key={`${tool.runId}:${tool.id}`} data-state={tool.status}>
                      {tool.status === "running"
                        ? <LoaderCircle aria-hidden="true" className="composer-spinner" size={14} />
                        : tool.status === "completed"
                          ? <Check aria-hidden="true" size={14} />
                          : <X aria-hidden="true" size={14} />}
                      <span>{tool.name}</span>
                      <small>{t(`chat.toolStatus.${tool.status}`)}</small>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : transcriptPhase === "ready" ? (
            <div className="empty-state">
              <Bot aria-hidden="true" size={22} />
              <strong>{t("chat.emptyTitle")}</strong>
              <span>{t("chat.emptyBody")}</span>
            </div>
          ) : null}
          </div>
        </div>

        <form
          className="composer"
          onSubmit={(event) => onSubmitMessage(event, activeAgentTurn ? deliveryMode : "prompt")}
          aria-busy={messageSubmitting}
        >
          {composerPath ? (
            <div className="composer-path-block" role="group" aria-label={t("workspace.actions.sendPathToAgent")}>
              <div className="composer-path-content">
                <MessageSquarePlus aria-hidden="true" size={15} />
                <code data-tooltip={composerPath}>{composerPath}</code>
              </div>
              <button
                type="button"
                className="composer-path-remove"
                onClick={onClearComposerPath}
                data-tooltip={t("common.actions.removePath")}
                aria-label={t("common.actions.removePath")}
              >
                <X aria-hidden="true" size={14} />
              </button>
            </div>
          ) : null}
          <textarea
            ref={composerTextareaRef}
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={t("chat.messagePlaceholder")}
            aria-label={t("chat.messageAria")}
            aria-describedby={composerFeedback ? composerStatusId : undefined}
            rows={3}
          />
          <div className="composer-footer">
            <div
              id={composerStatusId}
              className={composerFeedback ? "composer-status" : "composer-model-config"}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-state={composerFeedback ?? undefined}
              data-tooltip={composerStatusLabel ? `${composerStatusLabel} · ${modelRoute}` : modelRoute}
            >
              {composerFeedback ? (
                <LoaderCircle aria-hidden="true" className="composer-spinner" size={14} />
              ) : (
                <Bot aria-hidden="true" size={14} />
              )}
              <span>{composerStatusLabel ?? modelRoute}</span>
            </div>
            <div className="composer-actions">
              {activeAgentTurn ? (
                <div className="composer-delivery" role="group" aria-label={t("chat.deliveryMode")}>
                  <button
                    type="button"
                    className={deliveryMode === "steer" ? "is-active" : ""}
                    aria-pressed={deliveryMode === "steer"}
                    onClick={() => setDeliveryMode("steer")}
                    data-tooltip={t("chat.steer")}
                    aria-label={t("chat.steer")}
                  >
                    <CornerDownLeft aria-hidden="true" size={15} />
                    <span className="visually-hidden">{t("chat.steer")}</span>
                  </button>
                  <button
                    type="button"
                    className={deliveryMode === "follow_up" ? "is-active" : ""}
                    aria-pressed={deliveryMode === "follow_up"}
                    onClick={() => setDeliveryMode("follow_up")}
                    data-tooltip={t("chat.followUp")}
                    aria-label={t("chat.followUp")}
                  >
                    <ListEnd aria-hidden="true" size={15} />
                    <span className="visually-hidden">{t("chat.followUp")}</span>
                  </button>
                </div>
              ) : null}
              {retryJobId ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={onRetryInterruptedJob}
                  aria-label={t("chat.retryInterrupted")}
                  data-tooltip={t("chat.retryInterrupted")}
                >
                  <RotateCcw aria-hidden="true" size={16} />
                  <span>{t("chat.retry")}</span>
                </button>
              ) : null}
              <button
                className="secondary-button"
                type="button"
                onClick={onCancelActiveJob}
                disabled={!activeJobId || status === "cancelling"}
                aria-label={t("common.actions.stop")}
                data-tooltip={t("common.actions.stop")}
              >
                <CircleStop aria-hidden="true" size={16} />
                <span>{t("common.actions.stop")}</span>
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  !hasSession
                  || (!message.trim() && !composerPath)
                  || messageSubmitting
                  || transcriptPhase === "loading"
                  || status === "cancelling"
                  || (activeJobId !== null && !activeAgentTurn)
                }
                aria-busy={messageSubmitting || undefined}
                aria-label={t("common.actions.send")}
                data-tooltip={t("common.actions.send")}
              >
                <ComposerIcon aria-hidden="true" className={composerIconClass} size={16} />
                <span>{t("common.actions.send")}</span>
              </button>
            </div>
          </div>
        </form>
      </section> : null}

      {compact && sessionsOpen ? <ModalPortal className="mobile-sessions-backdrop" onRequestClose={() => setSessionsOpen(false)} onMouseDown={() => setSessionsOpen(false)}><section ref={sessionsRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="mobile-sessions-title" className="mobile-sessions-dialog" onMouseDown={(event) => event.stopPropagation()}><header><h2 id="mobile-sessions-title">{t("mobile.sessions")}</h2><button type="button" onClick={() => setSessionsOpen(false)} aria-label={t("common.actions.close")}><X size={20} aria-hidden="true" /></button></header><button type="button" className="secondary-button" onClick={() => { onCreateAgent(); setSessionsOpen(false); }}><Plus size={18} aria-hidden="true" />{t("common.actions.newAgent")}</button><SessionList sessions={sessions} activeSessionId={activeSessionId} workspaceAgentTitle={workspaceAgentTitle} locale={locale} ariaLabel={t("chat.agentSessions")} onSelectSession={(item) => { onSelectSession(item); setSessionsOpen(false); }} /></section></ModalPortal> : null}

      {deleteConfirmOpen ? (
        <ModalPortal className="session-delete-backdrop" role="presentation" onRequestClose={() => setDeleteConfirmOpen(false)}>
          <section
            ref={deleteRef}
            tabIndex={-1}
            className="session-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-delete-title"
          >
            <header>
              <span className="eyebrow">{t("chat.deleteSessionEyebrow")}</span>
              <h2 id="session-delete-title">{t("chat.deleteSessionTitle")}</h2>
            </header>
            <p>{t("chat.deleteSessionBody", { title: activeSessionTitle })}</p>
            <footer>
              <button type="button" className="secondary-button" onClick={() => setDeleteConfirmOpen(false)}>
                {t("common.actions.cancel")}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={deleteDisabled}
                onClick={() => {
                  setDeleteConfirmOpen(false);
                  onDeleteSession();
                }}
              >
                <Trash2 aria-hidden="true" size={15} />
                <span>{t("chat.confirmDeleteSession")}</span>
              </button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}

      {approvalDialog ? (
        <ModalPortal
          className="approval-dialog-backdrop"
          onRequestClose={closeApprovalDialog}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeApprovalDialog();
          }}
        >
          <form
            className="approval-secret-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-secret-title"
            ref={(node) => { approvalDialogRef.current = node; }}
            tabIndex={-1}
            onSubmit={(event) => {
              event.preventDefault();
              const approval = approvalDialog;
              const secretInput = Object.fromEntries(
                capabilitySecretRequirements(approval).map(({ name }) => [
                  name,
                  String(new FormData(event.currentTarget).get(name) ?? "")
                ])
              );
              event.currentTarget.reset();
              closeApprovalDialog();
              onApproveCapability(approval, {
                confirmed: approval.requiresConfirmation,
                ...(Object.keys(secretInput).length ? { secretInput } : {})
              });
            }}
          >
            <header>
              <span className="eyebrow">{t("chat.capabilityApproval.kicker")}</span>
              <h2 id="approval-secret-title">{t("chat.capabilityApproval.localConfirmation")}</h2>
            </header>
            <p>{typeof approvalDialog.proposal.summary === "string" ? approvalDialog.proposal.summary : t("chat.capabilityApproval.detail")}</p>
            {capabilitySecretRequirements(approvalDialog).map((requirement) => (
              <label key={requirement.name} className="approval-secret-field">
                <span>{requirement.label}</span>
                <input
                  type="password"
                  name={requirement.name}
                  required
                  minLength={requirement.minLength ?? 1}
                  maxLength={requirement.maxLength ?? 4096}
                  autoComplete="new-password"
                />
                {requirement.description ? <small>{requirement.description}</small> : null}
              </label>
            ))}
            {approvalDialog.requiresConfirmation ? (
              <label className="approval-strong-confirmation">
                <input type="checkbox" required />
                <span>{t("chat.capabilityApproval.confirm")}</span>
              </label>
            ) : null}
            <footer>
              <button type="button" className="secondary-button" onClick={closeApprovalDialog}>
                {t("common.actions.cancel")}
              </button>
              <button type="submit" className={approvalDialog.risk === "high" || approvalDialog.risk === "critical" ? "danger-button" : "primary-button"}>
                <Check aria-hidden="true" size={15} />
                <span>{t("common.actions.approve")}</span>
              </button>
            </footer>
          </form>
        </ModalPortal>
      ) : null}
    </section>
  );
}

function capabilitySecretRequirements(approval: CapabilityApproval): CapabilitySecretRequirement[] {
  const value = approval.proposal.requiredSecrets;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.label !== "string") return [];
    return [{
      name: item.name,
      label: item.label,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(typeof item.minLength === "number" ? { minLength: item.minLength } : {}),
      ...(typeof item.maxLength === "number" ? { maxLength: item.maxLength } : {})
    }];
  });
}

function formatApprovalValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") return JSON.stringify(value);
  return null;
}

export function ChatMessageContent({
  role,
  content,
  rootPath = null,
  onOpenWorkspacePath = () => undefined
}: Pick<TranscriptMessage, "role" | "content"> & {
  rootPath?: string | null;
  onOpenWorkspacePath?: (path: string) => void;
}) {
  if (role !== "assistant") {
    return (
      <p className="message-text">
        {rootPath ? (
          <WorkspacePathText text={content} rootPath={rootPath} onOpenWorkspacePath={onOpenWorkspacePath} />
        ) : (
          content
        )}
      </p>
    );
  }

  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={rootPath ? [remarkGfm, [remarkWorkspacePaths, { rootPath }]] : [remarkGfm]}
        components={{
          a: ({ node: _node, href, children, ...props }) => {
            const target = rootPath ? resolveWorkspaceMessageLink(href, rootPath) : null;
            if (target) {
              return (
                <WorkspacePathButton
                  displayPath={target.displayPath}
                  workspacePath={target.workspacePath}
                  onOpenWorkspacePath={onOpenWorkspacePath}
                >
                  {children}
                </WorkspacePathButton>
              );
            }
            return (
              <a {...props} href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          code: ({ className, children, node }) => {
            const source = String(children);
            const isCodeBlock =
              Boolean(className) ||
              Boolean(node?.position && node.position.start.line !== node.position.end.line);
            const target = !isCodeBlock && rootPath ? resolveWorkspaceMessagePath(source, rootPath) : null;
            if (target) {
              return (
                <WorkspacePathButton
                  displayPath={target.displayPath}
                  workspacePath={target.workspacePath}
                  onOpenWorkspacePath={onOpenWorkspacePath}
                >
                  {children}
                </WorkspacePathButton>
              );
            }

            const language = markdownCodeLanguage(className);
            if (!language) {
              return <code className={className}>{children}</code>;
            }

            const highlighted = highlightSource(String(children).replace(/\n$/, ""), language);
            return (
              <code
                className={`hljs language-${highlighted.language}`}
                dangerouslySetInnerHTML={{ __html: highlighted.html }}
              />
            );
          },
          pre: ({ children, node: _node }) => <pre className="message-code-block">{children}</pre>
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function WorkspacePathText({
  text,
  rootPath,
  onOpenWorkspacePath
}: {
  text: string;
  rootPath: string;
  onOpenWorkspacePath: (path: string) => void;
}) {
  return splitWorkspaceMessagePaths(text, rootPath).map((segment, index) =>
    segment.kind === "text" ? (
      <Fragment key={`text-${index}`}>{segment.value}</Fragment>
    ) : (
      <WorkspacePathButton
        key={`path-${index}`}
        displayPath={segment.displayPath}
        workspacePath={segment.workspacePath}
        onOpenWorkspacePath={onOpenWorkspacePath}
      >
        {segment.value}
      </WorkspacePathButton>
    )
  );
}

function WorkspacePathButton({
  children,
  displayPath,
  workspacePath,
  onOpenWorkspacePath
}: {
  children: ReactNode;
  displayPath: string;
  workspacePath: string;
  onOpenWorkspacePath: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="message-path-button"
      data-workspace-path={workspacePath}
      aria-label={displayPath}
      onClick={() => onOpenWorkspacePath(workspacePath)}
    >
      {children}
    </button>
  );
}

function markdownCodeLanguage(className: string | undefined): string | null {
  const match = /language-([\w-]+)/.exec(className ?? "");
  return match?.[1] ?? null;
}

function approvalRiskLabel(risk: CapabilityApprovalRisk, t: Translate): string {
  if (risk === "critical") {
    return t("chat.risks.critical");
  }
  if (risk === "high") {
    return t("chat.risks.high");
  }
  if (risk === "medium") {
    return t("chat.risks.medium");
  }
  return t("chat.risks.low");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
