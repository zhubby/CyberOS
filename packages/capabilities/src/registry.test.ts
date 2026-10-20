import { describe, expect, it } from "vitest";
import { createCatalogDescriptors } from "./catalog.js";
import { CapabilityRegistry } from "./registry.js";
import { validateParityManifest } from "./parity-manifest.js";

describe("capability contracts", () => {
  it("keeps a valid, stable parity manifest", () => {
    expect(validateParityManifest()).toEqual([]);
    const descriptors = createCatalogDescriptors();
    expect(descriptors.length).toBeGreaterThan(40);
    expect(descriptors.some((descriptor) => descriptor.id.includes("approve"))).toBe(false);
    expect(descriptors.every((descriptor) => descriptor.inputSchema.additionalProperties === false)).toBe(true);
  });

  it("sorts and scope-filters the catalog", () => {
    const registry = new CapabilityRegistry();
    for (const descriptor of createCatalogDescriptors()) registry.register(descriptor);
    const all = registry.list();
    expect(all.map((item) => item.id)).toEqual(all.map((item) => item.id).toSorted());
    expect(registry.listForScopes(new Set(["zos:files:read"])).map((item) => item.id)).toEqual([
      "zos.files.archive-inspect",
      "zos.files.git",
      "zos.files.list",
      "zos.files.read",
      "zos.files.resource-link",
      "zos.files.search",
      "zos.files.stat"
    ]);
  });

  it("rejects mutation descriptors without approval", () => {
    const registry = new CapabilityRegistry();
    const descriptor = createCatalogDescriptors().find((item) => item.id === "zos.files.mutate-propose");
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
