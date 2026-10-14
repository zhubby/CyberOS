import { describe, expect, it } from "vitest";
import { migrateLibvirtXml, parseLibvirtPathMappings } from "./scripts/zos-migrate-libvirt.mjs";

describe("legacy libvirt migration", () => {
  it("rewrites disk chains and path-valued text without changing similar prefixes", () => {
    const xml = `
      <domain type="kvm">
        <name>guest</name>
        <devices>
          <disk type="file" device="disk">
            <source file="/var/lib/sigmaos/vmstore/guest-active.qcow2"/>
            <backingStore type="file">
              <source file='/var/lib/sigmaos/vmstore/guest-base.qcow2'/>
            </backingStore>
          </disk>
          <disk type="file" device="cdrom"><source file="/srv/iso/debian.iso"/></disk>
        </devices>
        <metadata path="/srv/apps/guest" untouched="/srv/apps-old/guest"/>
        <nvram> /var/lib/sigmaos/nvram/guest.fd </nvram>
      </domain>`;

    const migrated = migrateLibvirtXml(xml, "/srv/apps\t/zos/apps\n/srv/iso\t/zos/iso\n");

    expect(migrated.replacements).toBe(5);
    expect(migrated.contents).toContain('/zos/vm/guest-active.qcow2');
    expect(migrated.contents).toContain("/zos/vm/guest-base.qcow2");
    expect(migrated.contents).toContain('/zos/iso/debian.iso');
    expect(migrated.contents).toContain('path="/zos/apps/guest"');
    expect(migrated.contents).toContain('untouched="/srv/apps-old/guest"');
    expect(migrated.contents).toContain("<nvram> /zos/state/nvram/guest.fd </nvram>");
  });

  it("uses the most specific mapping and rejects conflicting mappings", () => {
    const mappings = parseLibvirtPathMappings("/var/lib/sigmaos/vmstore\t/zos/vm\n");
    expect(mappings[0]).toEqual(["/var/lib/sigmaos/vmstore", "/zos/vm"]);
    expect(() => parseLibvirtPathMappings("/var/lib/sigmaos\t/zos/elsewhere\n"))
      .toThrow("conflicting migration mapping");
  });

  it("rejects malformed domain XML", () => {
    expect(() => migrateLibvirtXml("<domain>", ""))
      .toThrow("source libvirt XML is invalid");
  });
});
