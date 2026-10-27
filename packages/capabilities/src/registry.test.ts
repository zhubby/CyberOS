import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCatalogDescriptors } from "./catalog.js";
import { CapabilityRegistry } from "./registry.js";
import { validateParityManifest } from "./parity-manifest.js";

const plannedContractSamples = {
  "zos.files.grep": { rootId: "primary", pattern: "needle" },
  "zos.files.find": { rootId: "primary" },
  "zos.files.git": { rootId: "primary" },
  "zos.files.archive-inspect": { rootId: "primary", path: "archive.zip" },
  "zos.photos.media": { assetId: "asset", variant: "preview" },
  "zos.system.power-propose": { request: { operation: "reboot" } },
  "zos.operations.run-propose": { request: { operation: "health" } },
  "zos.backup.run-propose": { request: { operation: "validate" } },
  "zos.docker.manage-propose": { request: { operation: "image_pull", image: "alpine:latest" } },
  "zos.docker.console-propose": { request: { operation: "console", containerId: "container", shell: "/bin/sh" } },
  "zos.vm.manage-propose": { request: { operation: "start", domainName: "vm" } },
  "zos.vm.console-propose": { request: { operation: "console", domainName: "vm" } },
  "zos.network.manage-propose": { request: { operation: "wifi_radio", enabled: true } },
  "zos.storage.manage-propose": {
    request: { operation: "pool_create", name: "pool", level: "1", deviceIds: ["/dev/sda"], filesystem: "ext4" }
  },
  "zos.terminal.manage-propose": { request: { operation: "create", rootId: "primary" } },
  "zos.shell.run": { rootId: "primary", command: "ls" },
  "zos.files.export-propose": { request: { operation: "export", rootId: "primary", paths: ["file.txt"] } },
  "zos.files.edit": { request: { operation: "edit", rootId: "primary", path: "file.txt", find: "old", replace: "new" } },
  "zos.files.write": { request: { operation: "write", rootId: "primary", path: "file.txt", content: "text" } },
  "zos.files.rollback-propose": { request: { operation: "rollback", operationId: "operation" } },
  "zos.index.reindex-propose": { request: { operation: "reindex", rootId: "primary" } },
  "zos.photos.manage-propose": { request: { operation: "scan" } },
  "zos.downloads.manage-propose": { request: { operation: "pause", taskId: "task" } },
  "zos.alerts.manage-propose": { request: { operation: "acknowledge_incident", id: "incident" } },
  "zos.notifications.read-state-propose": { request: { operation: "read_all" } },
  "zos.settings.update-propose": { request: { operation: "agent_policy", policies: {} } },
  "zos.vod.control-propose": { request: { operation: "pause", sessionId: "session" } }
} satisfies Record<string, Record<string, unknown>>;

