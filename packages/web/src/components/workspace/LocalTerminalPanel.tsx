import { ModalPortal } from "../common/ModalPortal.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, Pencil, Plus, RefreshCw, TerminalSquare, X } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  activateTerminalTab,
  createTerminalTab,
  deleteTerminalTab,
  getTerminalTabs,
  initializeTerminalTabs,
  renameTerminalTab,
  restartTerminalTab,
  type TerminalTab,
  type TerminalTabState
} from "../../api.js";
import type { CodeFontSettings } from "../../lib/editor-settings.js";
import {
  shouldInitializeTerminalTabs,
  terminalTabLabel,
  terminalTabNavigationTarget,
  type TerminalTabNavigationKey
} from "../../lib/terminal-tabs.js";
import { applyTerminalOptions, terminalOptions } from "../../lib/terminal-theme.js";
import { SkeletonBlock } from "./ManagementSkeleton.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";

type TerminalStatus = "connecting" | "connected" | "disconnected" | "error" | "exited" | "takenOver";

interface TerminalMessage {
  type: "ready" | "output" | "exit" | "error" | "taken_over";
  cwd?: string;
  sessionId?: string;
  data?: string;
  truncated?: boolean;
  exitCode?: number;
  error?: string;
}

interface TerminalViewState {
  status: TerminalStatus;
  diagnostic: string | null;
}

