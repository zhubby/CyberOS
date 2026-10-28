import { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, HardDrive, LoaderCircle, ServerCog, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  DockerHostAccessCapability,
  DockerHostAccessCapabilityId,
  DockerHostAccessCoverageId,
  DockerHostAccessCoverageItem,
  DockerHostAccessCoverageReport,
  DockerHostAccessGrant
} from "@cyberos/shared";
import { getDockerHostAccessCatalog, type DockerHostAccessCatalog } from "../../api.js";

interface HostAccessPickerProps {
  grants: DockerHostAccessGrant[];
  onChange: (grants: DockerHostAccessGrant[]) => void;
  onBlockingChange?: (blocked: boolean) => void;
  coverage?: DockerHostAccessCoverageReport;
  disabled?: boolean;
}

const GROUPS: Array<{
  id: "system" | "storage" | "metadata";
  icon: typeof ShieldCheck;
  capabilities: DockerHostAccessCapabilityId[];
}> = [
  { id: "system", icon: ShieldCheck, capabilities: ["host_os_identity", "host_processes", "host_sys", "account_map"] },
  { id: "storage", icon: HardDrive, capabilities: ["nas_capacity"] },
  { id: "metadata", icon: ServerCog, capabilities: ["docker_metadata", "systemd_status"] }
];

const PERMANENTLY_UNSUPPORTED: DockerHostAccessCoverageId[] = [
  "journald",
  "smart_nvme",
  "rootfs_capacity",
  "low_level_kernel"
];