describe("capability contracts", () => {
  const plannedReadCapabilities = [
    "zos.files.grep",
    "zos.files.find",
    "zos.files.git",
    "zos.files.archive-inspect",
    "zos.photos.media"
  ] as const;
  const plannedConfirmedCapabilities = [
    ["zos.system.power-propose", "critical", "zos:admin:power"],
    ["zos.operations.run-propose", "high", "zos:operations:propose"],
    ["zos.backup.run-propose", "critical", "zos:backup:propose"],
    ["zos.docker.manage-propose", "critical", "zos:docker:propose"],
    ["zos.docker.console-propose", "critical", "zos:docker:propose"],
    ["zos.vm.manage-propose", "critical", "zos:vm:propose"],
    ["zos.vm.console-propose", "critical", "zos:vm:propose"],
    ["zos.network.manage-propose", "critical", "zos:network:propose"],
    ["zos.storage.manage-propose", "critical", "zos:storage:propose"],
    ["zos.terminal.manage-propose", "high", "zos:terminal:propose"],
    ["zos.shell.run", "critical", "zos:admin:shell"]
  ] as const;
  const plannedApprovalCapabilities = [
    ["zos.files.export-propose", "medium", "zos:files:propose"],
    ["zos.files.edit", "high", "zos:files:propose"],
    ["zos.files.write", "high", "zos:files:propose"],
    ["zos.files.rollback-propose", "high", "zos:files:propose"],
    ["zos.index.reindex-propose", "medium", "zos:index:propose"],
    ["zos.photos.manage-propose", "high", "zos:photos:propose"],
    ["zos.downloads.manage-propose", "high", "zos:downloads:propose"],
    ["zos.alerts.manage-propose", "high", "zos:alerts:propose"],
    ["zos.notifications.read-state-propose", "low", "zos:notifications:propose"],
    ["zos.settings.update-propose", "high", "zos:settings:propose"],
    ["zos.vod.control-propose", "high", "zos:vod:propose"]
  ] as const;

  it("keeps a valid, stable parity manifest", () => {
    expect(validateParityManifest()).toEqual([]);
    const descriptors = createCatalogDescriptors();
    expect(descriptors.length).toBeGreaterThan(40);
    expect(descriptors.some((descriptor) => descriptor.id.includes("approve"))).toBe(false);
    expect(descriptors.every((descriptor) => descriptor.inputSchema.additionalProperties === false)).toBe(true);
    expect(() => descriptors.forEach((descriptor) => z.fromJSONSchema(
      descriptor.inputSchema as Parameters<typeof z.fromJSONSchema>[0]
    ))).not.toThrow();
  });

  it("sorts and scope-filters the catalog", () => {
    const registry = new CapabilityRegistry();
    for (const descriptor of createCatalogDescriptors()) registry.register(descriptor);
    const all = registry.list();
    expect(all.map((item) => item.id)).toEqual(all.map((item) => item.id).toSorted());
    expect(registry.listForScopes(new Set(["zos:files:read"])).map((item) => item.id)).toEqual([
      "zos.files.archive-inspect",
      "zos.files.find",
      "zos.files.git",
      "zos.files.grep",
      "zos.files.list",
      "zos.files.read",
      "zos.files.resource-link",
      "zos.files.search",
      "zos.files.stat"
    ]);
  });

  it("defines strict contracts and approval metadata for all 27 planned Pi capabilities", () => {
    const descriptors = new Map(createCatalogDescriptors().map((descriptor) => [descriptor.id, descriptor]));
    const plannedIds = [
      ...plannedReadCapabilities,
      ...plannedConfirmedCapabilities.map(([id]) => id),
      ...plannedApprovalCapabilities.map(([id]) => id)
    ];
    expect(new Set(plannedIds).size).toBe(27);

    for (const id of plannedReadCapabilities) {
      const descriptor = descriptors.get(id);
      expect(descriptor, id).toMatchObject({ risk: "read", approval: "none" });
      expect(descriptor?.requiredScopes, id).toEqual([id === "zos.photos.media" ? "zos:photos:read" : "zos:files:read"]);
    }
    for (const [id, risk, scope] of plannedConfirmedCapabilities) {
      expect(descriptors.get(id), id).toMatchObject({
        risk,
        approval: "first_party_confirm",
        requiredScopes: [scope]
      });
    }
    for (const [id, risk, scope] of plannedApprovalCapabilities) {
      expect(descriptors.get(id), id).toMatchObject({
        risk,
        approval: "first_party",
        requiredScopes: [scope]
      });
    }
    for (const id of plannedIds) {
      const schema = descriptors.get(id)?.inputSchema;
      expect(schema?.additionalProperties, id).toBe(false);
      expect(() => z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]), id).not.toThrow();
    }
  });

  it("accepts a minimal valid request and rejects unknown fields for every planned contract", () => {
    const descriptors = new Map(createCatalogDescriptors().map((descriptor) => [descriptor.id, descriptor]));
    expect(Object.keys(plannedContractSamples)).toHaveLength(27);

    for (const [id, sample] of Object.entries(plannedContractSamples)) {
      const schema = descriptors.get(id as `zos.${string}.${string}`)?.inputSchema;
      const validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
      expect(validator.safeParse(sample).success, `${id} should accept its minimal request`).toBe(true);
      expect(validator.safeParse({ ...sample, unexpected: true }).success, `${id} should reject unknown root fields`).toBe(false);

      if ("request" in sample && typeof sample.request === "object" && sample.request !== null) {
        expect(validator.safeParse({
          ...sample,
          request: { ...sample.request, unexpected: true }
        }).success, `${id} should reject unknown request fields`).toBe(false);
      }
    }
  });

  it("rejects mutation descriptors without approval", () => {
    const registry = new CapabilityRegistry();
    const descriptor = createCatalogDescriptors().find((item) => item.id === "zos.files.mutate");
    expect(descriptor).toBeDefined();
    expect(() => registry.register({ ...descriptor!, approval: "none" })).toThrow("must require first-party approval");
  });

  it("treats cancellation as an owner-scoped safety control", () => {
    const registry = new CapabilityRegistry();
    const descriptor = createCatalogDescriptors().find((item) => item.id === "zos.runs.cancel")!;
    expect(descriptor).toMatchObject({
      approval: "owner_control",
      requiredScopes: ["zos:runs:read"],
      annotations: { readOnlyHint: false, destructiveHint: true }
    });
    expect(() => registry.register({ ...descriptor, domain: "files" })).toThrow("cannot use owner-controlled cancellation");
  });

  it("enforces descriptor output limits at the shared registry boundary", async () => {
    const registry = new CapabilityRegistry();
    const descriptor = createCatalogDescriptors().find((item) => item.id === "zos.files.read")!;
    registry.register({
      ...descriptor,
      maxOutputBytes: 16,
      execute: async () => ({ data: { content: "larger than sixteen bytes" } })
    });

    await expect(registry.invoke("zos.files.read", {}, {
      subject: { id: "client", clientId: "client", kind: "local", scopes: new Set(["zos:files:read"]) },
      traceId: "trace",
      services: {}
    })).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
