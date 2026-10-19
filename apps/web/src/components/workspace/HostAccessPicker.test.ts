import { describe, expect, it } from "vitest";
import type { DockerHostAccessCatalog, DockerHostAccessGrant } from "@zos/shared";
import { hostAccessPickerBlocked, validContainerTarget } from "./HostAccessPicker.js";

describe("HostAccessPicker", () => {
  it("does not block a legacy submission when no grants are selected", () => {
    expect(blocked([], null, true)).toBe(false);
  });

  it("blocks selected grants while the catalog is unavailable", () => {
    expect(blocked([{ capability: "host_processes" }], null, true)).toBe(true);
  });

  it("blocks unavailable capabilities and NAS roots", () => {
    const unavailableCapability = catalog();
    unavailableCapability.capabilities[0]!.availability = { status: "unavailable", reasonCodes: ["rootless_docker"] };
    expect(blocked([{ capability: "host_processes" }], unavailableCapability)).toBe(true);

    const unavailableRoot = catalog();
    unavailableRoot.nasRoots[0]!.availability = { status: "unavailable", reasonCodes: ["nas_root_not_ready"] };
    expect(blocked([{ capability: "nas_capacity", rootId: "media" }], unavailableRoot)).toBe(true);
  });

  it("requires acknowledgement for degraded capabilities and NAS roots", () => {
    const degradedCapability = catalog();
    degradedCapability.capabilities[0]!.availability = { status: "degraded", reasonCodes: ["user_namespace_enabled"] };
    expect(blocked([{ capability: "host_processes" }], degradedCapability)).toBe(true);
    expect(blocked([{ capability: "host_processes" }], degradedCapability, false, true)).toBe(false);

    const degradedRoot = catalog();
    degradedRoot.nasRoots[0]!.availability = { status: "degraded", reasonCodes: ["resource_identity_changed"] };
    expect(blocked([{ capability: "nas_capacity", rootId: "media" }], degradedRoot)).toBe(true);
    expect(blocked([{ capability: "nas_capacity", rootId: "media" }], degradedRoot, false, true)).toBe(false);
  });

  it("rejects non-normalized container targets", () => {
    expect(validContainerTarget("/host/proc")).toBe(true);
    for (const target of ["host/proc", "/", "/host//proc", "/host/../proc", "/host/proc/"]) {
      expect(validContainerTarget(target), target).toBe(false);
    }
    expect(blocked([{ capability: "host_processes", target: "/host/../proc" }], catalog())).toBe(true);
  });
});

function blocked(
  grants: DockerHostAccessGrant[],
  selectedCatalog: DockerHostAccessCatalog | null,
  loadError = false,
  degradedAcknowledged = false
): boolean {
  return hostAccessPickerBlocked({ grants, catalog: selectedCatalog, loadError, degradedAcknowledged });
}

function catalog(): DockerHostAccessCatalog {
  return {
    policyVersion: "test-policy",
    capabilities: [
      {
        id: "host_processes",
        risk: "high",
        transport: "bind",
        defaultTarget: "/host/proc",
        provides: ["processes"],
        requires: [],
        recommends: [],
        coverage: ["host_processes"],
        availability: { status: "available", reasonCodes: [] }
      },
      {
        id: "nas_capacity",
        risk: "medium",
        transport: "bind",
        defaultTarget: "/host/nas",
        provides: ["capacity"],
        requires: [],
        recommends: [],
        coverage: ["nas_capacity"],
        availability: { status: "available", reasonCodes: [] }
      }
    ],
    nasRoots: [
      {
        rootId: "media",
        name: "Media",
        availability: { status: "available", reasonCodes: [] }
      }
    ]
  };
}
