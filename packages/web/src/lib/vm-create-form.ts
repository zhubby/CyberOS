export type VmCreateForm = {
  name: string;
  osVariant: string;
  vcpu: string;
  memoryGiB: string;
  cpuMode: "host-model" | "host-passthrough" | "custom";
  cpuModel: string;
  customTopology: boolean;
  sockets: string;
  cores: string;
  threads: string;
  memoryBacking: "default" | "hugepages";
  diskGiB: string;
  mediaMode: "iso" | "disk";
  isoPath: string;
  isoRootId: string;
  isoStoragePoolId: string;
  diskPath: string;
  diskBus: "virtio" | "scsi" | "sata" | "ide";
  diskCache: "none" | "writeback" | "writethrough" | "directsync" | "unsafe";
  diskDiscard: "ignore" | "unmap";
  network: string;
  networkModel: "virtio" | "e1000" | "rtl8139";
  macAddress: string;
  firmware: "bios" | "uefi";
  machineType: string;
  graphics: "none" | "spice" | "vnc";
  videoModel: "none" | "virtio" | "qxl" | "vga";
  bootMenu: boolean;
  autostart: boolean;
};

type Translate = (key: string) => unknown;

export function isArmVmArchitecture(architecture?: string | null): boolean {
  return architecture === "arm64" || architecture === "aarch64";
}

export function initialVmCreateForm(network = "default", architecture = "x64"): VmCreateForm {
  const isArm = isArmVmArchitecture(architecture);
  return {
    name: "", osVariant: "", vcpu: "2", memoryGiB: "2", cpuMode: isArm ? "host-passthrough" : "host-model", cpuModel: "",
    customTopology: false, sockets: "1", cores: "2", threads: "1", memoryBacking: "default",
    diskGiB: "20", mediaMode: "iso", isoPath: "", isoRootId: "", isoStoragePoolId: "", diskPath: "",
    diskBus: "virtio", diskCache: "none", diskDiscard: "ignore", network, networkModel: "virtio", macAddress: "",
    firmware: isArm ? "uefi" : "bios", machineType: "", graphics: "none", videoModel: "none", bootMenu: false, autostart: false
  };
}

export function vmSnapshotName(domainName: string, now = new Date()): string {
  const timestamp = now.toISOString().replace(/\D/gu, "").slice(0, 14);
  const maxDomainLength = 63 - timestamp.length - 1;
  return `${domainName.slice(0, maxDomainLength)}-${timestamp}`;
}

export function validateVmCreateStep(step: number, form: VmCreateForm, t: Translate): string | null {
  const token = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,63}$/u;
  if (step >= 1 && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/u.test(form.name.trim())) {
    return String(t("workspace.management.virtualMachines.validationName"));
  }
  if (step >= 1 && form.osVariant.trim() && !token.test(form.osVariant.trim())) {
    return String(t("workspace.management.virtualMachines.validationToken"));
  }
  if (step >= 2) {
    const vcpu = Number(form.vcpu);
    const memory = Number(form.memoryGiB);
    if (!Number.isInteger(vcpu) || vcpu < 1 || vcpu > 128 || !Number.isFinite(memory) || memory < 0.25 || memory > 1024) {
      return String(t("workspace.management.virtualMachines.validationResources"));
    }
    if (form.cpuMode === "custom" && !token.test(form.cpuModel.trim())) {
      return String(t("workspace.management.virtualMachines.validationCpuModel"));
    }
    if (form.customTopology) {
      const sockets = Number(form.sockets);
      const cores = Number(form.cores);
      const threads = Number(form.threads);
      if (!Number.isInteger(sockets) || !Number.isInteger(cores) || !Number.isInteger(threads) || sockets < 1 || cores < 1 || threads < 1 || sockets * cores * threads !== vcpu) {
        return String(t("workspace.management.virtualMachines.validationTopology"));
      }
    }
  }
  if (step >= 3) {
    const mediaPath = form.mediaMode === "iso" ? form.isoPath.trim() : form.diskPath.trim();
    const disk = Number(form.diskGiB);
    if (!mediaPath || !form.network || (form.mediaMode === "iso" && (!Number.isInteger(disk) || disk < 1 || disk > 65536))) {
      return String(t("workspace.management.virtualMachines.validationMedia"));
    }
    if (form.macAddress.trim() && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(form.macAddress.trim())) {
      return String(t("workspace.management.virtualMachines.validationMac"));
    }
  }
  if (step >= 4 && form.machineType.trim() && !token.test(form.machineType.trim())) {
    return String(t("workspace.management.virtualMachines.validationToken"));
  }
  return null;
}
