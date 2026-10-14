import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { migrateLegacyConfig } from "./scripts/zos-migrate-config.mjs";

describe("legacy ZOS configuration migration", () => {
  it("preserves settings while moving every managed path under /zos", () => {
    const source = `
data_dir = "/var/lib/sigmaos"
environment = "production"

[admin]
display_name = "SigmaOS Admin"

[model]
provider = "cloud"
local_endpoint = "https://model.example.test"

[vm]
enabled = true
storage_path = "/var/lib/sigmaos/vmstore"
iso_roots = ["/srv/iso"]

[hostd]
socket_path = "/run/sigmaos/share-helper.sock"

[shares]
enabled = true
account_username = "sigma-share"

[terminal]
user = "sigmaos"
termux_socket_path = "/run/sigmaos/termux.sock"

[vod_player]
enabled = true
socket_path = "/run/sigmaos/vod-player.sock"
state_path = "/var/lib/sigmaos-vod-player/session.json"
user = "sigmaos"

[[nas_roots]]
id = "primary"
name = "Primary NAS"
path = "/srv/nas"
mount_policy = "required"
expected_uuid = "test-uuid"

[backup]
enabled = true
repository_path = "/srv/backup/restic"
password_file = "/etc/sigmaos/restic-password"
staging_path = "/var/lib/sigmaos/backup-staging"
`;

    const result = migrateLegacyConfig(source);
    const config = parse(result.contents);

    expect(result.sourceSha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(result.nasRootMappings).toEqual([{ source: "/srv/nas", target: "/zos/data/primary" }]);
    expect(config).not.toHaveProperty("data_dir");
    expect(config).toMatchObject({
      root_dir: "/zos",
      environment: "production",
      admin: { display_name: "ZOS Admin" },
      model: { provider: "cloud", local_endpoint: "https://model.example.test" },
      vm: { enabled: true, storage_path: "/zos/vm", iso_roots: ["/zos/iso"] },
      hostd: { socket_path: "/run/zos/hostd.sock" },
      shares: { enabled: true, account_username: "sigma-share" },
      terminal: { user: "zos", termux_socket_path: "/run/zos/termux.sock" },
      vod_player: {
        enabled: true,
        socket_path: "/run/zos/vod-player.sock",
        state_path: "/zos/state/vod-player/session.json",
        user: "zos"
      },
      nas_roots: [{
        id: "primary",
        name: "Primary NAS",
        path: "/zos/data/primary",
        mount_policy: "required",
        expected_uuid: "test-uuid"
      }],
      backup: {
        enabled: true,
        repository_path: "/zos/data/backup/restic",
        password_file: "/zos/config/restic-password",
        staging_path: "/zos/state/backup-staging"
      }
    });
  });

  it("creates canonical unique root paths for incomplete legacy roots", () => {
    const result = migrateLegacyConfig(`
[[nas_roots]]
id = "Media Pool"
path = "/srv/media"

[[nas_roots]]
id = "media-pool"
path = "/srv/media-two"
`);

    expect(result.nasRootMappings).toEqual([
      { source: "/srv/media", target: "/zos/data/media-pool" },
      { source: "/srv/media-two", target: "/zos/data/media-pool-2" }
    ]);
  });

  it.each(["/", "/zos", "/zos/data/existing", "srv/nas", "/srv/nas\tother"])(
    "rejects unsafe legacy root path %j before copying data",
    (legacyPath) => {
      expect(() => migrateLegacyConfig(`
[[nas_roots]]
id = "primary"
path = ${JSON.stringify(legacyPath)}
`)).toThrow(/legacy NAS root path/u);
    }
  );

  it("rejects duplicate and nested legacy source roots", () => {
    expect(() => migrateLegacyConfig(`
[[nas_roots]]
id = "primary"
path = "/srv/nas"

[[nas_roots]]
id = "secondary"
path = "/srv/nas/"
`)).toThrow("overlapping legacy managed paths");

    expect(() => migrateLegacyConfig(`
[[nas_roots]]
id = "primary"
path = "/srv/nas"

[[nas_roots]]
id = "secondary"
path = "/srv/nas/media"
`)).toThrow("overlapping legacy managed paths");
  });

  it("keeps dot-only root identifiers inside /zos/data", () => {
    const result = migrateLegacyConfig(`
[[nas_roots]]
id = ".."
path = "/srv/nas"
`);

    expect(result.nasRootMappings).toEqual([{ source: "/srv/nas", target: "/zos/data/primary" }]);
  });
});
