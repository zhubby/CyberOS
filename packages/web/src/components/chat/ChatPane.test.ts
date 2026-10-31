import { describe, expect, it } from "vitest";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppStatus } from "../../config/status.js";
import { initI18n } from "../../i18n/index.js";
import {
  ChatMessageContent,
  ChatPane,
  agentSessionHeaderTitle,
  composeAgentMessage,
  composerFeedbackState,
  hasActiveAgentTurn,
  shouldSubmitComposerMessage
} from "./ChatPane.js";

type ComposerKeyDownEvent = Parameters<typeof shouldSubmitComposerMessage>[0];

function composerEvent(key = "Enter", shiftKey = false, isComposing = false) {
  return {
    key,
    shiftKey,
    nativeEvent: { isComposing } as ComposerKeyDownEvent["nativeEvent"]
  } as ComposerKeyDownEvent;
}

describe("shouldSubmitComposerMessage", () => {
  it("submits on enter", () => {
    expect(shouldSubmitComposerMessage(composerEvent())).toBe(true);
  });

  it("keeps shift+enter as a newline", () => {
    expect(shouldSubmitComposerMessage(composerEvent("Enter", true))).toBe(false);
  });

  it("ignores enter while an IME composition is active", () => {
    expect(shouldSubmitComposerMessage(composerEvent("Enter", false, true))).toBe(false);
  });
});

describe("composeAgentMessage", () => {
  it("keeps an attached path as one message-level block", () => {
    expect(composeAgentMessage("Inspect this", "/cyberos/data/pool-1/docs/readme.md")).toBe("/cyberos/data/pool-1/docs/readme.md\nInspect this");
    expect(composeAgentMessage("", "/cyberos/data/pool-1/docs/readme.md")).toBe("/cyberos/data/pool-1/docs/readme.md");
    expect(composeAgentMessage("Inspect this", null)).toBe("Inspect this");
  });
});

describe("agentSessionHeaderTitle", () => {
  const session = {
    id: "session-1",
    storagePoolId: "root-1",
    currentPath: ".",
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    firstMessage: null,
    lastMessage: null,
    pendingApprovalCount: 0
  };

  it("uses a fixed title before a session has any messages", () => {
    expect(agentSessionHeaderTitle(undefined, "New session", "Workspace agent")).toBe("New session");
    expect(agentSessionHeaderTitle(session, "New session", "Workspace agent")).toBe("New session");
  });

  it("uses the API session title after the conversation starts", () => {
    expect(agentSessionHeaderTitle({ ...session, firstMessage: "Inspect storage health" }, "New session", "Workspace agent")).toBe(
      "Inspect storage health"
    );
  });
});

describe("composerFeedbackState", () => {
  it("shows sending while the message request is in flight", () => {
    expect(
      composerFeedbackState({
        activeJobId: null,
        activeJobStatus: null,
        messageSubmitting: true,
        status: "queued" as AppStatus
      })
    ).toBe("sending");
  });

  it("shows queued, running, and reconnecting states for active jobs", () => {
    expect(
      composerFeedbackState({
        activeJobId: "job-1",
        activeJobStatus: "queued",
        messageSubmitting: false,
        status: "ready" as AppStatus
      })
    ).toBe("queued");
    expect(
      composerFeedbackState({
        activeJobId: "job-1",
        activeJobStatus: "running",
        messageSubmitting: false,
        status: "ready" as AppStatus
      })
    ).toBe("running");
    expect(
      composerFeedbackState({
        activeJobId: "job-1",
        activeJobStatus: "running",
        messageSubmitting: false,
        status: "reconnecting" as AppStatus
      })
    ).toBe("reconnecting");
  });

  it("stays silent when there is no active job", () => {
    expect(
      composerFeedbackState({
        activeJobId: null,
        activeJobStatus: null,
        messageSubmitting: false,
        status: "queued" as AppStatus
      })
    ).toBeNull();
  });
});

describe("hasActiveAgentTurn", () => {
  it("tracks the Agent job independently from the page status", () => {
    expect(hasActiveAgentTurn("job-1", "running")).toBe(true);
    expect(hasActiveAgentTurn("job-1", "queued")).toBe(false);
    expect(hasActiveAgentTurn("job-1", "completed")).toBe(false);
    expect(hasActiveAgentTurn(null, "running")).toBe(false);
  });
});

