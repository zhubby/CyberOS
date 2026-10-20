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
    expect(composeAgentMessage("Inspect this", "/zos/data/primary/docs/readme.md")).toBe("/zos/data/primary/docs/readme.md\nInspect this");
    expect(composeAgentMessage("", "/zos/data/primary/docs/readme.md")).toBe("/zos/data/primary/docs/readme.md");
    expect(composeAgentMessage("Inspect this", null)).toBe("Inspect this");
  });
});

describe("agentSessionHeaderTitle", () => {
  const session = {
    id: "session-1",
    rootId: "root-1",
    currentPath: ".",
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    firstMessage: null,
    lastMessage: null
  };

  it("uses a fixed title before a session has any messages", () => {
    expect(agentSessionHeaderTitle(undefined, "New session", "Root agent")).toBe("New session");
    expect(agentSessionHeaderTitle(session, "New session", "Root agent")).toBe("New session");
  });

  it("uses the API session title after the conversation starts", () => {
    expect(agentSessionHeaderTitle({ ...session, firstMessage: "Inspect storage health" }, "New session", "Root agent")).toBe(
      "Inspect storage health"
    );
  });
});

describe("composerFeedbackState", () => {
  it("shows sending while the message request is in flight", () => {
    expect(
      composerFeedbackState({
        activeJobId: null,
        messageSubmitting: true,
        status: "queued" as AppStatus
      })
    ).toBe("sending");
  });

  it("shows queued, running, and reconnecting states for active jobs", () => {
    expect(
      composerFeedbackState({
        activeJobId: "job-1",
        messageSubmitting: false,
        status: "queued" as AppStatus
      })
    ).toBe("queued");
    expect(
      composerFeedbackState({
        activeJobId: "job-1",
        messageSubmitting: false,
        status: "agent-running" as AppStatus
      })
    ).toBe("running");
    expect(
      composerFeedbackState({
        activeJobId: "job-1",
        messageSubmitting: false,
        status: "reconnecting" as AppStatus
      })
    ).toBe("reconnecting");
  });

  it("stays silent when there is no active job", () => {
    expect(
      composerFeedbackState({
        activeJobId: null,
        messageSubmitting: false,
        status: "queued" as AppStatus
      })
    ).toBeNull();
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
        content: "Open /zos/data/primary/docs/readme.md, not /private/other/private.txt",
        rootPath: "/zos/data/primary",
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
        content: "/zos/data/primary/My Files/report (1).pdf\n这个文件是什么内容",
        rootPath: "/zos/data/primary",
        onOpenWorkspacePath: () => undefined
      })
    );

    expect(html).toContain('data-workspace-path="My Files/report (1).pdf"');
    expect(html).toContain("/zos/data/primary/My Files/report (1).pdf");
    expect(html).toContain("这个文件是什么内容");
  });

  it("renders assistant text, inline code, and Markdown link paths as buttons", () => {
    const html = renderToStaticMarkup(
      createElement(ChatMessageContent, {
        role: "assistant",
        content: [
          "Open /zos/data/primary/docs/readme.md.",
          "",
          "`/zos/data/primary/My Files/report.pdf`",
          "",
          "[linked report](/zos/data/primary/reports/latest.pdf)",
          "",
          "```",
          "/zos/data/primary/not-interactive.txt",
          "```"
        ].join("\n"),
        rootPath: "/zos/data/primary",
        onOpenWorkspacePath: () => undefined
      })
    );

    expect(html.match(/class="message-path-button"/gu)).toHaveLength(3);
    expect(html).toContain('data-workspace-path="docs/readme.md"');
    expect(html).toContain('data-workspace-path="My Files/report.pdf"');
    expect(html).toContain('data-workspace-path="reports/latest.pdf"');
    expect(html).toContain('<pre class="message-code-block"><code>/zos/data/primary/not-interactive.txt');
  });
});

