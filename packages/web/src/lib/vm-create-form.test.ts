import { describe, expect, it } from "vitest";
import { initialVmCreateForm, isArmVmArchitecture, validateVmCreateStep, vmSnapshotName } from "./vm-create-form.js";

const t = (key: string) => key;

describe("VM create form", () => {
  it("uses safe defaults and accepts a complete ISO configuration", () => {
    const form = { ...initialVmCreateForm("default"), name: "home-lab", isoPath: "images/ubuntu.iso" };
    expect(form).toMatchObject({ vcpu: "2", memoryGiB: "2", diskBus: "virtio", networkModel: "virtio", firmware: "bios" });
    expect(validateVmCreateStep(4, form, t)).toBeNull();
  });

  it("blocks incomplete stages and inconsistent topology", () => {
    const empty = initialVmCreateForm();
    expect(validateVmCreateStep(1, empty, t)).toContain("validationName");
    const topology = { ...empty, name: "guest", customTopology: true, vcpu: "4", sockets: "1", cores: "1", threads: "1" };
    expect(validateVmCreateStep(2, topology, t)).toContain("validationTopology");
    expect(validateVmCreateStep(3, { ...topology, customTopology: false }, t)).toContain("validationMedia");
  });

  it("validates custom CPU models and MAC addresses", () => {
    const base = { ...initialVmCreateForm(), name: "guest", isoPath: "installer.iso" };
    expect(validateVmCreateStep(2, { ...base, cpuMode: "custom" }, t)).toContain("validationCpuModel");
    expect(validateVmCreateStep(3, { ...base, macAddress: "not-a-mac" }, t)).toContain("validationMac");
  });

  it("uses compatible CPU and firmware defaults on Arm hosts", () => {
    expect(isArmVmArchitecture("aarch64")).toBe(true);
    expect(initialVmCreateForm("default", "arm64")).toMatchObject({
      cpuMode: "host-passthrough",
      firmware: "uefi"
    });
    expect(initialVmCreateForm("default", "aarch64")).toMatchObject({
      cpuMode: "host-passthrough",
      firmware: "uefi"
    });
    expect(initialVmCreateForm("default", "x64")).toMatchObject({
      cpuMode: "host-model",
      firmware: "bios"
    });
  });

  it("creates unique snapshot names within the libvirt name limit", () => {
    const domain = "a".repeat(63);
    const first = vmSnapshotName(domain, new Date("2026-10-08T15:20:30.000Z"));
    const second = vmSnapshotName(domain, new Date("2026-10-08T15:20:31.000Z"));

    expect(first).toHaveLength(63);
    expect(first).toMatch(/-20261008152030$/u);
    expect(second).not.toBe(first);
  });
});