export function HostAccessPicker({
  grants,
  onChange,
  onBlockingChange,
  coverage,
  disabled = false
}: HostAccessPickerProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [catalog, setCatalog] = useState<DockerHostAccessCatalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [degradedAcknowledged, setDegradedAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void getDockerHostAccessCatalog()
      .then((nextCatalog) => {
        if (!active) return;
        setCatalog(nextCatalog);
        setLoadError(false);
      })
      .catch(() => {
        if (!active) return;
        setLoadError(true);
      });
    return () => { active = false; };
  }, []);

  const selectedCapabilities = useMemo(() => new Set(grants.map((grant) => grant.capability)), [grants]);
  const degradedSelected = useMemo(() => hasDegradedGrant(grants, catalog), [catalog, grants]);
  const coverageItems = useMemo(
    () => coverage?.items ?? pickerCoverage(grants, catalog),
    [catalog, coverage, grants]
  );
  const blocked = hostAccessPickerBlocked({ grants, catalog, loadError, degradedAcknowledged });

  useEffect(() => {
    onBlockingChange?.(blocked);
  }, [blocked, onBlockingChange]);

  function replaceGrant(next: DockerHostAccessGrant) {
    const nextKey = grantIdentity(next);
    onChange([...grants.filter((grant) => grantIdentity(grant) !== nextKey), next].sort(compareGrants));
    setDegradedAcknowledged(false);
  }

  function toggleCapability(capability: DockerHostAccessCapability, checked: boolean) {
    if (!checked) {
      onChange(grants.filter((grant) => grant.capability !== capability.id));
    } else if (capability.id !== "nas_capacity") {
      replaceGrant({ capability: capability.id });
    }
    setDegradedAcknowledged(false);
  }

  function toggleNasRoot(rootId: string, checked: boolean) {
    const nextGrant: DockerHostAccessGrant = { capability: "nas_capacity", rootId };
    onChange(checked
      ? [...grants, nextGrant].sort(compareGrants)
      : grants.filter((grant) => grant.capability !== "nas_capacity" || grant.rootId !== rootId));
    setDegradedAcknowledged(false);
  }

  async function copyCoverage() {
    if (!catalog) return;
    const lines = [
      `${t("workspace.management.docker.hostAccess.reportPolicy")}: ${catalog.policyVersion}`,
      ...grants.map((grant) => {
        const root = grant.capability === "nas_capacity" ? ` (${grant.rootId})` : "";
        return `${t("workspace.management.docker.hostAccess.states.requested")}: ${t(`workspace.management.docker.hostAccess.capabilities.${grant.capability}`)}${root}`;
      }),
      ...coverageItems.map((item) => {
        const reasons = item.reasonCodes.map((reason) => t(`workspace.management.docker.hostAccess.reasons.${reason}`));
        return `${t(`workspace.management.docker.hostAccess.states.${item.state}`)}: ${t(`workspace.management.docker.hostAccess.coverage.${item.coverage}`)}${reasons.length ? ` (${reasons.join("; ")})` : ""}`;
      })
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <section className="host-access-picker" aria-labelledby={`${fieldId}-title`}>
      <div className="host-access-picker-heading">
        <div>
          <h3 id={`${fieldId}-title`}>{t("workspace.management.docker.hostAccess.title")}</h3>
          <p>{t("workspace.management.docker.hostAccess.description")}</p>
        </div>
        <button
          type="button"
          className="management-icon-action"
          onClick={() => void copyCoverage()}
          disabled={disabled || !catalog}
          aria-label={t("workspace.management.docker.hostAccess.copyReport")}
          title={t("workspace.management.docker.hostAccess.copyReport")}
        >
          {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
        </button>
      </div>

      {!catalog && !loadError ? (
        <p className="host-access-picker-status" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" size={15} />{t("workspace.management.docker.hostAccess.loading")}</p>
      ) : null}
      {loadError ? (
        <p className="host-access-picker-error" role="alert"><AlertTriangle aria-hidden="true" size={15} />{t("workspace.management.docker.hostAccess.loadError")}</p>
      ) : null}

      {catalog ? GROUPS.map((group) => {
        const Icon = group.icon;
        return (
          <fieldset key={group.id} disabled={disabled}>
            <legend><Icon aria-hidden="true" size={15} />{t(`workspace.management.docker.hostAccess.groups.${group.id}`)}</legend>
            <div className="host-access-capability-list">
              {group.capabilities.map((capabilityId) => {
                const capability = catalog.capabilities.find((entry) => entry.id === capabilityId);
                if (!capability) return null;
                return capability.id === "nas_capacity"
                  ? catalog.nasRoots.map((root) => {
                      const grant = grants.find((entry) => entry.capability === "nas_capacity" && entry.rootId === root.rootId);
                      const unavailable = capability.availability.status === "unavailable" || root.availability.status === "unavailable";
                      return (
                        <CapabilityRow
                          key={`${capability.id}:${root.rootId}`}
                          id={`${fieldId}-${capability.id}-${root.rootId}`}
                          capability={capability}
                          label={`${t(`workspace.management.docker.hostAccess.capabilities.${capability.id}`)} · ${root.name}`}
                          checked={Boolean(grant)}
                          unavailable={unavailable}
                          reasons={[...capability.availability.reasonCodes, ...root.availability.reasonCodes]}
                          target={grant?.target ?? `/host/nas/${root.rootId}`}
                          defaultTarget={`/host/nas/${root.rootId}`}
                          onToggle={(checked) => toggleNasRoot(root.rootId, checked)}
                          onTarget={(target) => replaceGrant({ capability: "nas_capacity", rootId: root.rootId, ...(target ? { target } : {}) })}
                        />
                      );
                    })
                  : (
                      <CapabilityRow
                        key={capability.id}
                        id={`${fieldId}-${capability.id}`}
                        capability={capability}
                        label={String(t(`workspace.management.docker.hostAccess.capabilities.${capability.id}`))}
                        checked={selectedCapabilities.has(capability.id)}
                        unavailable={capability.availability.status === "unavailable"}
                        reasons={capability.availability.reasonCodes}
                        target={grants.find((grant) => grant.capability === capability.id)?.target ?? capability.defaultTarget}
                        defaultTarget={capability.defaultTarget}
                        onToggle={(checked) => toggleCapability(capability, checked)}
                        onTarget={(target) => replaceGrant({ capability: capability.id, ...(target ? { target } : {}) } as DockerHostAccessGrant)}
                      />
                    );
              })}
            </div>
          </fieldset>
        );
      }) : null}

      {degradedSelected ? (
        <label className="host-access-degraded-confirmation">
          <input type="checkbox" checked={degradedAcknowledged} onChange={(event) => setDegradedAcknowledged(event.target.checked)} disabled={disabled} />
          <span>{t("workspace.management.docker.hostAccess.confirmDegraded")}</span>
        </label>
      ) : null}

      <div className="host-access-coverage" aria-label={t("workspace.management.docker.hostAccess.coverageTitle")}>
        {coverageItems.map((item) => (
          <span key={item.coverage} data-state={item.state}>{t(`workspace.management.docker.hostAccess.coverage.${item.coverage}`)}</span>
        ))}
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied ? t("workspace.management.docker.hostAccess.copied") : ""}
      </span>
    </section>
  );
}

