import { describe, expect, it } from "vitest";
import { dockerCreateInput, initialDockerCreateForm, parseDockerArguments, validateDockerCreateStep } from "./docker-create-form.js";

describe("docker create form", () => {
  it("maps a container form to the structured create contract", () => {
    const form = initialDockerCreateForm("container");
    form.name = "media";
    form.image = "nginx";
    form.environment = [{ key: "PORT", value: "8080" }];
    form.mounts = [{ type: "volume", source: "media-data", rootId: "", target: "/data", readOnly: true, noCopy: false, sizeBytes: "", mode: "" }];
    form.ports = [{ containerPort: "80", protocol: "tcp", hostIp: "127.0.0.1", hostPort: "8080" }];
    expect(dockerCreateInput(form)).toMatchObject({
      targetType: "container",
      name: "media",
      image: "nginx",
      environment: { PORT: "8080" },
      mounts: [{ type: "volume", source: "media-data", target: "/data", readOnly: true, noCopy: false }],
      ports: [{ containerPort: 80, protocol: "tcp", hostIp: "127.0.0.1", hostPort: 8080 }]
    });
    form.mounts = [{ type: "tmpfs", source: "", rootId: "", target: "/tmp", readOnly: false, noCopy: false, sizeBytes: "", mode: "1777" }];
    expect(dockerCreateInput(form)).toMatchObject({ mounts: [{ type: "tmpfs", mode: 0o1777 }] });
  });

  it("maps named volumes and network driver settings", () => {
    const volume = initialDockerCreateForm("volume");
    volume.name = "media-data";
    volume.labels = [{ key: "purpose", value: "media" }];
    expect(dockerCreateInput(volume)).toEqual({ targetType: "volume", name: "media-data", labels: { purpose: "media" } });

    const network = initialDockerCreateForm("network");
    network.name = "lan";
    network.driver = "macvlan";
    network.parent = "eth0";
    network.labels = [{ key: "zone", value: "lan" }];
    expect(dockerCreateInput(network)).toMatchObject({ targetType: "network", name: "lan", driver: "macvlan", parent: "eth0", mode: "bridge", labels: { zone: "lan" } });
  });

  it("omits values hidden by network and restart policy changes", () => {
    const form = initialDockerCreateForm("container");
    form.name = "media";
    form.image = "nginx";
    form.networkMode = "bridge";
    form.networkName = "old-network";
    form.networkAliases = "old-alias";
    form.ipv4Address = "172.20.0.10";
    form.restartPolicy = "always";
    form.restartMaxRetries = "5";

    expect(dockerCreateInput(form)).toMatchObject({
      network: { mode: "bridge" },
      restartPolicy: "always"
    });
    expect(dockerCreateInput(form)).not.toHaveProperty("network.networkName");
    expect(dockerCreateInput(form)).not.toHaveProperty("network.aliases");
    expect(dockerCreateInput(form)).not.toHaveProperty("network.ipv4Address");
    expect(dockerCreateInput(form)).not.toHaveProperty("restartMaxRetries");
  });

  it("omits blank IPAM rows", () => {
    const form = initialDockerCreateForm("network");
    form.name = "services";
    form.ipam = [{ subnet: "  ", ipRange: "", gateway: "", auxAddresses: "" }];

    expect(dockerCreateInput(form)).not.toHaveProperty("ipam");
  });

  it("preserves quoted and escaped command arguments", () => {
    expect(parseDockerArguments(`/bin/sh -c 'echo hello world' "two words" escaped\\ value`)).toEqual([
      "/bin/sh",
      "-c",
      "echo hello world",
      "two words",
      "escaped value"
    ]);
    expect(() => parseDockerArguments("echo 'unfinished")).toThrow("quotes must be closed");
  });

  it("blocks unsafe combinations before submit", () => {
    const form = initialDockerCreateForm("container");
    form.name = "media";
    form.image = "nginx";
    form.networkMode = "host";
    form.publishAllPorts = true;
    expect(validateDockerCreateStep(5, form)).toContain("cannot publish ports");
    form.networkMode = "bridge";
    form.privileged = true;
    expect(validateDockerCreateStep(6, form)).toContain("Acknowledge");
    form.privileged = false;
    form.environment = [{ key: "PORT", value: "1" }, { key: "PORT", value: "2" }];
    expect(validateDockerCreateStep(2, form)).toContain("unique");
  });

  it("validates required mount, port, and network fields before final submit", () => {
    const form = initialDockerCreateForm("container");
    form.name = "media";
    form.image = "nginx";
    form.mounts = [{ type: "tmpfs", source: "", rootId: "", target: "/tmp", readOnly: false, noCopy: false, sizeBytes: "512", mode: "1888" }];
    expect(validateDockerCreateStep(4, form)).toContain("tmpfs");
    form.mounts = [];
    form.networkMode = "custom";
    expect(validateDockerCreateStep(5, form)).toContain("Select");
    form.networkName = "services";
    form.ports = [{ containerPort: "80", protocol: "tcp", hostIp: "127.0.0.1", hostPort: "" }];
    expect(validateDockerCreateStep(5, form)).toContain("Host IP");
  });
});
