import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DockerContainer, DockerContainerDetails, VmSummary } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { DockerComposeAppDialog } from "./DockerComposeAppDialog.js";
import {
  DockerContainerDetailsDialog,
  VmInstanceActions,
  VmInstanceDetailsDialog
} from "./WorkspaceManagementPanel.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

const runningDetails: DockerContainerDetails = {
  id: "container-1",
  shortId: "container",
  name: "rustfs",
  image: "rustfs/rustfs:latest",
  imageId: "sha256:rustfs",
  state: "running",
  status: "Up 10 minutes",
  ports: ["9000/tcp"],
  composeProject: null,
  composeService: null,
  cpuPercent: 1.2,
  memoryUsageBytes: 32 * 1024 ** 2,
  memoryLimitBytes: 512 * 1024 ** 2,
  memoryPercent: 6.25,
  createdAt: "2026-09-17T12:00:00.000Z",
  command: "rustfs /data",
  entrypoint: [],
  environment: [],
  mounts: [],
  networks: ["bridge"],
  restartPolicy: "unless-stopped",
  hostname: "rustfs",
  workingDir: "/",
  labels: {}
};

describe("DockerContainerDetailsDialog", () => {
  it("uses the latest summary state for status and lifecycle actions", () => {
    const stoppedSummary: DockerContainer = {
      ...runningDetails,
      state: "exited",
      status: "Exited (0) 1 minute ago",
      cpuPercent: null,
      memoryUsageBytes: null,
      memoryLimitBytes: null,
      memoryPercent: null
    };
    const html = renderToStaticMarkup(createElement(DockerContainerDetailsDialog, {
      state: {
        container: stoppedSummary,
        details: runningDetails,
        loading: false,
        error: null
      },
      locale: "en",
      canUseDocker: true,
      pendingAction: null,
      consoleApproved: false,
      onClose: vi.fn(),
      onAction: vi.fn(),
      onLogs: vi.fn(),
      onConsole: vi.fn()
    }));

    expect(html).toContain("Exited (0) 1 minute ago");
    expect(html).toContain('title="Start"');
    expect(html).not.toContain('title="Stop"');
    expect(html).toContain("rustfs /data");
  });
});

describe("DockerComposeAppDialog", () => {
  it("renders the managed path and complete create actions", () => {
    const html = renderToStaticMarkup(createElement(DockerComposeAppDialog, {
      app: null,
      engineReady: true,
      canDeploy: true,
      onClose: vi.fn(),
      onRefresh: vi.fn(),
      onRequestDeploy: vi.fn(),
      onNotifySuccess: vi.fn()
    }));

    expect(html).toContain("Create Compose App");
    expect(html).toContain("/cyberos/apps/...");
    expect(html).toContain("Validate");
    expect(html).toContain("Save and deploy");
  });
});

describe("VmInstanceDetailsDialog", () => {
  it("renders instance identity, resources, attachments, and running actions", () => {
    const vm: VmSummary["instances"][number] = {
      id: "guest-id",
      name: "arch-linux",
      state: "running",
      uuid: "6bf3ae63-a248-4a98-8c30-479e75d06c82",
      vcpu: 4,
      memoryBytes: 4 * 1024 ** 3,
      maxMemoryBytes: 8 * 1024 ** 3,
      os: "Arch Linux",
      disks: [{ source: "/cyberos/vm/arch-linux.qcow2", capacityBytes: 20 * 1024 ** 3 }],
      networks: [{ name: "vnet7", source: "default", mac: "52:54:00:12:34:56" }]
    };
    const html = renderToStaticMarkup(createElement(VmInstanceDetailsDialog, {
      vm,
      hostArchitecture: "arm64",
      locale: "en",
      canMutate: true,
      canConsole: true,
      pendingAction: null,
      onClose: vi.fn(),
      onRequest: vi.fn(),
      onRequestConsole: vi.fn()
    }));

    expect(html).toContain("arch-linux");
    expect(html).toContain("6bf3ae63-a248-4a98-8c30-479e75d06c82");
    expect(html).toContain("Arch Linux");
    expect(html).toContain("arm64");
    expect(html).toContain("/cyberos/vm/arch-linux.qcow2");
    expect(html).toContain("52:54:00:12:34:56");
    expect(html).toContain("20.0 GB");
    expect(html).toContain("VM actions run immediately");
    expect(html).not.toContain("approval");
    expect(html).toContain('title="Stop"');
    expect(html).toContain('title="Console"');
    expect(html).toContain('title="Remove"');
  });
});

describe("VmInstanceActions", () => {
  const vm: VmSummary["instances"][number] = {
    id: "guest-id",
    name: "guest",
    state: "running",
    uuid: "guest-id",
    vcpu: 2,
    memoryBytes: 1024,
    maxMemoryBytes: 2048,
    os: null,
    disks: [],
    networks: []
  };
  const props = {
    canMutate: true,
    canConsole: true,
    pendingAction: null,
    onRequest: vi.fn(),
    onRequestConsole: vi.fn()
  };

  it("shows the complete running lifecycle without invalid start or resume actions", () => {
    const html = renderToStaticMarkup(createElement(VmInstanceActions, { ...props, vm }));

    expect(html).toContain('title="Stop"');
    expect(html).toContain('title="Pause"');
    expect(html).toContain('title="Force stop"');
    expect(html).toContain('title="Restart"');
    expect(html).toContain('title="Hard reset"');
    expect(html).toContain('title="Snapshot"');
    expect(html).toContain('title="Console"');
    expect(html).not.toContain('title="Start"');
    expect(html).not.toContain('title="Resume"');
  });

  it("resumes paused guests and limits stopped guests to valid actions", () => {
    const paused = renderToStaticMarkup(createElement(VmInstanceActions, { ...props, vm: { ...vm, state: "paused" } }));
    const stopped = renderToStaticMarkup(createElement(VmInstanceActions, { ...props, vm: { ...vm, state: "shutoff" } }));

    expect(paused).toContain('title="Resume"');
    expect(paused).not.toContain('title="Start"');
    expect(paused).not.toContain('title="Restart"');
    expect(stopped).toContain('title="Start"');
    expect(stopped).toContain('title="Remove"');
    expect(stopped).not.toContain('title="Console"');
    expect(stopped).not.toContain('title="Snapshot"');
  });
});
