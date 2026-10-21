import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { initialDockerCreateForm } from "../../lib/docker-create-form.js";
import { ContainerResources } from "./DockerCreateDialogs.js";
import { DockerResourceStatus } from "./DockerResourceStatus.js";

beforeAll(async () => { await initI18n(); await i18n.changeLanguage("en"); });

describe("Docker host resource controls", () => {
  it("renders available, unsupported, and unknown capabilities", () => {
    const html = renderToStaticMarkup(createElement(DockerResourceStatus, {
      capabilities: { memoryLimit: false, swapLimit: true, cpuQuota: true, cpuShares: null, cpuset: true, pidsLimit: true }
    }));
    expect(html.match(/data-state="supported"/gu)).toHaveLength(3);
    expect(html.match(/data-state="unsupported"/gu)).toHaveLength(2);
    expect(html.match(/data-state="unknown"/gu)).toHaveLength(1);
    expect(html).toContain("Not supported");
    expect(html).toContain("Unknown");
  });

  it("disables unavailable limits without silently discarding retained inputs", () => {
    const form = initialDockerCreateForm("container");
    form.memoryLimitBytes = "8388608";
    const html = renderToStaticMarkup(createElement(ContainerResources, {
      form, update: () => {},
      capabilities: { memoryLimit: false, swapLimit: true, cpuQuota: true, cpuShares: true, cpuset: true, pidsLimit: null }
    }));
    expect(html.match(/disabled=""/gu)).toHaveLength(4);
    expect(html).toContain('value="8388608"');
    expect(html).toContain("Clear unavailable limits");
    const unknown = renderToStaticMarkup(createElement(ContainerResources, { form: initialDockerCreateForm("container"), update: () => {}, capabilities: undefined }));
    expect(unknown.match(/disabled=""/gu)).toHaveLength(7);
    expect(unknown).not.toContain("Clear unavailable limits");
  });
});
