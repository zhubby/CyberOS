import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DockerNetworkDetails, DockerSummary, DockerVolumeDetails } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { DockerNetworkDetailsDialog, DockerVolumeDetailsDialog } from "./DockerInspectDetails.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

const network: DockerSummary["networks"][number] = {
  id: "network-1",
  name: "media-net",
  driver: "bridge",
  scope: "local",
  containerCount: 1
};

const networkDetails: DockerNetworkDetails = {
  ...network,
  createdAt: "2026-09-17T12:00:00.000Z",
  enableIPv4: true,
  enableIPv6: false,
  internal: false,
  attachable: true,
  ingress: false,
  ipam: { driver: "default", configs: [{ subnet: "172.20.0.0/16", ipRange: null, gateway: "172.20.0.1", auxiliaryAddresses: { router: "172.20.0.2" } }] },
  options: { bridge: "br-media" },
  labels: { role: "media" },
  containers: [{ id: "container-1", name: "jellyfin", endpointId: "endpoint-1", macAddress: "02:42:ac:14:00:02", ipv4Address: "172.20.0.2/16", ipv6Address: null }]
};

const volume: DockerSummary["volumes"][number] = {
  name: "media-data",
  driver: "local",
  scope: "local",
  mountpoint: "/var/lib/docker/volumes/media-data/_data"
};

const volumeDetails: DockerVolumeDetails = {
  ...volume,
  createdAt: "2026-09-17T12:00:00.000Z",
  labels: { role: "media" },
  options: { type: "none" },
  status: { availability: "active" },
  sizeBytes: 4096,
  referenceCount: 1
};

describe("DockerNetworkDetailsDialog", () => {
  it("keeps summary data visible while inspect is loading or fails", () => {
    const loading = renderToStaticMarkup(createElement(DockerNetworkDetailsDialog, {
      state: { network, details: null, loading: true, error: null },
      locale: "en",
      onClose: vi.fn()
    }));
    const failed = renderToStaticMarkup(createElement(DockerNetworkDetailsDialog, {
      state: { network, details: null, loading: false, error: "inspect failed" },
      locale: "en",
      onClose: vi.fn()
    }));

    expect(loading).toContain("Loading Docker inspect data");
    expect(loading).toContain("media-net");
    expect(failed).toContain("inspect failed");
    expect(failed).toContain("media-net");
  });

  it("renders complete address, container, option, and label details", () => {
    const html = renderToStaticMarkup(createElement(DockerNetworkDetailsDialog, {
      state: { network, details: networkDetails, loading: false, error: null },
      locale: "en",
      onClose: vi.fn()
    }));

    for (const value of ["172.20.0.0/16", "172.20.0.1", "jellyfin", "02:42:ac:14:00:02", "br-media", "role", "media"]) {
      expect(html).toContain(value);
    }
  });
});

describe("DockerVolumeDetailsDialog", () => {
  it("renders inspect usage and metadata", () => {
    const html = renderToStaticMarkup(createElement(DockerVolumeDetailsDialog, {
      state: { volume, details: volumeDetails, loading: false, error: null },
      locale: "en",
      onClose: vi.fn()
    }));

    expect(html).toContain("media-data");
    expect(html).toContain("4.0 KB");
    expect(html).toContain("References");
    expect(html).toContain("availability");
    expect(html).toContain("active");
  });
});