describe("ChatMessageContent", () => {
  it("renders assistant replies as GitHub-flavored markdown", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMessageContent, {
        role: "assistant",
        content: [
          "**Done**",
          "",
          "- first",
          "- second",
          "",
          "[docs](https://example.com)",
          "",
          "```ts",
          "const value = 1;",
          "```"
        ].join("\n")
      })
    );

    expect(html).toContain("<strong>Done</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('class="message-code-block"');
    expect(html).toContain("hljs");
  });

  it("renders user messages as plain text", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMessageContent, {
        role: "user",
        content: "**not markdown**"
      })
    );

    expect(html).toContain("**not markdown**");
    expect(html).not.toContain("<strong>");
  });

  it("renders paths inside the selected root as buttons in user messages", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMessageContent, {
        role: "user",
        content: "Open /cyberos/data/pool-1/docs/readme.md, not /private/other/private.txt",
        rootPath: "/cyberos/data/pool-1",
        onOpenWorkspacePath: () => undefined
      })
    );

    expect(html).toContain('class="message-path-button"');
    expect(html).toContain('data-workspace-path="docs/readme.md"');
    expect(html).toContain("/private/other/private.txt");
    expect(html).not.toContain('data-workspace-path="/private/other/private.txt"');
  });

  it("renders a standalone user path with spaces as one button", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMessageContent, {
        role: "user",
        content: "/cyberos/data/pool-1/My Files/report (1).pdf\n这个文件是什么内容",
        rootPath: "/cyberos/data/pool-1",
        onOpenWorkspacePath: () => undefined
      })
    );

    expect(html).toContain('data-workspace-path="My Files/report (1).pdf"');
    expect(html).toContain("/cyberos/data/pool-1/My Files/report (1).pdf");
    expect(html).toContain("这个文件是什么内容");
  });

  it("renders assistant text, inline code, and Markdown link paths as buttons", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMessageContent, {
        role: "assistant",
        content: [
          "Open /cyberos/data/pool-1/docs/readme.md.",
          "",
          "`/cyberos/data/pool-1/My Files/report.pdf`",
          "",
          "[linked report](/cyberos/data/pool-1/reports/latest.pdf)",
          "",
          "```",
          "/cyberos/data/pool-1/not-interactive.txt",
          "```"
        ].join("\n"),
        rootPath: "/cyberos/data/pool-1",
        onOpenWorkspacePath: () => undefined
      })
    );

    expect(html.match(/class="message-path-button"/gu)).toHaveLength(3);
    expect(html).toContain('data-workspace-path="docs/readme.md"');
    expect(html).toContain('data-workspace-path="My Files/report.pdf"');
    expect(html).toContain('data-workspace-path="reports/latest.pdf"');
    expect(html).toContain('<pre class="message-code-block"><code>/cyberos/data/pool-1/not-interactive.txt');
  });
});