function CapabilityRow({
  id,
  capability,
  label,
  checked,
  unavailable,
  reasons,
  target,
  defaultTarget,
  onToggle,
  onTarget
}: {
  id: string;
  capability: DockerHostAccessCapability;
  label: string;
  checked: boolean;
  unavailable: boolean;
  reasons: string[];
  target: string | null;
  defaultTarget: string | null;
  onToggle: (checked: boolean) => void;
  onTarget: (target: string) => void;
}) {
  const { t } = useTranslation();
  const translate = t as (key: string, options?: Record<string, unknown>) => unknown;
  const reasonId = `${id}-reason`;
  return (
    <div className="host-access-capability" data-availability={capability.availability.status}>
      <label htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} onChange={(event) => onToggle(event.target.checked)} disabled={unavailable && !checked} aria-describedby={reasonId} />
        <span><strong>{label}</strong><small>{t(`workspace.management.docker.hostAccess.risk.${capability.risk}`)}</small></span>
      </label>
      <p id={reasonId}>
        {unavailable
          ? reasons.map((reason) => String(translate(`workspace.management.docker.hostAccess.reasons.${reason}`))).join("; ")
          : capability.provides.map((item) => String(translate(`workspace.management.docker.hostAccess.provides.${item}`, { defaultValue: item }))).join(" · ")}
      </p>
      {checked && defaultTarget ? (
        <label className="host-access-target">
          <span>{t("workspace.management.docker.hostAccess.target")}</span>
          <input
            value={target ?? defaultTarget}
            onChange={(event) => onTarget(event.target.value)}
            spellCheck={false}
            aria-invalid={!validContainerTarget(target ?? defaultTarget) || undefined}
          />
          {!validContainerTarget(target ?? defaultTarget) ? (
            <small role="alert">{t("workspace.management.docker.hostAccess.invalidTarget")}</small>
          ) : null}
        </label>
      ) : null}
    </div>
  );
}

function pickerCoverage(
  grants: DockerHostAccessGrant[],
  catalog: DockerHostAccessCatalog | null
): DockerHostAccessCoverageItem[] {
  const selected = new Set(grants.map((grant) => grant.capability));
  const coverage = new Map<DockerHostAccessCoverageId, DockerHostAccessCapability[]>();
  for (const capability of catalog?.capabilities ?? []) {
    if (!selected.has(capability.id)) continue;
    for (const item of capability.coverage) {
      coverage.set(item, [...(coverage.get(item) ?? []), capability]);
    }
  }
  const items: DockerHostAccessCoverageItem[] = [...coverage.entries()].map(([item, capabilities]) => {
    const rootAvailability = grants
      .filter((grant) => grant.capability === "nas_capacity")
      .map((grant) => catalog?.nasRoots.find((root) => root.rootId === grant.rootId)?.availability)
      .filter((availability) => availability !== undefined);
    const availability = [
      ...capabilities.map((capability) => capability.availability),
      ...(item === "nas_capacity" ? rootAvailability : [])
    ];
    const unavailable = availability.find((entry) => entry.status === "unavailable");
    const degraded = availability.find((entry) => entry.status === "degraded");
    return {
      coverage: item,
      state: unavailable ? "unavailable" : degraded ? "degraded" : "requested",
      capabilities: capabilities.map((capability) => capability.id).sort(),
      reasonCodes: unavailable?.reasonCodes ?? degraded?.reasonCodes ?? []
    };
  });
  for (const item of PERMANENTLY_UNSUPPORTED) {
    items.push({ coverage: item, state: "unsupported", capabilities: [], reasonCodes: [] });
  }
  return items.sort((left, right) => left.coverage.localeCompare(right.coverage));
}

function grantIdentity(grant: DockerHostAccessGrant): string {
  return grant.capability === "nas_capacity" ? `${grant.capability}:${grant.rootId}` : grant.capability;
}

function compareGrants(left: DockerHostAccessGrant, right: DockerHostAccessGrant): number {
  return grantIdentity(left).localeCompare(grantIdentity(right));
}

export function hostAccessPickerBlocked({
  grants,
  catalog,
  loadError,
  degradedAcknowledged
}: {
  grants: DockerHostAccessGrant[];
  catalog: DockerHostAccessCatalog | null;
  loadError: boolean;
  degradedAcknowledged: boolean;
}): boolean {
  if (!grants.length) return false;
  if (!catalog || loadError) return true;
  for (const grant of grants) {
    if (grant.target !== undefined && !validContainerTarget(grant.target)) return true;
    const capability = catalog.capabilities.find((entry) => entry.id === grant.capability);
    if (!capability || capability.availability.status === "unavailable") return true;
    if (grant.capability === "nas_capacity") {
      const root = catalog.nasRoots.find((entry) => entry.rootId === grant.rootId);
      if (!root || root.availability.status === "unavailable") return true;
    }
  }
  return hasDegradedGrant(grants, catalog) && !degradedAcknowledged;
}

function hasDegradedGrant(grants: DockerHostAccessGrant[], catalog: DockerHostAccessCatalog | null): boolean {
  if (!catalog) return false;
  return grants.some((grant) => {
    const capability = catalog.capabilities.find((entry) => entry.id === grant.capability);
    if (capability?.availability.status === "degraded") return true;
    return grant.capability === "nas_capacity" &&
      catalog.nasRoots.find((root) => root.rootId === grant.rootId)?.availability.status === "degraded";
  });
}

export function validContainerTarget(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\0") || value === "/" || value.endsWith("/")) return false;
  return value.split("/").slice(1).every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}
