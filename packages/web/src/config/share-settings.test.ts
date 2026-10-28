import { describe, expect, it } from "vitest";
import type { NasRoot, ShareSettings } from "../api.js";
import {
  createShareFormState,
  shareFormToInput,
  shareSettingsToForm,
  validateShareForm
} from "./share-settings.js";

const roots: NasRoot[] = [
  {
    id: "media",
    name: "Media",
    path: "/cyberos/data/primary/media",
    homePath: null
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
          id: "photostaff",
          name: "Photostaff",
          rootId: "media",
          path: "photostaff",
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
              pathPrefix: "/shares/photostaff"
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
              friendlyName: "Photostaff"
            }
          }
        }
      ],
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    const form = shareSettingsToForm(settings, roots);

    expect(form.account.password).toBe("");
    expect(form.account.passwordConfigured).toBe(true);
    expect(form.shares[0]?.protocols.nfs.allowedCidrs).toBe("192.168.1.0/24");
    expect(form.shares[0]?.protocols.webdav.port).toBe("8088");
  });

  it("converts strings and write-only password fields to API input", () => {
    const share = createShareFormState(roots);
    share.id = "photostaff";
    share.name = "Photostaff";
    share.path = "photostaff";
    share.protocols.webdav.enabled = true;
    share.protocols.webdav.pathPrefix = "dav/photostaff";
    share.protocols.nfs.enabled = true;
    share.protocols.nfs.allowedCidrs = "192.168.1.0/24\nfd00::/64";
    share.protocols.dlna.enabled = true;
    share.protocols.dlna.bindAddress = "192.168.1.5";

    const input = shareFormToInput({
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

    expect(input.account.password).toBe("new-secret");
    expect(input.shares[0]?.protocols.webdav.pathPrefix).toBe("/dav/photostaff");
    expect(input.shares[0]?.protocols.nfs.allowedCidrs).toEqual(["192.168.1.0/24", "fd00::/64"]);
    expect(input.shares[0]?.protocols.dlna.bindAddress).toBe("192.168.1.5");
  });

  it("validates password, CIDR, ports, FTP capacity, and DLNA bind requirements", () => {
    const first = createShareFormState(roots);
    first.protocols.smb.enabled = true;
    first.protocols.ftp.enabled = true;
    first.protocols.nfs.enabled = true;
    first.protocols.nfs.allowedCidrs = "0.0.0.0/0";
    first.protocols.dlna.enabled = true;
    first.protocols.dlna.bindInterface = "";
    first.protocols.dlna.bindAddress = "";

    const second = createShareFormState(roots, [first]);
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
      roots
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
