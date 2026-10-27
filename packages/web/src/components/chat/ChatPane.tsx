import { Fragment, FormEvent, KeyboardEvent, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Bell,
  Check,
  CircleStop,
  CornerDownLeft,
  HardDrive,
  ListEnd,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
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
  ModelProviderSettings,
  NasRoot,
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

export function composeAgentMessage(message: string, composerPath: string | null): string {
  return [composerPath, message.trim()].filter(Boolean).join("\n");
}

export function hasActiveAgentTurn(activeJobId: string | null, status: AppStatus): boolean {
  return activeJobId !== null && status === "agent-running";
}

export function agentSessionHeaderTitle(
  session: SessionSummary | undefined,
  newSessionTitle: string,
  rootFallback: string
): string {
  if (!session?.firstMessage?.trim() && !session?.lastMessage?.trim()) {
    return newSessionTitle;
  }
  return sessionTitle(session, rootFallback);
}

export function composerFeedbackState({
  activeJobId,
  messageSubmitting,
  status
}: {
  activeJobId: string | null;
  messageSubmitting: boolean;
  status: AppStatus;
}): ComposerFeedbackState | null {
  if (messageSubmitting) {
    return "sending";
  }
  if (!activeJobId) {
    return null;
  }
  if (status === "queued") {
    return "queued";
  }
  if (status === "agent-running") {
    return "running";
  }
  if (status === "reconnecting") {
    return "reconnecting";
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
  rootAgentTitle,
  locale,
  ariaLabel,
  onSelectSession
}: {
  sessions: SessionSummary[];
  activeSessionId: string;
  rootAgentTitle: string;
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
        const title = sessionTitle(item, rootAgentTitle);
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
            title={label}
            aria-label={label}
            aria-current={item.id === activeSessionId ? "page" : undefined}
          >
            <Bot aria-hidden="true" size={19} />
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

export function ChatPane({
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
  retryJobId = null,
  messageSubmitting,
  hasSession,
  transcriptRef,
  onCreateAgent,
  onDeleteSession,
  onOpenSettings,
  onOpenNotifications,
  onRequestSystemPower,
  notificationUnreadCount,
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
  selectedRoot: NasRoot | undefined;
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
  retryJobId?: string | null;
  messageSubmitting: boolean;
  hasSession: boolean;
  transcriptRef: RefObject<HTMLDivElement | null>;
  onCreateAgent: () => void;
  onDeleteSession: () => void;
  onOpenSettings: () => void;
  onOpenNotifications: () => void;
  onRequestSystemPower: (action: SystemPowerAction) => Promise<boolean>;
  notificationUnreadCount: number;
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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [approvalDialog, setApprovalDialog] = useState<CapabilityApproval | null>(null);
  const [deliveryMode, setDeliveryMode] = useState<Exclude<AgentDeliveryMode, "prompt">>("follow_up");
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const approvalDialogRef = useRef<HTMLElement | null>(null);
  const approvalDialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const rootAgentTitle = t("chat.rootAgent");
  const hasConversationContent = transcript.length > 0
    || activeCapabilityApprovals.length > 0
    || agentToolActivities.length > 0;
  const activeSessionTitle = agentSessionHeaderTitle(activeSessionSummary, t("chat.newSessionTitle"), rootAgentTitle);
  const composerFeedback = composerFeedbackState({ activeJobId, messageSubmitting, status });
  const activeAgentTurn = hasActiveAgentTurn(activeJobId, status);
  const deleteDisabled = !activeSessionSummary || composerFeedback !== null || status === "cancelling";
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
    const requestTarget = [request?.rootId, request?.sourcePath, request?.targetPath]
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
                <dd title={target}>{target}</dd>
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
            title={t("common.actions.approve")}
          >
            <Check aria-hidden="true" size={15} />
            <span>{t("common.actions.approve")}</span>
          </button>
          <button
            type="button"
            className="approval-reject"
            onClick={() => onRejectCapability(approval)}
            title={t("common.actions.reject")}
          >
            <X aria-hidden="true" size={15} />
            <span>{t("common.actions.reject")}</span>
          </button>
        </div>
      </article>
    );
  };

  return (
    <section className={`chat-pane ${active ? "is-mobile-active" : ""}`} aria-label={t("chat.agents")}>
      <aside className="agent-list" aria-label={t("chat.agentSessions")}>
        <div className="brand">
          <img className="agent-brand-logo" src="/zos-icon.svg" alt="" aria-hidden="true" />
          <h1 className="visually-hidden">{t("common.appName")}</h1>
        </div>

        <div className="agent-list-head">
          <button
            type="button"
            onClick={onCreateAgent}
            title={t("common.actions.newAgent")}
            aria-label={t("common.actions.newAgent")}
          >
            <Plus aria-hidden="true" size={18} />
          </button>
        </div>

        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          rootAgentTitle={rootAgentTitle}
          locale={locale}
          ariaLabel={t("chat.agentSessions")}
          onSelectSession={onSelectSession}
        />

        <div className="agent-footer">
          <div
            className="agent-status-indicator"
            data-state={status}
            role="status"
            title={t(`status.${status}`)}
            aria-label={t(`status.${status}`)}
          >
            <span aria-hidden="true" />
          </div>
          <button
            className="agent-notification-button"
            type="button"
            onClick={onOpenNotifications}
            title={t("notifications.center.open")}
            aria-label={t("notifications.center.openWithCount", { count: notificationUnreadCount })}
          >
            <Bell aria-hidden="true" size={18} />
            {notificationUnreadCount > 0 ? (
              <span className="notification-badge" aria-hidden="true">
                {notificationUnreadCount > 99 ? "99+" : notificationUnreadCount}
              </span>
            ) : null}
          </button>
          <button
            className="settings-button agent-settings-button"
            type="button"
            onClick={onOpenSettings}
            title={t("common.actions.systemSettings")}
            aria-label={t("common.actions.systemSettings")}
          >
            <Settings aria-hidden="true" size={18} />
          </button>
          <PowerControl onRequest={onRequestSystemPower} />
        </div>
      </aside>

      <section className="chat-main" aria-label={t("chat.agentChat")}>
        <header className="chat-header">
          <div className="chat-header-copy">
            <h2>{activeSessionTitle}</h2>
            <span className="chat-header-subtitle">
              <HardDrive aria-hidden="true" size={13} />
              <span className="chat-header-root">{selectedRoot?.name ?? t("chat.noRoot")}</span>
              <span className="chat-header-subtitle-dot" aria-hidden="true" />
              <span>{t("chat.localNasWorkspace")}</span>
            </span>
          </div>
          <button
            type="button"
            className="icon-button chat-delete-session-button"
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={deleteDisabled}
            title={deleteDisabled && activeSessionSummary ? t("chat.deleteSessionBusy") : t("chat.deleteSession")}
            aria-label={t("chat.deleteSession")}
          >
            <Trash2 aria-hidden="true" size={17} />
          </button>
        </header>

        <div
          ref={transcriptRef}
          className="transcript"
          aria-label={t("chat.transcript")}
          aria-busy={transcriptPhase === "loading"}
        >
          {transcriptPhase === "loading" ? (
            <TranscriptSkeleton />
          ) : hasConversationContent ? (
            <>
              {transcript.map((item) => (
                <article key={item.id} className={`message message-${item.role}${item.streaming ? " is-streaming" : ""}`}>
                  <div className="avatar" aria-hidden="true">
                    {item.role === "assistant" ? <Bot size={17} /> : <MessageSquare size={17} />}
                  </div>
                  <div>
                    <header>
                      <strong>{item.role === "assistant" ? t("chat.zosAgent") : t("chat.you")}</strong>
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
                      <strong>{t("chat.zosAgent")}</strong>
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

        <form
          className="composer"
          onSubmit={(event) => onSubmitMessage(event, activeAgentTurn ? deliveryMode : "prompt")}
          aria-busy={messageSubmitting}
        >
          {composerPath ? (
            <div className="composer-path-block" role="group" aria-label={t("workspace.actions.sendPathToAgent")}>
              <div className="composer-path-content">
                <MessageSquarePlus aria-hidden="true" size={15} />
                <code title={composerPath}>{composerPath}</code>
              </div>
              <button
                type="button"
                className="composer-path-remove"
                onClick={onClearComposerPath}
                title={t("common.actions.removePath")}
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
          {composerStatusLabel ? (
            <div className="composer-meta">
              <div id={composerStatusId} className="composer-status" role="status" aria-live="polite" data-state={composerFeedback}>
                <LoaderCircle aria-hidden="true" className="composer-spinner" size={13} />
                <span>{composerStatusLabel}</span>
              </div>
            </div>
          ) : null}
          {activeAgentTurn ? (
            <div className="composer-delivery" role="group" aria-label={t("chat.deliveryMode")}>
              <button
                type="button"
                className={deliveryMode === "steer" ? "is-active" : ""}
                aria-pressed={deliveryMode === "steer"}
                onClick={() => setDeliveryMode("steer")}
                title={t("chat.steer")}
              >
                <CornerDownLeft aria-hidden="true" size={14} />
                <span>{t("chat.steer")}</span>
              </button>
              <button
                type="button"
                className={deliveryMode === "follow_up" ? "is-active" : ""}
                aria-pressed={deliveryMode === "follow_up"}
                onClick={() => setDeliveryMode("follow_up")}
                title={t("chat.followUp")}
              >
                <ListEnd aria-hidden="true" size={14} />
                <span>{t("chat.followUp")}</span>
              </button>
            </div>
          ) : null}
          <div className="composer-footer">
            <div
              className="composer-model-config"
              title={modelRoute}
              aria-label={`${t("chat.modelConfiguration")}: ${modelRoute}`}
            >
              <Bot aria-hidden="true" size={14} />
              <span>{modelRoute}</span>
            </div>
            <div className="composer-actions">
              {retryJobId ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={onRetryInterruptedJob}
                  aria-label={t("chat.retryInterrupted")}
                  title={t("chat.retryInterrupted")}
                >
                  <RotateCcw aria-hidden="true" size={16} />
                  <span>{t("chat.retry")}</span>
                </button>
              ) : null}
              <button
                className="secondary-button"
                type="button"
                onClick={onCancelActiveJob}
                disabled={!activeJobId}
                aria-label={t("common.actions.stop")}
                title={t("common.actions.stop")}
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
                  || (activeJobId !== null && !activeAgentTurn)
                }
                aria-busy={messageSubmitting || undefined}
                aria-label={t("common.actions.send")}
                title={t("common.actions.send")}
              >
                <ComposerIcon aria-hidden="true" className={composerIconClass} size={16} />
                <span>{t("common.actions.send")}</span>
              </button>
            </div>
          </div>
        </form>
      </section>

      {deleteConfirmOpen ? (
        <div className="session-delete-backdrop" role="presentation">
          <section
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
        </div>
      ) : null}

      {approvalDialog ? (
        <div
          className="approval-dialog-backdrop"
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
        </div>
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

function TranscriptSkeleton() {
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