describe("ChatPane agent rail", () => {
  it("keeps the compact icon navigation and settings action in the footer", async () => {
    await initI18n();
    const session = {
      id: "session-1",
      rootId: "root-1",
      currentPath: ".",
      createdAt: "2026-09-17T10:00:00.000Z",
      updatedAt: "2026-09-17T10:00:00.000Z",
      firstMessage: null,
      lastMessage: null
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
        activeApprovals: [],
        activeCapabilityApprovals: [],
        message: "",
        composerPath: null,
        status: "ready",
        locale: "en",
        modelSettings: null,
        activeJobId: null,
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
        onApprove: noop,
        onApproveCapability: noop,
        onReject: noop,
        onRejectCapability: noop,
        onSubmitMessage: noop,
        onMessageChange: noop,
        onClearComposerPath: noop,
        onCancelActiveJob: noop,
        onOpenWorkspacePath: noop
      })
    );

    expect(html).toContain('class="agent-brand-logo"');
    expect(html).toContain('src="/zos-icon.svg"');
    expect(html).not.toContain("zos-banner");
    expect(html).toContain('class="session-item is-active"');
    expect(html).toContain("How can I help with your NAS?");
    expect(html).toContain('class="chat-header-subtitle"');
    expect(html).toContain("Local NAS workspace");
    expect(html).toContain('class="agent-status-indicator"');
    expect(html).toContain('class="agent-notification-button"');
    expect(html).toContain('class="notification-badge"');
    expect(html).toContain('class="settings-button agent-settings-button"');
    expect(html).toContain('class="agent-power-button"');
    expect(html.indexOf('class="session-list"')).toBeLessThan(html.indexOf('class="agent-footer"'));
    expect(html.indexOf('class="agent-notification-button"')).toBeLessThan(html.indexOf('class="settings-button agent-settings-button"'));
    expect(html.indexOf('class="settings-button agent-settings-button"')).toBeLessThan(html.indexOf('class="agent-power-button"'));
  });

  it("shows an accessible transcript skeleton while keeping the composer editable", async () => {
    await initI18n();
    const session = {
      id: "session-1",
      rootId: "root-1",
      currentPath: ".",
      createdAt: "2026-09-17T10:00:00.000Z",
      updatedAt: "2026-09-17T10:00:00.000Z",
      firstMessage: null,
      lastMessage: null
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
        activeApprovals: [],
        activeCapabilityApprovals: [],
        message: "Draft stays editable",
        composerPath: null,
        status: "loading",
        locale: "en",
        modelSettings: null,
        activeJobId: null,
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
        onApprove: noop,
        onApproveCapability: noop,
        onReject: noop,
        onRejectCapability: noop,
        onSubmitMessage: noop,
        onMessageChange: noop,
        onClearComposerPath: noop,
        onCancelActiveJob: noop,
        onOpenWorkspacePath: noop
      })
    );

    expect(html).toContain('class="transcript" aria-label="Transcript" aria-busy="true"');
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
        activeApprovals: [],
        activeCapabilityApprovals: [{
          id: "approval-1",
          runId: "run-1",
          status: "pending",
          proposal: {
            summary: "Move reports/final.pdf to Archive/final.pdf",
            request: { rootId: "primary", sourcePath: "reports/final.pdf", targetPath: "Archive/final.pdf" }
          },
          risk: "critical",
          revision: 3,
          requiresConfirmation: true,
          expiresAt: "2026-09-17T10:15:00.000Z",
          createdAt: "2026-09-17T10:00:00.000Z",
          updatedAt: "2026-09-17T10:00:00.000Z",
          client: { id: "client-1", name: "Studio Agent", kind: "lan", tokenPrefix: "zos_mcp_example" },
          run: {
            id: "run-1",
            capabilityId: "zos.files.mutate-propose",
            state: "waiting_approval",
            subjectId: "client-1",
            subjectKind: "lan",
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
        onApprove: noop,
        onApproveCapability: noop,
        onReject: noop,
        onRejectCapability: noop,
        onSubmitMessage: noop,
        onMessageChange: noop,
        onClearComposerPath: noop,
        onCancelActiveJob: noop,
        onOpenWorkspacePath: noop
      })
    );

    expect(html).toContain("zos.files.mutate-propose");
    expect(html).toContain("Studio Agent (lan)");
    expect(html).toContain("reports/final.pdf -&gt; Archive/final.pdf");
    expect(html).toContain('data-risk="critical"');
    expect(html).toContain("Revision");
    expect(html).toContain(">3<");
  });
});
