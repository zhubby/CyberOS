import { describe, expect, it } from "vitest";
import type { ShareSettings, StoragePool } from "../api.js";
import {
  createShareFormState,
  shareDirectoriesToInput,
  shareSettingsToForm,
  validateShareAccountDraft,
  validateShareForm
} from "./share-settings.js";

const storagePools: StoragePool[] = [
  {
    id: "media",
    name: "Media",
    mountpoint: "/cyberos/data/media",
    path: "/cyberos/data/media",
    filesystem: "ext4",
    status: "ready"
  }
];

describe("share settings form helpers", () => {
  it("hydrates public settings without exposing a password", () => {
    const settings: ShareSettings = {
      enabled: true,
      account: {
        username: "cyberos-share",
        passwordConfigured: true
      },
      shares: [
        {
          id: "photos",
          protocol: "smb",
          name: "Photos",
          storagePoolId: "media",
          path: "photos",
          description: "family archive",
          protocols: {
            smb: {
              enabled: true,
              readOnly: false,
              browseable: true,
              allowGuest: false
            },
            webdav: {
              enabled: true,
              readOnly: true,
              allowGuest: false,
              port: 8088,
              pathPrefix: "/shares/photos"
            },
            ftp: {
              enabled: false,
              readOnly: true,
              allowGuest: false,
              port: 2121,
              passivePortStart: 50000,
              passivePortEnd: 50100
            },
            nfs: {
              enabled: true,
              readOnly: true,
              allowedCidrs: ["192.168.1.0/24"],
              rootSquash: true
            },
            dlna: {
              enabled: true,
              mediaTypes: ["pictures"],
              bindInterface: "eth0",
              bindAddress: null,
              friendlyName: "Photos"
            }
          }
        }
      ],
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    const form = shareSettingsToForm(settings, storagePools);

    expect(form.account.password).toBe("");
    expect(form.account.passwordConfigured).toBe(true);
    expect(form.shares[0]?.protocols.nfs.allowedCidrs).toBe("192.168.1.0/24");
    expect(form.shares[0]?.protocols.webdav.port).toBe("8088");
  });

  it("converts directory fields without overwriting global sharing or credentials", () => {
    const share = createShareFormState(storagePools);
    share.id = "photos";
    share.name = "Photos";
    share.path = "photos";
    share.protocols.webdav.enabled = true;
    share.protocols.webdav.pathPrefix = "dav/photos";
    share.protocols.nfs.enabled = true;
    share.protocols.nfs.allowedCidrs = "192.168.1.0/24\nfd00::/64";
    share.protocols.dlna.enabled = true;
    share.protocols.dlna.bindAddress = "192.168.1.5";

    const input = shareDirectoriesToInput({
      enabled: true,
      account: {
        username: "cyberos-share",
        password: "new-secret",
        clearPassword: false,
        passwordConfigured: false
      },
      shares: [share],
      updatedAt: new Date(0).toISOString()
    });

    expect(input.account).toBeUndefined();
    expect(input.enabled).toBeUndefined();
    expect(input.shares?.[0]?.protocols.webdav.pathPrefix).toBe("/dav/photos");
    expect(input.shares?.[0]?.protocols.nfs.allowedCidrs).toEqual(["192.168.1.0/24", "fd00::/64"]);
    expect(input.shares?.[0]?.protocols.dlna.bindAddress).toBe("192.168.1.5");
  });

  it("validates system-safe account credentials", () => {
    expect(validateShareAccountDraft("Share User", "", "")).toBe("invalidUsername");
    expect(validateShareAccountDraft("share-user", "next-secret", "different")).toBe("passwordMismatch");
    expect(validateShareAccountDraft("share-user", "line\nbreak", "line\nbreak")).toBe("invalidPassword");
    expect(validateShareAccountDraft("share-user", "next-secret", "next-secret")).toBeNull();
  });

  it("validates password, CIDR, ports, FTP capacity, and DLNA bind requirements", () => {
    const first = createShareFormState(storagePools);
    first.protocols.smb.enabled = true;
    first.protocols.ftp.enabled = true;
    first.protocols.nfs.enabled = true;
    first.protocols.nfs.allowedCidrs = "0.0.0.0/0";
    first.protocols.dlna.enabled = true;
    first.protocols.dlna.bindInterface = "";
    first.protocols.dlna.bindAddress = "";

    const second = createShareFormState(storagePools, [first]);
    second.protocols.ftp.enabled = true;
    second.protocols.ftp.passivePortStart = "51000";
    second.protocols.ftp.passivePortEnd = "50000";

    const issues = validateShareForm(
      {
        enabled: true,
        account: {
          username: "cyberos-share",
          password: "",
          clearPassword: false,
          passwordConfigured: false
        },
        shares: [first, second],
        updatedAt: new Date(0).toISOString()
      },
      storagePools
    );

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "missingPassword",
        "invalidNfsCidr",
        "dlnaMissingBind",
        "invalidFtpPassiveRange",
        "multipleFtp"
      ])
    );
  });
});
