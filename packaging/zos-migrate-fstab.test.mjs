import { describe, expect, it } from "vitest";
import { migrateFstab } from "./scripts/zos-migrate-fstab.mjs";

describe("legacy fstab migration", () => {
  it("moves exact and nested mount targets without changing unrelated entries", () => {
    const source = `# system mounts
UUID=root / ext4 defaults 0 1
UUID=nas /srv/nas/pool1 btrfs defaults,noatime 0 2
UUID=backup\t/srv/backup\text4\tdefaults\t0\t2
server:/media /mnt/media nfs defaults 0 0
`;

    expect(migrateFstab(source, [
      { source: "/srv/nas", target: "/zos/data/primary" },
      { source: "/srv/backup", target: "/zos/data/backup" }
    ])).toBe(`# system mounts
UUID=root / ext4 defaults 0 1
UUID=nas /zos/data/primary/pool1 btrfs defaults,noatime 0 2
UUID=backup\t/zos/data/backup\text4\tdefaults\t0\t2
server:/media /mnt/media nfs defaults 0 0
`);
  });

  it("rejects root and relative mappings", () => {
    expect(() => migrateFstab("UUID=x /srv/nas ext4 defaults 0 2\n", [
      { source: "/", target: "/zos/data/primary" }
    ])).toThrow("invalid migration path");
    expect(() => migrateFstab("UUID=x /srv/nas ext4 defaults 0 2\n", [
      { source: "srv/nas", target: "/zos/data/primary" }
    ])).toThrow("invalid migration path");
  });
});
