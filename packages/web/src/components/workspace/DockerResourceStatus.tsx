import type { DockerResourceCapabilities } from "@zos/shared";
import { getDockerResourceCapability } from "@zos/shared/docker-resources";
import { useTranslation } from "react-i18next";

const capabilityLabels = [
  ["cpuQuota", "cpuLimit"], ["cpuShares", "cpuShares"], ["cpuset", "cpuset"],
  ["memoryLimit", "memoryLimit"], ["swapLimit", "memorySwap"], ["pidsLimit", "pidsLimit"]
] as const;

export function DockerResourceStatus({ capabilities }: { capabilities: DockerResourceCapabilities | undefined }) {
  const { t } = useTranslation();
  return <div className="docker-resource-status">
    <h5>{t("workspace.management.docker.create.capabilities.title")}</h5>
    <dl>
      {capabilityLabels.map(([key, label]) => {
        const value = getDockerResourceCapability(key, capabilities);
        const state = value === true ? "supported" : value === false ? "unsupported" : "unknown";
        return <div key={key} data-state={state}>
          <dt>{t(`workspace.management.docker.create.resources.${label}`)}</dt>
          <dd>{t(`workspace.management.docker.create.capabilities.${state}`)}</dd>
        </div>;
      })}
    </dl>
  </div>;
}