export function LocalTerminalPanel({
  active,
  codeFontSettings
}: {
  active: boolean;
  codeFontSettings: CodeFontSettings;
}) {
  const { t } = useTranslation();
  const requestVersionRef = useRef(0);
  const actionVersionRef = useRef(0);
  const [tabState, setTabState] = useState<TerminalTabState | null>(null);
  const [loading, setLoading] = useState(false);
  const [settled, setSettled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [visitedTabIds, setVisitedTabIds] = useState<Set<string>>(() => new Set());
  const [viewStates, setViewStates] = useState<Record<string, TerminalViewState>>({});
  const [connectionVersions, setConnectionVersions] = useState<Record<string, number>>({});
  const [renameCandidate, setRenameCandidate] = useState<TerminalTab | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [closeCandidate, setCloseCandidate] = useState<TerminalTab | null>(null);

  const applyState = useCallback((nextState: TerminalTabState) => {
    setTabState(nextState);
    if (nextState.activeTabId) {
      setVisitedTabIds((current) => addToSet(current, nextState.activeTabId!));
    }
  }, []);

  const refreshTabs = useCallback(async (showLoading: boolean) => {
    const requestVersion = ++requestVersionRef.current;
    if (showLoading) {
      setLoading(true);
    }
    try {
      let nextState = await getTerminalTabs();
      if (shouldInitializeTerminalTabs(nextState)) {
        nextState = await initializeTerminalTabs();
      }
      if (requestVersion === requestVersionRef.current) {
        applyState(nextState);
        setLoadError(null);
        setSettled(true);
      }
    } catch (error) {
      if (requestVersion === requestVersionRef.current) {
        setLoadError(errorMessage(error));
        setSettled(true);
      }
    } finally {
      if (requestVersion === requestVersionRef.current) {
        setLoading(false);
      }
    }
  }, [applyState]);

  useEffect(() => {
    requestVersionRef.current += 1;
    actionVersionRef.current += 1;
    setTabState(null);
    setLoading(false);
    setSettled(false);
    setLoadError(null);
    setActionError(null);
    setPendingAction(null);
    setVisitedTabIds(new Set());
    setViewStates({});
    setConnectionVersions({});
    setRenameCandidate(null);
    setCloseCandidate(null);
  }, []);

  useEffect(() => {
    if (active) {
      void refreshTabs(true);
    }
  }, [active, refreshTabs]);

  useEffect(() => {
    const handleFocus = () => {
      if (active) {
        void refreshTabs(false);
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [active, refreshTabs]);

  const updateViewState = useCallback((tabId: string, nextState: TerminalViewState) => {
    setViewStates((current) => {
      const previous = current[tabId];
      if (previous?.status === nextState.status && previous.diagnostic === nextState.diagnostic) {
        return current;
      }
      return { ...current, [tabId]: nextState };
    });
  }, []);

  async function selectTab(tabId: string) {
    if (!tabState || tabState.activeTabId === tabId || pendingAction) {
      return;
    }
    const previousState = tabState;
    const actionVersion = ++actionVersionRef.current;
    applyState({ ...tabState, activeTabId: tabId });
    setActionError(null);
    setPendingAction(`activate:${tabId}`);
    try {
      const nextState = await activateTerminalTab(tabId);
      if (actionVersion === actionVersionRef.current) {
        requestVersionRef.current += 1;
        applyState(nextState);
      }
    } catch (error) {
      if (actionVersion === actionVersionRef.current) {
        setTabState(previousState);
        setActionError(errorMessage(error));
      }
    } finally {
      if (actionVersion === actionVersionRef.current) {
        setPendingAction(null);
      }
    }
  }

  async function createTab() {
    if (pendingAction) {
      return;
    }
    setActionError(null);
    const actionVersion = ++actionVersionRef.current;
    setPendingAction("create");
    try {
      const nextState = await createTerminalTab();
      if (actionVersion === actionVersionRef.current) {
        requestVersionRef.current += 1;
        applyState(nextState);
      }
    } catch (error) {
      if (actionVersion === actionVersionRef.current) {
        setActionError(
          errorMessage(error) === "Terminal session limit reached"
            ? String(t("workspace.terminal.limitReached", { count: tabState?.maxSessions ?? 32 }))
            : errorMessage(error)
        );
      }
    } finally {
      if (actionVersion === actionVersionRef.current) {
        setPendingAction(null);
      }
    }
  }

  function openRenameDialog(tab: TerminalTab) {
    setRenameCandidate(tab);
    setRenameValue(tab.customTitle ?? "");
    setActionError(null);
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameCandidate || pendingAction) {
      return;
    }
    const customTitle = renameValue.trim() || null;
    const actionVersion = ++actionVersionRef.current;
    setActionError(null);
    setPendingAction("rename");
    try {
      const nextState = await renameTerminalTab(renameCandidate.id, customTitle);
      if (actionVersion === actionVersionRef.current) {
        requestVersionRef.current += 1;
        applyState(nextState);
        setRenameCandidate(null);
      }
    } catch (error) {
      if (actionVersion === actionVersionRef.current) {
        setActionError(errorMessage(error));
      }
    } finally {
      if (actionVersion === actionVersionRef.current) {
        setPendingAction(null);
      }
    }
  }

  async function restartTab(tabId: string) {
    if (pendingAction) {
      return;
    }
    const actionVersion = ++actionVersionRef.current;
    setActionError(null);
    setPendingAction("restart");
    try {
      const nextState = await restartTerminalTab(tabId);
      if (actionVersion === actionVersionRef.current) {
        requestVersionRef.current += 1;
        applyState(nextState);
        setConnectionVersions((current) => ({ ...current, [tabId]: (current[tabId] ?? 0) + 1 }));
        updateViewState(tabId, { status: "connecting", diagnostic: null });
      }
    } catch (error) {
      if (actionVersion === actionVersionRef.current) {
        setActionError(errorMessage(error));
      }
    } finally {
      if (actionVersion === actionVersionRef.current) {
        setPendingAction(null);
      }
    }
  }

  async function closeTab() {
    if (!closeCandidate || pendingAction) {
      return;
    }
    const tabId = closeCandidate.id;
    const actionVersion = ++actionVersionRef.current;
    setActionError(null);
    setPendingAction("close");
    try {
      const nextState = await deleteTerminalTab(tabId);
      if (actionVersion === actionVersionRef.current) {
        requestVersionRef.current += 1;
        applyState(nextState);
        setVisitedTabIds((current) => removeFromSet(current, tabId));
        setViewStates((current) => omitKey(current, tabId));
        setConnectionVersions((current) => omitKey(current, tabId));
        setCloseCandidate(null);
      }
    } catch (error) {
      if (actionVersion === actionVersionRef.current) {
        setActionError(errorMessage(error));
      }
    } finally {
      if (actionVersion === actionVersionRef.current) {
        setPendingAction(null);
      }
    }
  }

  function reconnect(tabId: string) {
    setConnectionVersions((current) => ({ ...current, [tabId]: (current[tabId] ?? 0) + 1 }));
    updateViewState(tabId, { status: "connecting", diagnostic: null });
  }

  const initialLoading = !settled;
  const tabs = initialLoading ? [] : tabState?.tabs ?? [];
  const activeTab = tabs.find((tab) => tab.id === tabState?.activeTabId) ?? null;
  const activeViewState = activeTab
    ? viewStates[activeTab.id] ?? { status: "connecting" as const, diagnostic: null }
    : null;
  const atLocalLimit = Boolean(tabState && tabs.length >= tabState.maxSessions);
  const visibleTabs = tabs.filter((tab) => visitedTabIds.has(tab.id));
  const currentLoadError = loadError;

  return (
    <section
      className="workspace-terminal-panel"
      hidden={!active}
      aria-hidden={!active}
      aria-label={t("workspace.terminal.title")}
      aria-busy={initialLoading || loading || undefined}
    >
      <PanelHeader
        className="workspace-terminal-overview"
        icon={<TerminalSquare aria-hidden="true" size={20} />}
        title={t("workspace.terminal.title")}
        subtitle={t("workspace.terminal.description")}
        actions={<PanelHeaderActions label={t("workspace.terminal.actionsLabel")} className="workspace-terminal-actions">
          <PanelHeaderAction
            label={t("workspace.terminal.rename")}
            type="button"
            onClick={() => activeTab && openRenameDialog(activeTab)}
            disabled={initialLoading || !activeTab || Boolean(pendingAction)}
          >
            <Pencil aria-hidden="true" size={16} />
          </PanelHeaderAction>
          <PanelHeaderAction
            label={t("workspace.terminal.restart")}
            type="button"
            onClick={() => activeTab && void restartTab(activeTab.id)}
            disabled={initialLoading || !activeTab || Boolean(pendingAction)}
          >
            <RefreshCw aria-hidden="true" size={16} />
          </PanelHeaderAction>
          <PanelHeaderAction
            label={t("workspace.terminal.close")}
            type="button"
            className="is-danger"
            onClick={() => {
              setActionError(null);
              if (activeTab) setCloseCandidate(activeTab);
            }}
            disabled={initialLoading || !activeTab || Boolean(pendingAction)}
          >
            <X aria-hidden="true" size={17} />
          </PanelHeaderAction>
        </PanelHeaderActions>}
      />

      <div className="workspace-terminal-frame">
        <div className="workspace-terminal-header">
          {initialLoading ? (
            <div className="workspace-terminal-tabs-skeleton" aria-hidden="true">
              <SkeletonBlock className="workspace-terminal-tab-skeleton" />
              <SkeletonBlock className="workspace-terminal-tab-skeleton is-short" />
              <SkeletonBlock className="workspace-terminal-new-tab-skeleton" />
            </div>
          ) : tabState ? (
            <TerminalTabBar
              tabs={tabs}
              activeTabId={tabState.activeTabId}
              maxSessions={tabState.maxSessions}
              createDisabled={Boolean(pendingAction) || atLocalLimit}
              onSelect={(tabId) => void selectTab(tabId)}
              onCreate={() => void createTab()}
              onRename={openRenameDialog}
            />
          ) : (
            <div className="workspace-terminal-tabs-placeholder" aria-hidden="true" />
          )}
        </div>

        <div className="workspace-terminal-stage">
          {initialLoading ? <span className="visually-hidden" role="status">{t("common.states.loading")}</span> : null}
          {initialLoading ? (
            <div className="workspace-terminal-skeleton" aria-hidden="true">
              <SkeletonBlock width="38%" />
              <SkeletonBlock width="64%" />
              <SkeletonBlock width="52%" />
            </div>
          ) : currentLoadError && !tabState ? (
            <TerminalEmptyState
              title={t("workspace.terminal.loadFailed")}
              detail={currentLoadError}
              actionLabel={t("workspace.terminal.retry")}
              onAction={() => void refreshTabs(true)}
            />
          ) : tabState && tabs.length === 0 ? (
            <TerminalEmptyState
              title={t("workspace.terminal.emptyTitle")}
              detail={t("workspace.terminal.emptyBody")}
              actionLabel={t("workspace.terminal.newTab")}
              onAction={() => void createTab()}
              disabled={Boolean(pendingAction)}
            />
          ) : null}

          {visibleTabs.map((tab) => (
            <TerminalSessionView
              key={tab.id}
              tab={tab}
              label={terminalTabLabel(tab, t)}
              active={active && tab.id === tabState?.activeTabId}
              codeFontSettings={codeFontSettings}
              connectionVersion={connectionVersions[tab.id] ?? 0}
              connectionError={String(t("workspace.terminal.connectionError"))}
              disconnectedError={String(t("workspace.terminal.disconnectedError"))}
              onStateChange={updateViewState}
            />
          ))}

          {activeTab && activeViewState?.status === "takenOver" ? (
            <div className="workspace-terminal-notice" role="status">
              <strong>{t("workspace.terminal.takenOverTitle")}</strong>
              <span>{t("workspace.terminal.takenOverBody")}</span>
              <button type="button" className="secondary-button" onClick={() => reconnect(activeTab.id)}>
                <RefreshCw aria-hidden="true" size={14} />
                <span>{t("workspace.terminal.takeOver")}</span>
              </button>
            </div>
          ) : activeTab && activeViewState?.status === "exited" ? (
            <div className="workspace-terminal-notice" role="status">
              <strong>{t("workspace.terminal.exitedTitle")}</strong>
              <span>{t("workspace.terminal.exitedBody")}</span>
              <button type="button" className="secondary-button" onClick={() => void restartTab(activeTab.id)} disabled={Boolean(pendingAction)}>
                <RefreshCw aria-hidden="true" size={14} />
                <span>{t("workspace.terminal.restart")}</span>
              </button>
            </div>
          ) : null}

          {actionError ? (
            <div className="workspace-terminal-error" role="alert">
              <span>{actionError}</span>
              <button type="button" onClick={() => setActionError(null)} aria-label={t("common.actions.close")}>
                <X aria-hidden="true" size={14} />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {renameCandidate ? (
        <ModalPortal className="file-action-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && setRenameCandidate(null)}>
          <form className="file-action-dialog" role="dialog" aria-modal="true" aria-labelledby="terminal-rename-title" onSubmit={(event) => void submitRename(event)}>
            <header>
              <span className="eyebrow">{t("workspace.terminal.rename")}</span>
              <h2 id="terminal-rename-title">{terminalTabLabel(renameCandidate, t)}</h2>
            </header>
            <label className="file-action-field">
              <span>{t("workspace.terminal.tabName")}</span>
              <input
                autoFocus
                value={renameValue}
                maxLength={64}
                onChange={(event) => setRenameValue(event.target.value)}
                aria-describedby="terminal-rename-hint"
              />
            </label>
            <p id="terminal-rename-hint" className="file-action-hint">{t("workspace.terminal.renameHint")}</p>
            {actionError ? <p className="file-action-error" role="alert">{actionError}</p> : null}
            <footer>
              <button type="button" className="secondary-button" onClick={() => setRenameCandidate(null)} disabled={Boolean(pendingAction)}>{t("common.actions.cancel")}</button>
              <button type="submit" className="primary-button" disabled={Boolean(pendingAction)} aria-busy={pendingAction === "rename" || undefined}>
                {pendingAction === "rename" ? t("common.actions.saving") : t("workspace.terminal.saveName")}
              </button>
            </footer>
          </form>
        </ModalPortal>
      ) : null}

      {closeCandidate ? (
        <ModalPortal className="file-action-backdrop" role="presentation">
          <section className="file-action-dialog" role="dialog" aria-modal="true" aria-labelledby="terminal-close-title">
            <header>
              <span className="eyebrow">{t("workspace.terminal.close")}</span>
              <h2 id="terminal-close-title">{terminalTabLabel(closeCandidate, t)}</h2>
            </header>
            <p className="file-action-copy">{t("workspace.terminal.closeConfirm")}</p>
            {actionError ? <p className="file-action-error" role="alert">{actionError}</p> : null}
            <footer>
              <button type="button" className="secondary-button" onClick={() => setCloseCandidate(null)} disabled={Boolean(pendingAction)}>{t("common.actions.cancel")}</button>
              <button type="button" className="danger-button" onClick={() => void closeTab()} disabled={Boolean(pendingAction)} aria-busy={pendingAction === "close" || undefined}>
                {pendingAction === "close" ? t("workspace.terminal.closing") : t("workspace.terminal.closeAndStop")}
              </button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
    </section>
  );
}

export function TerminalTabBar({
  tabs,
  activeTabId,
  maxSessions,
  createDisabled,
  onSelect,
  onCreate,
  onRename
}: {
  tabs: TerminalTab[];
  activeTabId: string | null;
  maxSessions: number;
  createDisabled: boolean;
  onSelect: (tabId: string) => void;
  onCreate: () => void;
  onRename?: (tab: TerminalTab) => void;
}) {
  const { t } = useTranslation();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (activeTabId) {
      tabRefs.current.get(activeTabId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeTabId, tabs]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) {
    if (!isTerminalNavigationKey(event.key)) {
      return;
    }
    event.preventDefault();
    const targetId = terminalTabNavigationTarget(tabs, tabId, event.key);
    if (!targetId) {
      return;
    }
    onSelect(targetId);
    window.setTimeout(() => tabRefs.current.get(targetId)?.focus(), 0);
  }

  return (
    <div className="workspace-terminal-tabbar">
      <div className="workspace-terminal-tabs" role="tablist" aria-label={t("workspace.terminal.tabsLabel")}>
        {tabs.map((tab) => {
          const selected = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element);
                else tabRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              className={`workspace-terminal-tab${selected ? " is-active" : ""}`}
              aria-selected={selected}
              aria-controls={`terminal-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              title={terminalTabLabel(tab, t)}
              onClick={() => onSelect(tab.id)}
              onDoubleClick={() => onRename?.(tab)}
              onKeyDown={(event) => handleKeyDown(event, tab.id)}
            >
              <TerminalSquare aria-hidden="true" size={14} />
              <span>{terminalTabLabel(tab, t)}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="workspace-terminal-new-tab"
        onClick={onCreate}
        disabled={createDisabled}
        title={createDisabled && tabs.length >= maxSessions ? t("workspace.terminal.limitReached", { count: maxSessions }) : t("workspace.terminal.newTab")}
        aria-label={t("workspace.terminal.newTab")}
      >
        <Plus aria-hidden="true" size={15} />
      </button>
    </div>
  );
}

function TerminalSessionView({
  tab,
  label,
  active,
  codeFontSettings,
  connectionVersion,
  connectionError,
  disconnectedError,
  onStateChange
}: {
  tab: TerminalTab;
  label: string;
  active: boolean;
  codeFontSettings: CodeFontSettings;
  connectionVersion: number;
  connectionError: string;
  disconnectedError: string;
  onStateChange: (tabId: string, state: TerminalViewState) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeRef = useRef(active);

  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 2_000,
      ...terminalOptions(host)
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fit = () => {
      if (!activeRef.current || host.clientWidth === 0 || host.clientHeight === 0) {
        return;
      }
      fitAddon.fit();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);
    const dataDisposable = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      socketRef.current?.close();
      socketRef.current = null;
      fitAddonRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    const host = hostRef.current;
    if (!terminal || !host) {
      return;
    }
    applyTerminalOptions(terminal, host);
    if (active) {
      window.setTimeout(() => {
        if (terminalRef.current !== terminal || !fitAddonRef.current || host.clientWidth === 0 || host.clientHeight === 0) {
          return;
        }
        fitAddonRef.current.fit();
        terminal.focus();
      }, 0);
    }
  }, [active, codeFontSettings.familyId, codeFontSettings.fontSizePx]);

  useEffect(() => {
    if (!active) {
      const currentSocket = socketRef.current;
      socketRef.current = null;
      if (currentSocket && currentSocket.readyState < WebSocket.CLOSING) {
        currentSocket.close();
      }
      return;
    }

    let disposed = false;
    let stopped = false;
    let retryTimer: number | null = null;
    let retryAttempt = 0;

    const report = (status: TerminalStatus, diagnostic: string | null = null) => {
      if (!disposed) {
        onStateChange(tab.id, { status, diagnostic });
      }
    };
    const fitAndResize = () => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      const host = hostRef.current;
      if (!terminal || !fitAddon || !host || host.clientWidth === 0 || host.clientHeight === 0) {
        return;
      }
      fitAddon.fit();
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const scheduleReconnect = () => {
      if (disposed || stopped || retryTimer !== null) {
        return;
      }
      const delay = terminalReconnectDelay(retryAttempt);
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };
    const connect = () => {
      const existing = socketRef.current;
      if (disposed || stopped || existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) {
        return;
      }
      const socket = new WebSocket(terminalWebSocketUrl(), terminalWebSocketProtocols(tab.id));
      socketRef.current = socket;
      report("connecting");
      socket.addEventListener("open", () => {
        if (disposed || socketRef.current !== socket) {
          return;
        }
        fitAndResize();
      });
      socket.addEventListener("message", (event) => {
        if (disposed || socketRef.current !== socket) {
          return;
        }
        const message = parseTerminalMessage(event.data);
        if (!message) {
          return;
        }
        if (message.type === "ready") {
          retryAttempt = 0;
          report("connected");
          fitAndResize();
        } else if (message.type === "output" && message.data) {
          terminalRef.current?.write(message.data);
        } else if (message.type === "error") {
          report("error", message.error ?? connectionError);
        } else if (message.type === "exit") {
          stopped = true;
          report("exited");
        } else if (message.type === "taken_over") {
          stopped = true;
          report("takenOver");
        }
      });
      socket.addEventListener("error", () => {
        if (!disposed && socketRef.current === socket && !stopped) {
          report("error", connectionError);
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current !== socket) {
          return;
        }
        socketRef.current = null;
        if (disposed || stopped) {
          return;
        }
        report("disconnected", disconnectedError);
        scheduleReconnect();
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
    };
  }, [active, connectionError, connectionVersion, disconnectedError, onStateChange, tab.id]);

  return (
    <div
      ref={hostRef}
      id={`terminal-panel-${tab.id}`}
      className="workspace-terminal"
      role="tabpanel"
      aria-label={label}
      hidden={!active}
    />
  );
}

export function terminalInitialLoadPending(terminalScope: string | undefined, settledScope: string | null): boolean {
  return Boolean(terminalScope && terminalScope !== settledScope);
}

export function terminalReconnectDelay(attempt: number): number {
  return Math.min(5_000, 250 * 2 ** Math.min(Math.max(0, attempt), 5));
}

function TerminalEmptyState({
  title,
  detail,
  actionLabel,
  onAction,
  disabled = false
}: {
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="workspace-terminal-empty">
      <TerminalSquare aria-hidden="true" size={24} />
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
      {actionLabel && onAction ? (
        <button type="button" className="secondary-button" onClick={onAction} disabled={disabled}>
          {disabled ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : <Plus aria-hidden="true" size={14} />}
          <span>{actionLabel}</span>
        </button>
      ) : null}
    </div>
  );
}

function terminalWebSocketUrl(): string {
  const url = new URL("/api/terminal", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function terminalWebSocketProtocols(sessionId: string): string[] {
  return ["cyberos-terminal-v1", `cyberos-session.${sessionId}`];
}

function parseTerminalMessage(raw: unknown): TerminalMessage | null {
  try {
    const parsed = JSON.parse(String(raw)) as TerminalMessage;
    if (!["ready", "output", "exit", "error", "taken_over"].includes(parsed.type)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isTerminalNavigationKey(key: string): key is TerminalTabNavigationKey {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
}

function addToSet(current: Set<string>, value: string): Set<string> {
  if (current.has(value)) {
    return current;
  }
  const next = new Set(current);
  next.add(value);
  return next;
}

function removeFromSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  next.delete(value);
  return next;
}

function omitKey<T>(current: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...next } = current;
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
