import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCatalogDescriptors } from "./catalog.js";
import { CapabilityRegistry } from "./registry.js";
import { validateParityManifest } from "./parity-manifest.js";

const plannedContractSamples = {
  "cyberos.files.grep": { storagePoolId: "pool-1", pattern: "needle" },
  "cyberos.files.find": { storagePoolId: "pool-1" },
  "cyberos.files.git": { storagePoolId: "pool-1" },
  "cyberos.files.archive-inspect": { storagePoolId: "pool-1", path: "archive.zip" },
  "cyberos.photos.media": { assetId: "asset", variant: "preview" },
  "cyberos.system.power-propose": { request: { operation: "reboot" } },
  "cyberos.operations.run-propose": { request: { operation: "health" } },
  "cyberos.backup.run-propose": { request: { operation: "validate" } },
  "cyberos.docker.manage-propose": { request: { operation: "image_pull", image: "alpine:latest" } },
  "cyberos.docker.console-propose": { request: { operation: "console", containerId: "container", shell: "/bin/sh" } },
  "cyberos.vm.manage-propose": { request: { operation: "start", domainName: "vm" } },
  "cyberos.vm.console-propose": { request: { operation: "console", domainName: "vm" } },
  "cyberos.network.manage-propose": { request: { operation: "wifi_radio", enabled: true } },
  "cyberos.storage.manage-propose": {
    request: { operation: "pool_create", name: "pool", level: "1", deviceIds: ["/dev/sda"], filesystem: "ext4" }
  },
  "cyberos.terminal.manage-propose": { request: { operation: "create" } },
  "cyberos.shell.run": { storagePoolId: "pool-1", command: "ls" },
  "cyberos.files.export-propose": { request: { operation: "export", storagePoolId: "pool-1", paths: ["file.txt"] } },
  "cyberos.files.edit": { request: { operation: "edit", storagePoolId: "pool-1", path: "file.txt", find: "old", replace: "new" } },
  "cyberos.files.write": { request: { operation: "write", storagePoolId: "pool-1", path: "file.txt", content: "text" } },
  "cyberos.files.rollback-propose": { request: { operation: "rollback", operationId: "operation" } },
  "cyberos.index.reindex-propose": { request: { operation: "reindex", storagePoolId: "pool-1" } },
  "cyberos.photos.manage-propose": { request: { operation: "scan" } },
  "cyberos.downloads.manage-propose": { request: { operation: "pause", taskId: "task" } },
  "cyberos.alerts.manage-propose": { request: { operation: "acknowledge_incident", id: "incident" } },
  "cyberos.notifications.read-state-propose": { request: { operation: "read_all" } },
  "cyberos.settings.update-propose": { request: { operation: "agent_policy", policies: {} } },
  "cyberos.vod.control-propose": { request: { operation: "pause", sessionId: "session" } }
} satisfies Record<string, Record<string, unknown>>;

describe("capability contracts", () => {
  const plannedReadCapabilities = [
    "cyberos.files.grep",
    "cyberos.files.find",
    "cyberos.files.git",
    "cyberos.files.archive-inspect",
    "cyberos.photos.media"
  ] as const;
  const plannedConfirmedCapabilities = [
    ["cyberos.system.power-propose", "critical", "cyberos:admin:power"],
    ["cyberos.operations.run-propose", "high", "cyberos:operations:propose"],
    ["cyberos.backup.run-propose", "critical", "cyberos:backup:propose"],
    ["cyberos.docker.manage-propose", "critical", "cyberos:docker:propose"],
    ["cyberos.docker.console-propose", "critical", "cyberos:docker:propose"],
    ["cyberos.vm.manage-propose", "critical", "cyberos:vm:propose"],
    ["cyberos.vm.console-propose", "critical", "cyberos:vm:propose"],
    ["cyberos.network.manage-propose", "critical", "cyberos:network:propose"],
    ["cyberos.storage.manage-propose", "critical", "cyberos:storage:propose"],
    ["cyberos.terminal.manage-propose", "high", "cyberos:terminal:propose"],
    ["cyberos.shell.run", "critical", "cyberos:admin:shell"]
  ] as const;
  const plannedApprovalCapabilities = [
    ["cyberos.files.export-propose", "medium", "cyberos:files:propose"],
    ["cyberos.files.edit", "high", "cyberos:files:propose"],
    ["cyberos.files.write", "high", "cyberos:files:propose"],
    ["cyberos.files.rollback-propose", "high", "cyberos:files:propose"],
    ["cyberos.index.reindex-propose", "medium", "cyberos:index:propose"],
    ["cyberos.photos.manage-propose", "high", "cyberos:photos:propose"],
    ["cyberos.downloads.manage-propose", "high", "cyberos:downloads:propose"],
    ["cyberos.alerts.manage-propose", "high", "cyberos:alerts:propose"],
    ["cyberos.notifications.read-state-propose", "low", "cyberos:notifications:propose"],
    ["cyberos.settings.update-propose", "high", "cyberos:settings:propose"],
    ["cyberos.vod.control-propose", "high", "cyberos:vod:propose"]
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
    expect(registry.listForScopes(new Set(["cyberos:files:read"])).map((item) => item.id)).toEqual([
      "cyberos.files.archive-inspect",
      "cyberos.files.find",
      "cyberos.files.git",
      "cyberos.files.grep",
      "cyberos.files.list",
      "cyberos.files.read",
      "cyberos.files.resource-link",
      "cyberos.files.search",
      "cyberos.files.stat"
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
      expect(descriptor?.requiredScopes, id).toEqual([id === "cyberos.photos.media" ? "cyberos:photos:read" : "cyberos:files:read"]);
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
      const schema = descriptors.get(id as `cyberos.${string}.${string}`)?.inputSchema;
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
    const descriptor = createCatalogDescriptors().find((item) => item.id === "cyberos.files.mutate");
    expect(descriptor).toBeDefined();
    expect(() => registry.register({ ...descriptor!, approval: "none" })).toThrow("must require first-party approval");
  });

  it("treats cancellation as an owner-scoped safety control", () => {
    const registry = new CapabilityRegistry();
    const descriptor = createCatalogDescriptors().find((item) => item.id === "cyberos.runs.cancel")!;
    expect(descriptor).toMatchObject({
      approval: "owner_control",
      requiredScopes: ["cyberos:runs:read"],
      annotations: { readOnlyHint: false, destructiveHint: true }
    });
    expect(() => registry.register({ ...descriptor, domain: "files" })).toThrow("cannot use owner-controlled cancellation");
  });

  it("enforces descriptor output limits at the shared registry boundary", async () => {
    const registry = new CapabilityRegistry();
    const descriptor = createCatalogDescriptors().find((item) => item.id === "cyberos.files.read")!;
    registry.register({
      ...descriptor,
      maxOutputBytes: 16,
      execute: async () => ({ data: { content: "larger than sixteen bytes" } })
    });

    await expect(registry.invoke("cyberos.files.read", {}, {
      subject: { id: "client", clientId: "client", kind: "local", scopes: new Set(["cyberos:files:read"]) },
      traceId: "trace",
      services: {}
    })).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
