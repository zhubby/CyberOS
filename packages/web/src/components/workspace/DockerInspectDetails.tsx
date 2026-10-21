import type { ReactNode } from "react";
import { CircleAlert, HardDrive, LoaderCircle, Network, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  DockerNetworkDetails,
  DockerSummary,
  DockerVolumeDetails
} from "../../api.js";
import { formatBytes, formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { useModalDialog } from "./useModalDialog.js";

type DockerNetwork = DockerSummary["networks"][number];
type DockerVolume = DockerSummary["volumes"][number];

export interface DockerNetworkDetailsState {
  network: DockerNetwork;
  details: DockerNetworkDetails | null;
  loading: boolean;
  error: string | null;
}

export interface DockerVolumeDetailsState {
  volume: DockerVolume;
  details: DockerVolumeDetails | null;
  loading: boolean;
  error: string | null;
}

export function DockerNetworkDetailsDialog({
  state,
  locale,
  onClose
}: {
  state: DockerNetworkDetailsState;
  locale: SupportedLocale;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const network = state.details ?? state.network;
  return (
    <DockerInspectDialog
      title={network.name}
      subtitle={`${network.driver} · ${network.scope}`}
      eyebrow={String(t("workspace.management.docker.inspect.networkEyebrow"))}
      titleId="docker-network-detail-title"
      Icon={Network}
      loading={state.loading}
      error={state.error}
      onClose={onClose}
    >
      <InspectSection title={String(t("workspace.management.docker.inspect.overview"))}>
        <InspectList entries={[
          [String(t("workspace.management.docker.inspect.name")), network.name],
          [String(t("workspace.management.docker.inspect.id")), network.id, true],
          [String(t("workspace.management.docker.inspect.created")), formatDate(state.details?.createdAt ?? null, locale, String(t("common.dash")))],
          [String(t("workspace.management.docker.inspect.driver")), network.driver],
          [String(t("workspace.management.docker.inspect.scope")), network.scope],
          [String(t("workspace.management.docker.inspect.enableIpv4")), String(t(booleanTranslationKey(state.details?.enableIPv4)))],
          [String(t("workspace.management.docker.inspect.enableIpv6")), String(t(booleanTranslationKey(state.details?.enableIPv6)))],
          [String(t("workspace.management.docker.inspect.internal")), String(t(booleanTranslationKey(state.details?.internal)))],
          [String(t("workspace.management.docker.inspect.attachable")), String(t(booleanTranslationKey(state.details?.attachable)))],
          [String(t("workspace.management.docker.inspect.ingress")), String(t(booleanTranslationKey(state.details?.ingress)))]
        ]} />
      </InspectSection>

      {state.details ? (
        <>
          <InspectSection title={String(t("workspace.management.docker.inspect.addressing"))}>
            <InspectList entries={[
              [String(t("workspace.management.docker.inspect.ipamDriver")), state.details.ipam.driver ?? String(t("common.dash"))]
            ]} />
            {state.details.ipam.configs.length ? (
              <div className="docker-inspect-ipam-list">
                {state.details.ipam.configs.map((config, index) => (
                  <div key={`${config.subnet ?? "ipam"}-${index}`}>
                    <InspectList entries={[
                      [String(t("workspace.management.docker.inspect.subnet")), config.subnet ?? String(t("common.dash")), true],
                      [String(t("workspace.management.docker.inspect.ipRange")), config.ipRange ?? String(t("common.dash")), true],
                      [String(t("workspace.management.docker.inspect.gateway")), config.gateway ?? String(t("common.dash")), true],
                      [String(t("workspace.management.docker.inspect.auxiliaryAddresses")), recordSummary(config.auxiliaryAddresses, String(t("common.dash"))), true]
                    ]} />
                  </div>
                ))}
              </div>
            ) : <p className="docker-inspect-empty">{t("workspace.management.docker.inspect.noIpam")}</p>}
          </InspectSection>

          <InspectSection title={String(t("workspace.management.docker.inspect.connectedContainers"))}>
            {state.details.containers.length ? (
              <div className="docker-inspect-container-list">
                {state.details.containers.map((container) => (
                  <article key={container.id}>
                    <strong>{container.name}</strong>
                    <code title={container.id}>{container.id}</code>
                    <dl>
                      <div><dt>{t("workspace.management.docker.inspect.endpointId")}</dt><dd>{container.endpointId ?? t("common.dash")}</dd></div>
                      <div><dt>{t("workspace.management.docker.inspect.macAddress")}</dt><dd>{container.macAddress ?? t("common.dash")}</dd></div>
                      <div><dt>{t("workspace.management.docker.inspect.ipv4Address")}</dt><dd>{container.ipv4Address ?? t("common.dash")}</dd></div>
                      <div><dt>{t("workspace.management.docker.inspect.ipv6Address")}</dt><dd>{container.ipv6Address ?? t("common.dash")}</dd></div>
                    </dl>
                  </article>
                ))}
              </div>
            ) : <p className="docker-inspect-empty">{t("workspace.management.docker.inspect.noContainers")}</p>}
          </InspectSection>

          <div className="docker-container-detail-grid">
            <RecordSection title={String(t("workspace.management.docker.inspect.options"))} value={state.details.options} />
            <RecordSection title={String(t("workspace.management.docker.inspect.labels"))} value={state.details.labels} />
          </div>
        </>
      ) : null}
    </DockerInspectDialog>
  );
}

export function DockerVolumeDetailsDialog({
  state,
  locale,
  onClose
}: {
  state: DockerVolumeDetailsState;
  locale: SupportedLocale;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const volume = state.details ?? state.volume;
  return (
    <DockerInspectDialog
      title={volume.name}
      subtitle={`${volume.driver} · ${volume.scope}`}
      eyebrow={String(t("workspace.management.docker.inspect.volumeEyebrow"))}
      titleId="docker-volume-detail-title"
      Icon={HardDrive}
      loading={state.loading}
      error={state.error}
      onClose={onClose}
    >
      <InspectSection title={String(t("workspace.management.docker.inspect.overview"))}>
        <InspectList entries={[
          [String(t("workspace.management.docker.inspect.name")), volume.name],
          [String(t("workspace.management.docker.inspect.created")), formatDate(state.details?.createdAt ?? null, locale, String(t("common.dash")))],
          [String(t("workspace.management.docker.inspect.driver")), volume.driver],
          [String(t("workspace.management.docker.inspect.scope")), volume.scope],
          [String(t("workspace.management.docker.inspect.mountpoint")), volume.mountpoint || String(t("common.dash")), true]
        ]} />
      </InspectSection>

      {state.details ? (
        <>
          <InspectSection title={String(t("workspace.management.docker.inspect.usage"))}>
            <div className="docker-container-detail-stat-grid docker-volume-usage-grid">
              <div className="docker-container-detail-stat">
                <span>{t("workspace.management.docker.inspect.size")}</span>
                <strong>{state.details.sizeBytes === null ? t("workspace.management.docker.inspect.unknown") : formatBytes(state.details.sizeBytes, locale)}</strong>
              </div>
              <div className="docker-container-detail-stat">
                <span>{t("workspace.management.docker.inspect.references")}</span>
                <strong>{state.details.referenceCount === null ? t("workspace.management.docker.inspect.unknown") : formatLocaleNumber(state.details.referenceCount, locale)}</strong>
              </div>
            </div>
          </InspectSection>
          <div className="docker-inspect-record-grid">
            <RecordSection title={String(t("workspace.management.docker.inspect.labels"))} value={state.details.labels} />
            <RecordSection title={String(t("workspace.management.docker.inspect.options"))} value={state.details.options} />
            <RecordSection title={String(t("workspace.management.docker.inspect.status"))} value={state.details.status} />
          </div>
        </>
      ) : null}
    </DockerInspectDialog>
  );
}

function DockerInspectDialog({
  title,
  subtitle,
  eyebrow,
  titleId,
  Icon,
  loading,
  error,
  onClose,
  children
}: {
  title: string;
  subtitle: string;
  eyebrow: string;
  titleId: string;
  Icon: typeof Network;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const dialogRef = useModalDialog(onClose);
  return (
    <div className="management-modal-backdrop docker-resource-detail-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} tabIndex={-1} className="management-modal docker-container-detail-modal docker-inspect-detail-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="docker-container-detail-header">
          <div className="docker-container-detail-heading">
            <div className="docker-container-detail-icon" aria-hidden="true"><Icon size={18} /></div>
            <div>
              <span className="eyebrow">{eyebrow}</span>
              <h2 id={titleId}>{title}</h2>
              <p>{subtitle}</p>
            </div>
          </div>
          <button type="button" className="management-icon-action" onClick={onClose} title={String(t("common.actions.close"))} aria-label={String(t("common.actions.close"))}>
            <X aria-hidden="true" size={15} />
          </button>
        </header>
        <div className="docker-container-detail-body">
          {error ? <p className="docker-container-detail-error"><CircleAlert aria-hidden="true" size={15} />{error}</p> : null}
          {loading ? <p className="docker-inspect-loading" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" size={16} />{t("workspace.management.docker.inspect.loading")}</p> : null}
          {children}
        </div>
      </section>
    </div>
  );
}

function InspectSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="docker-container-detail-section">
      <div className="docker-container-detail-section-heading"><h3>{title}</h3></div>
      {children}
    </section>
  );
}

function RecordSection({ title, value }: { title: string; value: Record<string, string> }) {
  const { t } = useTranslation();
  return (
    <InspectSection title={title}>
      {Object.keys(value).length ? (
        <dl className="docker-inspect-record-list">
          {Object.entries(value).map(([key, entry]) => <div key={key}><dt>{key}</dt><dd>{entry}</dd></div>)}
        </dl>
      ) : <p className="docker-inspect-empty">{t("workspace.management.docker.inspect.noEntries")}</p>}
    </InspectSection>
  );
}

type InspectEntry = [label: string, value: string, mono?: boolean];

function InspectList({ entries }: { entries: InspectEntry[] }) {
  return (
    <dl className="docker-container-detail-list">
      {entries.map(([label, value, mono]) => (
        <div key={label}><dt>{label}</dt><dd className={mono ? "is-mono" : undefined} title={value}>{value}</dd></div>
      ))}
    </dl>
  );
}

function booleanTranslationKey(value: boolean | null | undefined):
  | "workspace.management.docker.inspect.yes"
  | "workspace.management.docker.inspect.no"
  | "workspace.management.docker.inspect.unknown" {
  if (value === true) return "workspace.management.docker.inspect.yes";
  if (value === false) return "workspace.management.docker.inspect.no";
  return "workspace.management.docker.inspect.unknown";
}

function formatDate(value: string | null, locale: SupportedLocale, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function recordSummary(value: Record<string, string>, fallback: string): string {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([key, entry]) => `${key}=${entry}`).join(", ") : fallback;
}
