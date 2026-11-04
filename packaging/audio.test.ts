import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
describe("audio daemon packaging", () => {
  it("installs a non-root audio service with explicit device and network boundaries", async () => {
    const unit = await read("./systemd/cyberos-audiod.service");
    expect(unit).toContain("User=cyberos");
    expect(unit).toContain("SupplementaryGroups=audio");
    expect(unit).toContain("DevicePolicy=closed");
    expect(unit).toContain("DeviceAllow=char-alsa rw");
    expect(unit).toContain("IPAddressDeny=any");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).not.toContain("PrivateDevices=yes");
    expect(await read("./debian/install")).toContain("target/release/cyberos-audiod usr/lib/cyberos/bin/");
    expect(await read("./scripts/install.sh")).toContain("cyberos-audiod.service");
    expect(await read("./scripts/cyberos-deploy")).toContain("start_service_stably cyberos-audiod.service");
    expect(await read("./debian/prerm")).toContain("cyberos-audiod.service");
  });
});