describe("ChatPane agent rail", () => {
  it.each(["running", "queued", "sending", "reconnecting", "idle"] as const)(
    "keeps %s feedback and delivery icons in one toolbar above the input",
    async (state) => {
      await initI18n();
      const noop = () => undefined;
      const html = renderToStaticMarkup(createElement(ChatPane, {
        active: true,
        selectedRoot: undefined,
        activeSessionSummary: undefined,
        sessions: [],
        activeSessionId: "session-1",
        transcript: [],
        transcriptPhase: "ready",
        activeCapabilityApprovals: [],
        message: "Next instruction",
        composerPath: null,
        status: state === "reconnecting" ? "reconnecting" : "ready",
        locale: "en",
        modelSettings: null,
        activeJobId: state === "idle" ? null : "job-1",
        activeJobStatus: state === "idle" ? null : state === "queued" ? "queued" : "running",
        messageSubmitting: state === "sending",
        hasSession: true,
        transcriptRef: createRef<HTMLDivElement>(),
        onCreateAgent: noop,
        onDeleteSession: noop,
        onOpenSettings: noop,
        onOpenNotifications: noop,
        onRequestSystemPower: async () => true,
        notificationUnreadCount: 0,
        onSelectSession: noop,
        onApproveCapability: noop,
        onRejectCapability: noop,
        onSubmitMessage: noop,
        onMessageChange: noop,
        onClearComposerPath: noop,
        onCancelActiveJob: noop,
        onOpenWorkspacePath: noop
      }));
      const toolbar = html.match(/<div class="composer-toolbar">(.*?)<\/div><textarea/su)?.[1];

      if (state === "idle") {
        expect(toolbar).toBeUndefined();
        expect(html).not.toContain('aria-describedby="composer-status"');
        return;
      }

      expect(toolbar).toBeDefined();
      expect(toolbar).toContain(`data-state="${state}"`);
      expect(html).toContain('aria-describedby="composer-status"');
      expect(html).not.toContain('class="composer-meta"');
      if (state === "queued") {
        expect(toolbar).not.toContain('class="composer-delivery"');
      } else {
        expect(toolbar).toContain('aria-pressed="false" title="Steer" aria-label="Steer"');
        expect(toolbar).toContain('aria-pressed="true" title="Follow-up" aria-label="Follow-up"');
        expect(toolbar).toContain('class="visually-hidden">Steer</span>');
        expect(toolbar).toContain('class="visually-hidden">Follow-up</span>');
      }
    }
  );

  it("keeps the compact icon navigation and settings action in the footer", async () => {
    await initI18n();
    const session = {
      id: "session-1",
      storagePoolId: "root-1",
      currentPath: ".",
      createdAt: "2026-09-17T10:00:00.000Z",
      updatedAt: "2026-09-17T10:00:00.000Z",
      firstMessage: null,
      lastMessage: null,
      pendingApprovalCount: 2
    };
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      createElement(ChatPane, {
        active: true,
        selectedRoot: undefined,
        activeSessionSummary: session,
        sessions: [session],
        activeSessionId: session.id,
        transcript: [],
        transcriptPhase: "ready",
        activeCapabilityApprovals: [],
        message: "",
        composerPath: null,
        status: "ready",
        locale: "en",
        modelSettings: null,
        activeJobId: null,
        activeJobStatus: null,
        messageSubmitting: false,
        hasSession: true,
        transcriptRef: createRef<HTMLDivElement>(),
        onCreateAgent: noop,
        onDeleteSession: noop,
        onOpenSettings: noop,
        onOpenNotifications: noop,
        onRequestSystemPower: async () => true,
        notificationUnreadCount: 3,
        onSelectSession: noop,
        onApproveCapability: noop,
        onRejectCapability: noop,
        onSubmitMessage: noop,
        onMessageChange: noop,
        onClearComposerPath: noop,
        onCancelActiveJob: noop,
        onOpenWorkspacePath: noop
      })
    );

    expect(html).toContain('class="agent-brand-logo"');
    expect(html).toContain('class="chat-header app-titlebar"');
    expect(html).toContain('src="/cyberos-icon.svg"');
    expect(html).not.toContain("cyberos-banner");
    expect(html).toContain('class="session-item is-active"');
    expect(html).toContain('class="session-approval-badge"');
    expect(html).toContain("2 pending approvals");
    expect(html).toContain("How can I help with your NAS?");
    expect(html).not.toContain('class="chat-header-subtitle"');
    expect(html).not.toContain("Local NAS workspace");
    expect(html).toContain('class="icon-button chat-delete-session-button"');
    expect(html).toContain('aria-label="Delete session"');
    expect(html).toContain('class="chat-header-index" aria-hidden="true">01</span>');
    expect(html).not.toContain('class="chat-header-status"');
    expect(html).toContain('class="agent-status-indicator"');
    expect(html).toContain('class="agent-notification-button"');
    expect(html).toContain('class="notification-badge"');
    expect(html).toContain('class="settings-button agent-settings-button"');
    expect(html).toContain('class="agent-power-button"');
    expect(html).toContain('class="composer-model-config" role="group" title="Not loaded" aria-label="Model config: Not loaded"');
    expect(html).not.toContain(">Model config</span>");
    expect(html.indexOf('class="session-list"')).toBeLessThan(html.indexOf('class="agent-footer"'));
    expect(html.indexOf('class="agent-notification-button"')).toBeLessThan(html.indexOf('class="settings-button agent-settings-button"'));
    expect(html.indexOf('class="settings-button agent-settings-button"')).toBeLessThan(html.indexOf('class="agent-power-button"'));
  });

  it("shows an accessible transcript skeleton while keeping the composer editable", async () => {
    await initI18n();
    const session = {
      id: "session-1",
      storagePoolId: "root-1",
      currentPath: ".",
      createdAt: "2026-09-17T10:00:00.000Z",
      updatedAt: "2026-09-17T10:00:00.000Z",
      firstMessage: null,
      lastMessage: null,
      pendingApprovalCount: 0
    };
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      createElement(ChatPane, {
        active: true,
        selectedRoot: undefined,
        activeSessionSummary: session,
        sessions: [session],
        activeSessionId: session.id,
        transcript: [],
        transcriptPhase: "loading",
        activeCapabilityApprovals: [],
        message: "Draft stays editable",
        composerPath: null,
        status: "loading",
        locale: "en",
        modelSettings: null,
        activeJobId: null,
        activeJobStatus: null,
        messageSubmitting: false,
        hasSession: true,
        transcriptRef: createRef<HTMLDivElement>(),
        onCreateAgent: noop,
        onDeleteSession: noop,
        onOpenSettings: noop,
        onOpenNotifications: noop,
        onRequestSystemPower: async () => true,
        notificationUnreadCount: 0,
        onSelectSession: noop,
        onApproveCapability: noop,
        onRejectCapability: noop,
        onSubmitMessage: noop,
        onMessageChange: noop,
        onClearComposerPath: noop,
        onCancelActiveJob: noop,
        onOpenWorkspacePath: noop
      })
    );

    expect(html).toContain('class="transcript" role="log" aria-label="Transcript" aria-busy="true"');
    expect(html).toContain('class="transcript-skeleton" aria-hidden="true"');
    expect(html.match(/class="transcript-skeleton-row/gu)).toHaveLength(4);
    expect(html).not.toContain('class="empty-state"');
    expect(html).not.toMatch(/<textarea[^>]*disabled/gu);
    expect(html).toMatch(/<button class="primary-button" type="submit" disabled=""/gu);
  });

  it("renders first-party capability approval provenance and revision", async () => {
    await initI18n();
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      createElement(ChatPane, {
        active: true,
        selectedRoot: undefined,
        activeSessionSummary: undefined,
        sessions: [],
        activeSessionId: "",
        transcript: [],
        transcriptPhase: "ready",
        activeCapabilityApprovals: [{
          id: "approval-1",
          runId: "run-1",
          sessionId: "session-1",
          jobId: "job-1",
          status: "pending",
          proposal: {
            summary: "Move reports/final.pdf to Archive/final.pdf",
            request: { storagePoolId: "pool-1", sourcePath: "reports/final.pdf", targetPath: "Archive/final.pdf" },
            args: { command: "mkdir -p Archive && mv reports/final.pdf Archive/final.pdf" },
            requiredSecrets: [{ name: "localPassword", label: "Local approval password", minLength: 8 }]
          },
          risk: "critical",
          revision: 3,
          requiresConfirmation: true,
          expiresAt: "2026-09-17T10:15:00.000Z",
          createdAt: "2026-09-17T10:00:00.000Z",
          updatedAt: "2026-09-17T10:00:00.000Z",
          client: { id: "client-1", name: "Pi", kind: "pi", tokenPrefix: "cyberos_mcp_example" },
          run: {
            id: "run-1",
            capabilityId: "cyberos.files.mutate",
            state: "waiting_approval",
            subjectId: "client-1",
            subjectKind: "pi",
            input: {},
            revision: 2,
            createdAt: "2026-09-17T10:00:00.000Z"
          }
        }],
        message: "",
        composerPath: null,
        status: "ready",
        locale: "en",
        modelSettings: null,
        activeJobId: null,
        activeJobStatus: null,
        messageSubmitting: false,
        hasSession: false,
        transcriptRef: createRef<HTMLDivElement>(),
        onCreateAgent: noop,
        onDeleteSession: noop,
        onOpenSettings: noop,
        onOpenNotifications: noop,
        onRequestSystemPower: async () => true,
        notificationUnreadCount: 0,
        onSelectSession: noop,
        onApproveCapability: noop,
        onRejectCapability: noop,
        onSubmitMessage: noop,
        onMessageChange: noop,
        onClearComposerPath: noop,
        onCancelActiveJob: noop,
        onOpenWorkspacePath: noop
      })
    );

    expect(html).toContain("cyberos.files.mutate");
    expect(html).toContain("Pi (pi)");
    expect(html).toContain("reports/final.pdf -&gt; Archive/final.pdf");
    expect(html).toContain('data-risk="critical"');
    expect(html).toContain("Revision");
    expect(html).toContain(">3<");
    expect(html).toContain("Requested action");
    expect(html).toContain("mkdir -p Archive &amp;&amp; mv reports/final.pdf Archive/final.pdf");
    expect(html).toContain("Local approval password");
    expect(html).not.toContain("local-secret-value");
  });
});
