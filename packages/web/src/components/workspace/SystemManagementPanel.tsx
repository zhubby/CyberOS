import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Database,
  Download,
  HardDrive,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  Route,
  Trash2,
  Upload,
  X,
  type LucideIcon
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getSystemNetwork,
  getSystemNetworkTraffic,
  getSystemStorage,
  deleteStoragePool,
  createStoragePool,
  type NetworkSummary,
  type NetworkTrafficSummary,
  type EthernetStatus,
  type WifiStatus,
  type StorageFilesystem,
  type StorageSummary,
  type StorageRaidLevel
} from "../../api.js";
import {
  isStorageDiskSelectable,
  raidMinimum,
  STORAGE_FILESYSTEMS,
  STORAGE_RAID_LEVELS,
  storageDiskAvailability,
  validateStoragePoolForm,
  type StoragePoolFormState,
  type StoragePoolValidationIssue
} from "../../config/storage-pool.js";
import { formatBytes, formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { calculateNetworkTrafficRate } from "../../lib/network-traffic.js";
import {
  ManagementDashboardControls,
  ManagementDashboardGrid,
  useManagementDashboard
} from "./ManagementDashboard.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";
import { SystemEthernetManagement } from "./SystemEthernetManagement.js";
import { SystemWifiReadonly } from "./SystemWifiReadonly.js";
import { IscsiManagementCard } from "./IscsiManagementCard.js";
import { ISCSI_REFRESH_EVENT } from "../../config/iscsi.js";

type StatusTone = "ready" | "warning" | "offline" | "neutral";
type GaugeTone = "ready" | "warning" | "danger" | "neutral";
type NetworkInterface = NetworkSummary["interfaces"][number];
type NetworkRoute = NetworkSummary["routes"][number];
type StorageDisk = StorageSummary["disks"][number];
type StoragePool = StorageSummary["pools"][number];
type Translate = (key: string, options?: Record<string, unknown>) => string;

interface Metric {
  id: string;
  label: string;
  value: string;
  detail: string;
  state: StatusTone;
  Icon: LucideIcon;
}

interface NetworkTrafficPoint {
  timestamp: number;
  rxBytesPerSecond: number;
  txBytesPerSecond: number;
}

const NETWORK_TRAFFIC_INTERVAL_MS = 2_000;
const NETWORK_TRAFFIC_HISTORY_LIMIT = 31;

function StatusIcon({ tone, label }: { tone: StatusTone; label: string }) {
  const Icon = tone === "ready"
    ? CircleCheck
    : tone === "warning"
      ? CircleAlert
      : tone === "offline"
        ? CircleX
        : CircleHelp;

  return (
    <span className="management-row-status-icon" data-state={tone} title={label} aria-label={label}>
      <Icon aria-hidden="true" size={17} strokeWidth={2.2} />
    </span>
  );
}

interface DiskCapacityUsage {
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  ratio: number | null;
  pool: StoragePool | null;
  mountTargets: string[];
}

export function SystemNetworkManagementPanel({
  locale,
  onOpenWirelessSettings,
  onNotifyError,
  onNotifySuccess
}: {
  locale: SupportedLocale;
  onOpenWirelessSettings: () => void;
  onNotifyError: (message: string | null) => void;
  onNotifySuccess: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const dashboard = useManagementDashboard("network");
  const [summary, setSummary] = useState<NetworkSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedInterfaceId, setSelectedInterfaceId] = useState<string | null>(null);
  const reportedIssueSignature = useRef<string | null>(null);
  const handleEthernetStatus = useCallback((ethernet: EthernetStatus) => {
    setSummary((current) => current
      ? {
          ...current,
          capabilities: {
            ...current.capabilities,
            backend: ethernet.backend === "NetworkManager" ? "NetworkManager" : current.capabilities.backend,
            hostdReady: current.wifi.hostdReady || ethernet.hostdReady,
            canApplyConfiguration:
              (current.wifi.backend === "NetworkManager" && current.wifi.hostdReady)
              || (ethernet.backend === "NetworkManager" && ethernet.hostdReady),
            canManageEthernet:
              ethernet.backend === "NetworkManager" &&
              ethernet.hostdReady &&
              ethernet.devices.length > 0
          },
          ethernet
        }
      : current);
  }, []);
  const handleWifiStatus = useCallback((wifiStatus: WifiStatus) => {
    setSummary((current) => current
      ? {
          ...current,
          capabilities: {
            ...current.capabilities,
            backend: wifiStatus.backend === "NetworkManager" || current.ethernet.backend === "NetworkManager"
              ? "NetworkManager"
              : wifiStatus.backend,
            hostdReady: wifiStatus.hostdReady || current.ethernet.hostdReady,
            canApplyConfiguration:
              (wifiStatus.backend === "NetworkManager" && wifiStatus.hostdReady)
              || (current.ethernet.backend === "NetworkManager" && current.ethernet.hostdReady),
            canManageWifi:
              wifiStatus.backend === "NetworkManager" &&
              wifiStatus.hostdReady &&
              wifiStatus.devices.length > 0,
            canManageHotspot:
              wifiStatus.backend === "NetworkManager" &&
              wifiStatus.hostdReady &&
              wifiStatus.devices.some((device) => device.capabilities.accessPoint)
          },
          wifi: { ...wifiStatus, profiles: current.wifi.profiles }
        }
      : current);
  }, []);

  useEffect(() => {
    let active = true;
    void loadSummary();
    return () => {
      active = false;
    };

    async function loadSummary() {
      setLoading(true);
      setError(null);
      try {
        const nextSummary = await getSystemNetwork();
        if (active) {
          setSummary(nextSummary);
          notifySummaryIssues(
            nextSummary.issues,
            t("workspace.management.network.issuesWarning"),
            onNotifyError,
            reportedIssueSignature
          );
        }
      } catch (nextError) {
        if (active) {
          const message = errorMessage(nextError);
          setError(message);
          onNotifyError(t("workspace.management.network.loadError"));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
  }, []);

  async function refreshSummary() {
    setLoading(true);
    setError(null);
    try {
      const nextSummary = await getSystemNetwork();
      setSummary(nextSummary);
      notifySummaryIssues(
        nextSummary.issues,
        t("workspace.management.network.issuesWarning"),
        onNotifyError,
        reportedIssueSignature
      );
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      onNotifyError(t("workspace.management.network.loadError"));
    } finally {
      setLoading(false);
    }
  }

  const status = summary?.status ?? "unavailable";
  const interfaces = summary?.interfaces ?? [];
  const routes = summary?.routes ?? [];
  const selectedInterface = interfaces.find((networkInterface) => networkInterface.id === selectedInterfaceId) ?? null;

  return (
    <section className="workspace-management" aria-label={t("workspace.management.network.title")}>
      <PanelHeader
        icon={<Network aria-hidden="true" size={20} />}
        title={t("workspace.management.network.title")}
        subtitle={t("workspace.management.network.description")}
        actions={<PanelHeaderActions label={t("workspace.management.actions.label")}>
          <ManagementDashboardControls dashboard={dashboard} disabled={loading} />
          <PanelHeaderAction
            label={t("common.actions.refresh")}
            type="button"
            onClick={() => void refreshSummary()}
            disabled={loading}
            aria-busy={loading || undefined}
          >
            {loading ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={17} />}
          </PanelHeaderAction>
        </PanelHeaderActions>}
      />

      <div className="management-body">
        <ManagementDashboardGrid
          dashboard={dashboard}
          loading={loading}
          items={[
              {
                id: "overview",
                title: String(t("workspace.management.network.title")),
                content: (
                  <section className="management-command-panel">
                    <div className="management-emblem" aria-hidden="true"><Network size={31} /></div>
                    <div className="management-command-copy">
                      <div>
                        <span className="management-status-pill" data-state={systemStatusTone(status, loading, error)}>{systemStatusLabel(status, loading, error, translate)}</span>
                        <h3>{t("workspace.management.network.title")}</h3>
                        <p title={systemDiagnosticTitle(error, summary?.issues)}>{networkStatusDetail(summary, loading, error, translate)}</p>
                      </div>
                      <dl className="management-fact-list">
                        <Fact label={t("workspace.management.network.facts.backend")} value={summary?.capabilities.backend ?? t("common.dash")} />
                        <Fact label={translate("workspace.management.network.facts.mode")} value={summary?.capabilities.canManageWifi || summary?.capabilities.canManageEthernet ? translate("workspace.management.network.wifi.managedMode") : translate("workspace.management.values.readOnly")} />
                        <Fact label={t("workspace.management.network.facts.defaultRoutes")} value={formatLocaleNumber(summary?.metrics.defaultRoutes ?? 0, locale)} />
                        <Fact label={t("workspace.management.network.facts.interfaces")} value={formatLocaleNumber(summary?.metrics.interfaces ?? 0, locale)} />
                      </dl>
                    </div>
                  </section>
                )
              },
              ...networkMetrics(summary, locale, translate).map((metric) => ({
                id: `metric-${metric.id}`,
                title: metric.label,
                content: <MetricCard key={metric.id} metric={metric} />
              })),
              {
                id: "ethernet",
                title: String(t("workspace.management.network.ethernet.title")),
                content: summary ? (
                  <SystemEthernetManagement
                    ethernet={summary.ethernet}
                    canManageEthernet={summary.capabilities.canManageEthernet}
                    locale={locale}
                    onStatus={handleEthernetStatus}
                    onRefresh={refreshSummary}
                    onNotifySuccess={(message) => onNotifySuccess(message)}
                    onNotifyError={onNotifyError}
                  />
                ) : (
                  <section className="management-section">
                    <SectionHeader title={t("workspace.management.network.ethernet.title")} description={t("workspace.management.network.ethernet.description")} />
                    <p className="management-empty">{error ?? t("workspace.management.network.loadError")}</p>
                  </section>
                )
              },
              {
                id: "wifi",
                title: String(t("workspace.management.network.wifi.title")),
                content: summary ? (
                  <SystemWifiReadonly
                    wifi={summary.wifi}
                    onStatus={handleWifiStatus}
                    onOpenSettings={onOpenWirelessSettings}
                  />
                ) : (
                  <section className="management-section">
                    <SectionHeader
                      title={t("workspace.management.network.wifi.title")}
                      description={t("workspace.management.network.wifi.description")}
                    />
                    <p className="management-empty">{error ?? t("workspace.management.network.loadError")}</p>
                  </section>
                )
              },
              {
                id: "traffic",
                title: String(t("workspace.management.network.traffic.title")),
                content: <NetworkTrafficMonitor interfaces={interfaces} locale={locale} t={translate} />
              },
              {
                id: "interfaces",
                title: String(t("workspace.management.network.interfacesTitle")),
                content: (
                  <section className="management-section management-table-section">
                    <SectionHeader title={t("workspace.management.network.interfacesTitle")} description={t("workspace.management.network.interfacesDescription")} />
                    {interfaces.length ? (
                      <div className="management-table-wrap">
                        <table className="management-table management-table-network">
                          <thead><tr><th>{t("workspace.management.columns.name")}</th><th>{t("workspace.management.columns.status")}</th><th>{t("workspace.management.network.columns.kind")}</th><th>{t("workspace.management.network.columns.addresses")}</th><th>{t("workspace.management.network.columns.mac")}</th><th>{t("workspace.management.network.columns.speed")}</th><th>{t("workspace.management.network.columns.mtu")}</th><th>{t("workspace.management.network.columns.defaultRoute")}</th></tr></thead>
                          <tbody>{interfaces.map((networkInterface) => (
                            <tr key={networkInterface.id}>
                              <td title={networkInterface.name}><button type="button" className="network-interface-name-button" onClick={() => setSelectedInterfaceId(networkInterface.id)} aria-label={t("workspace.management.network.openInterfaceDetails", { name: networkInterface.name })}>{networkInterface.name}</button></td>
                              <td><StatusIcon tone={networkInterfaceTone(networkInterface)} label={networkInterfaceStateLabel(networkInterface, translate)} /></td>
                              <td>{translate(`workspace.management.network.kinds.${networkInterface.kind}`)}</td>
                              <td title={formatAddresses(networkInterface)}>{formatAddresses(networkInterface)}</td>
                              <td title={networkInterface.mac ?? t("common.dash")}>{networkInterface.mac ?? t("common.dash")}</td>
                              <td>{formatSpeed(networkInterface.speedMbps, locale, translate)}</td>
                              <td>{formatNullableNumber(networkInterface.mtu, locale, translate)}</td>
                              <td>{networkInterface.hasDefaultRoute ? translate("common.yes") : translate("common.no")}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    ) : <p className="management-empty management-table-empty-state">{t("workspace.management.network.noInterfaces")}</p>}
                  </section>
                )
              },
              {
                id: "routes",
                title: String(t("workspace.management.network.routesTitle")),
                content: (
                  <section className="management-section">
                    <SectionHeader title={t("workspace.management.network.routesTitle")} description={t("workspace.management.network.routesDescription")} />
                    <div className="management-workload-list">{routes.length ? routes.map((route, index) => <NetworkRouteRow key={`${route.destination}-${route.device}-${index}`} route={route} />) : <p className="management-empty">{t("workspace.management.network.noRoutes")}</p>}</div>
                  </section>
                )
              },
              {
                id: "readiness",
                title: String(t("workspace.management.network.readinessTitle")),
                content: (
                  <section className="management-section">
                    <SectionHeader title={t("workspace.management.network.readinessTitle")} description={t("workspace.management.network.readinessDescription")} />
                    <NetworkReadinessSummary metrics={summary?.metrics} locale={locale} />
                  </section>
                )
              }
          ]}
        />
      </div>

      {selectedInterface ? (
        <NetworkInterfaceDetailsModal
          networkInterface={selectedInterface}
          routes={routes.filter((route) => route.device === selectedInterface.name)}
          locale={locale}
          t={translate}
          onClose={() => setSelectedInterfaceId(null)}
        />
      ) : null}
    </section>
  );
}

export function SystemStorageManagementPanel({
  locale,
  onWorkQueuesChanged,
  onNotifyError,
  onNotifySuccess
}: {
  locale: SupportedLocale;
  onWorkQueuesChanged: () => void | Promise<void>;
  onNotifyError: (message: string | null) => void;
  onNotifySuccess: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const dashboard = useManagementDashboard("storage");
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedPool, setSelectedPool] = useState<StoragePool | null>(null);
  const [selectedDisk, setSelectedDisk] = useState<StorageDisk | null>(null);
  const [deleteStep, setDeleteStep] = useState<"idle" | "warning" | "confirm">("idle");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [form, setForm] = useState<StoragePoolFormState>({
    name: "",
    raidLevel: "1",
    filesystem: "ext4",
    devices: []
  });
  const reportedIssueSignature = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadSummary();
    return () => {
      active = false;
    };

    async function loadSummary() {
      setLoading(true);
      setError(null);
      try {
        const nextSummary = await getSystemStorage();
        if (active) {
          setSummary(nextSummary);
          notifySummaryIssues(
            nextSummary.issues,
            t("workspace.management.storage.issuesWarning"),
            onNotifyError,
            reportedIssueSignature
          );
        }
      } catch (nextError) {
        if (active) {
          const message = errorMessage(nextError);
          setError(message);
          onNotifyError(t("workspace.management.storage.loadError"));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
  }, []);

  async function refreshSummary() {
    setLoading(true);
    setError(null);
    try {
      const nextSummary = await getSystemStorage();
      setSummary(nextSummary);
      notifySummaryIssues(
        nextSummary.issues,
        t("workspace.management.storage.issuesWarning"),
        onNotifyError,
        reportedIssueSignature
      );
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      onNotifyError(t("workspace.management.storage.loadError"));
    } finally {
      setLoading(false);
    }
  }

  const validationIssues = validateStoragePoolForm(form, summary);
  const availableDisks = summary?.disks ?? [];
  const canCreatePool = Boolean(summary?.capabilities.canCreatePool);

  function openCreateModal() {
    setError(null);
    onNotifyError(null);
    onNotifySuccess(null);
    setConfirmed(false);
    setCreateOpen(true);
  }

  function closeCreateModal() {
    if (!submitting) {
      setCreateOpen(false);
    }
  }

  function openPoolDetails(pool: StoragePool) {
    setSelectedPool(pool);
    setDeleteStep("idle");
    setDeleteConfirmation("");
    onNotifyError(null);
    onNotifySuccess(null);
  }

  function closePoolDetails() {
    if (!deleting) {
      setSelectedPool(null);
      setDeleteStep("idle");
      setDeleteConfirmation("");
    }
  }

  function openDiskDetails(disk: StorageDisk) {
    setSelectedDisk(disk);
    onNotifyError(null);
    onNotifySuccess(null);
  }

  function closeDiskDetails() {
    setSelectedDisk(null);
  }

  function beginPoolDelete() {
    if (!selectedPool || !summary?.capabilities.canDeletePool) {
      return;
    }
    setDeleteStep("warning");
    setDeleteConfirmation("");
  }

  function continuePoolDelete() {
    if (selectedPool && deleteStep === "warning") {
      setDeleteStep("confirm");
    }
  }

  async function submitPoolDelete() {
    if (!selectedPool || deleteStep !== "confirm") {
      return;
    }
    const confirmationName = storagePoolConfirmationName(selectedPool);
    if (deleteConfirmation.trim() !== confirmationName) {
      onNotifyError(t("workspace.management.storage.deleteConfirmationMismatch", { name: confirmationName }));
      return;
    }

    setDeleting(true);
    onNotifyError(null);
    try {
      await deleteStoragePool({
        poolId: selectedPool.id,
        confirmation: confirmationName
      });
      onNotifySuccess(t("workspace.management.storage.poolDeleted"));
      setSelectedPool(null);
      setDeleteStep("idle");
      setDeleteConfirmation("");
      await refreshSummary();
      await onWorkQueuesChanged();
    } catch (nextError) {
      onNotifyError(errorMessage(nextError));
    } finally {
      setDeleting(false);
    }
  }

  function toggleDevice(device: string, checked: boolean) {
    setForm((current) => ({
      ...current,
      devices: checked ? [...new Set([...current.devices, device])] : current.devices.filter((path) => path !== device)
    }));
  }

  async function submitStorageProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onNotifyError(null);
    if (validationIssues.length > 0) {
      onNotifyError(storageValidationIssueText(validationIssues[0]!, t));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await createStoragePool({
        name: form.name.trim(),
        raidLevel: form.raidLevel,
        devices: form.devices,
        filesystem: form.filesystem,
        confirm: true
      });
      onNotifySuccess(t("workspace.management.storage.poolCreated"));
      setCreateOpen(false);
      setForm({ name: "", raidLevel: "1", filesystem: "ext4", devices: [] });
      setConfirmed(false);
      await onWorkQueuesChanged();
    } catch (nextError) {
      setCreateOpen(false);
      const message = errorMessage(nextError);
      onNotifyError(message);
    } finally {
      setSubmitting(false);
    }
  }

  const status = summary?.status ?? "unavailable";
  const pools = summary?.pools ?? [];
  const disks = summary?.disks ?? [];

  return (
    <section className="workspace-management" aria-label={t("workspace.management.storage.title")}>
      <PanelHeader
        icon={<Database aria-hidden="true" size={20} />}
        title={t("workspace.management.storage.title")}
        subtitle={t("workspace.management.storage.description")}
        actions={<PanelHeaderActions label={t("workspace.management.actions.label")}>
          <ManagementDashboardControls dashboard={dashboard} disabled={loading} />
          <PanelHeaderAction
            label={translate("workspace.management.actions.createPool")}
            type="button"
            onClick={openCreateModal}
            disabled={loading || !canCreatePool}
          >
            <Plus aria-hidden="true" size={17} />
          </PanelHeaderAction>
          <PanelHeaderAction
            label={t("common.actions.refresh")}
            type="button"
            onClick={() => { window.dispatchEvent(new Event(ISCSI_REFRESH_EVENT)); void refreshSummary(); }}
            disabled={loading}
            aria-busy={loading || undefined}
          >
            {loading ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={17} />}
          </PanelHeaderAction>
        </PanelHeaderActions>}
      />

      <div className="management-body">
        <ManagementDashboardGrid
          dashboard={dashboard}
          loading={loading}
          items={[
              {
                id: "overview",
                title: String(t("workspace.management.storage.title")),
                content: (
                  <section className="management-command-panel">
                    <div className="management-emblem" aria-hidden="true"><Database size={31} /></div>
                    <div className="management-command-copy">
                      <div>
                        <span className="management-status-pill" data-state={systemStatusTone(status, loading, error)}>{systemStatusLabel(status, loading, error, translate)}</span>
                        <h3>{t("workspace.management.storage.title")}</h3>
                        <p title={systemDiagnosticTitle(error, summary?.issues)}>{storageStatusDetail(summary, loading, error, translate)}</p>
                      </div>
                      <dl className="management-fact-list">
                        <Fact label={t("workspace.management.storage.facts.backend")} value="mdadm" />
                        <Fact
                          label={translate("workspace.management.storage.facts.mode")}
                          value={translate("workspace.management.storage.values.directApply")}
                        />
                        <Fact label={t("workspace.management.storage.facts.pools")} value={formatLocaleNumber(summary?.metrics.pools ?? 0, locale)} />
                        <Fact label={t("workspace.management.storage.facts.arrays")} value={formatLocaleNumber(summary?.metrics.arrays ?? 0, locale)} />
                      </dl>
                    </div>
                  </section>
                )
              },
              ...storageMetrics(summary, locale, translate).map((metric) => ({
                id: `metric-${metric.id}`,
                title: metric.label,
                content: <MetricCard key={metric.id} metric={metric} />
              })),
              {
                id: "pools",
                title: String(t("workspace.management.storage.poolsTitle")),
                content: (
                  <section className="management-section management-table-section">
                    <SectionHeader title={t("workspace.management.storage.poolsTitle")} description={t("workspace.management.storage.poolsDescription")} />
                    {pools.length ? (
                      <div className="management-table-wrap">
                        <table className="management-table management-table-storage">
                          <thead><tr><th>{t("workspace.management.columns.name")}</th><th>{t("workspace.management.columns.status")}</th><th>{t("workspace.management.storage.columns.raid")}</th><th>{t("workspace.management.storage.columns.usage")}</th><th>{t("workspace.management.storage.columns.mount")}</th><th>{t("workspace.management.storage.columns.members")}</th></tr></thead>
                          <tbody>{pools.map((pool) => (
                            <tr key={pool.id}>
                              <td title={pool.name}><button type="button" className="storage-pool-name-button" onClick={() => openPoolDetails(pool)} aria-label={t("workspace.management.storage.openPoolDetails", { name: pool.name })}>{pool.name}</button></td>
                              <td><StatusIcon tone={storagePoolTone(pool)} label={storagePoolStatusLabel(pool, translate)} /></td>
                              <td title={pool.raidPath}>{pool.raidLevel ?? t("common.dash")}</td>
                              <td>{formatStorageUsage(pool, locale, translate)}</td>
                              <td title={pool.mountpoint ?? t("common.dash")}>{pool.mountpoint ?? t("common.dash")}</td>
                              <td title={pool.memberDevices.join(", ")}>{pool.memberDevices.length}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    ) : <p className="management-empty management-table-empty-state">{t("workspace.management.storage.noPools")}</p>}
                  </section>
                )
              },
              {
                id: "disks",
                title: String(t("workspace.management.storage.disksTitle")),
                content: (
                  <section className="management-section">
                    <SectionHeader title={t("workspace.management.storage.disksTitle")} description={t("workspace.management.storage.disksDescription")} />
                    <div className="management-workload-list">{disks.length ? disks.map((disk) => <StorageDiskRow key={disk.id} disk={disk} locale={locale} onOpen={() => openDiskDetails(disk)} />) : <p className="management-empty">{t("workspace.management.storage.noDisks")}</p>}</div>
                  </section>
                )
              },
              {
                id: "health",
                title: String(t("workspace.management.storage.healthTitle")),
                content: (
                  <section className="management-section">
                    <SectionHeader title={t("workspace.management.storage.healthTitle")} description={t("workspace.management.storage.healthDescription")} />
                    <StorageHealthCharts summary={summary} locale={locale} t={translate} />
                  </section>
                )
              },
              {
                id: "iscsi",
                title: "iSCSI",
                loading: false,
                content: <IscsiManagementCard locale={locale} onNotifySuccess={onNotifySuccess} onWorkQueuesChanged={() => { void refreshSummary(); return onWorkQueuesChanged(); }} />
              }
          ]}
        />
      </div>

      {selectedPool ? (
        <div
          className="management-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => event.currentTarget === event.target && closePoolDetails()}
        >
          <section
            className="management-modal storage-pool-details-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="storage-pool-details-title"
          >
            <header>
              <div className="storage-pool-details-heading">
                <span className="eyebrow">{t("workspace.management.storage.detailsEyebrow")}</span>
                <h2 id="storage-pool-details-title" title={selectedPool.name}>{selectedPool.name}</h2>
                <span className="management-row-status" data-state={storagePoolTone(selectedPool)}>
                  {storagePoolStatusLabel(selectedPool, translate)}
                </span>
              </div>
              <button
                type="button"
                className="management-icon-action"
                onClick={closePoolDetails}
                disabled={deleting}
                title={t("common.actions.cancel")}
                aria-label={t("common.actions.cancel")}
              >
                <X aria-hidden="true" size={15} />
              </button>
            </header>

            <div className="storage-pool-details-body">
              <div className="storage-pool-details-overview">
                <StoragePoolUsageChart pool={selectedPool} locale={locale} t={translate} />
                <div className="storage-pool-details-summary">
                  <span className="eyebrow">{t("workspace.management.storage.capacityLabel")}</span>
                  <strong>{formatStorageUsage(selectedPool, locale, translate)}</strong>
                  <p>{t("workspace.management.storage.detailsDescription")}</p>
                </div>
              </div>

              <div className="storage-pool-details-facts">
                <StoragePoolDetailFact label={translate("workspace.management.storage.detailFacts.raid")} value={selectedPool.raidLevel ?? translate("common.dash")} />
                <StoragePoolDetailFact label={translate("workspace.management.storage.detailFacts.filesystem")} value={selectedPool.filesystem ?? translate("common.dash")} />
                <StoragePoolDetailFact label={translate("workspace.management.storage.detailFacts.mountpoint")} value={selectedPool.mountpoint ?? translate("common.dash")} />
                <StoragePoolDetailFact label={translate("workspace.management.storage.detailFacts.array")} value={selectedPool.raidPath} />
              </div>

              <section className="storage-pool-members" aria-labelledby="storage-pool-members-title">
                <header>
                  <div>
                    <span className="eyebrow">{t("workspace.management.storage.membersEyebrow")}</span>
                    <h3 id="storage-pool-members-title">{t("workspace.management.storage.membersTitle")}</h3>
                  </div>
                  <strong>{formatLocaleNumber(selectedPool.memberDevices.length, locale)}</strong>
                </header>
                <div className="storage-pool-member-list">
                  {selectedPool.memberDevices.map((device) => (
                    <div className="storage-pool-member" key={device}>
                      <HardDrive aria-hidden="true" size={15} />
                      <span>{device}</span>
                      <span>{t("workspace.management.storage.memberDevice")}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="storage-pool-delete-panel" data-state={deleteStep === "idle" ? "idle" : "danger"}>
                <div className="storage-pool-delete-copy">
                  <CircleAlert aria-hidden="true" size={18} />
                  <div>
                    <h3>{t("workspace.management.storage.deleteTitle")}</h3>
                    <p>
                      {deleteStep === "idle"
                        ? t("workspace.management.storage.deleteDescription")
                        : deleteStep === "warning"
                          ? t("workspace.management.storage.deleteWarning")
                          : t("workspace.management.storage.deleteFinalDescription", { name: storagePoolConfirmationName(selectedPool) })}
                    </p>
                  </div>
                </div>
                {!summary?.capabilities.canDeletePool ? (
                  <p className="storage-pool-delete-disabled">{t("workspace.management.storage.deleteUnavailable")}</p>
                ) : deleteStep === "idle" ? (
                  <button type="button" className="danger-button" onClick={beginPoolDelete} disabled={deleting}>
                    <Trash2 aria-hidden="true" size={15} />
                    <span>{t("workspace.management.storage.deletePool")}</span>
                  </button>
                ) : deleteStep === "warning" ? (
                  <div className="storage-pool-delete-actions">
                    <button type="button" onClick={() => setDeleteStep("idle")} disabled={deleting}>{t("common.actions.cancel")}</button>
                    <button type="button" className="danger-button" onClick={continuePoolDelete} disabled={deleting}>
                      <CircleAlert aria-hidden="true" size={15} />
                      <span>{t("workspace.management.storage.deleteContinue")}</span>
                    </button>
                  </div>
                ) : (
                  <div className="storage-pool-delete-confirmation">
                    <label>
                      <span>{t("workspace.management.storage.deleteConfirmationLabel", { name: storagePoolConfirmationName(selectedPool) })}</span>
                      <input
                        value={deleteConfirmation}
                        onChange={(event) => setDeleteConfirmation(event.target.value)}
                        autoComplete="off"
                        autoFocus
                        disabled={deleting}
                        placeholder={storagePoolConfirmationName(selectedPool)}
                      />
                    </label>
                    <div className="storage-pool-delete-actions">
                      <button type="button" onClick={() => setDeleteStep("idle")} disabled={deleting}>{t("common.actions.cancel")}</button>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => void submitPoolDelete()}
                        disabled={deleting || deleteConfirmation.trim() !== storagePoolConfirmationName(selectedPool)}
                        aria-busy={deleting || undefined}
                      >
                        {deleting ? <LoaderCircle className="storage-pool-spinner" aria-hidden="true" size={15} /> : <Trash2 aria-hidden="true" size={15} />}
                        <span>{deleting ? t("common.states.loading") : t("workspace.management.storage.deleteConfirm")}</span>
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </section>
        </div>
      ) : null}

      {selectedDisk && summary ? (
        <StorageDiskDetailsModal
          disk={selectedDisk}
          summary={summary}
          locale={locale}
          t={translate}
          onClose={closeDiskDetails}
        />
      ) : null}

      {createOpen ? (
        <div
          className="management-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => event.currentTarget === event.target && closeCreateModal()}
        >
          <section
            className="management-modal storage-pool-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="storage-pool-title"
          >
            <header>
              <div>
                <span className="eyebrow">{t("workspace.management.storage.createEyebrow")}</span>
                <h2 id="storage-pool-title">{t("workspace.management.storage.createTitle")}</h2>
              </div>
              <button
                type="button"
                className="management-icon-action"
                onClick={closeCreateModal}
                disabled={submitting}
                title={t("common.actions.cancel")}
                aria-label={t("common.actions.cancel")}
              >
                <X aria-hidden="true" size={15} />
              </button>
            </header>
            <form className="storage-pool-form" onSubmit={submitStorageProposal}>
              <div className="storage-pool-fields">
                <label>
                  <span>{t("workspace.management.storage.fields.name")}</span>
                  <input
                    value={form.name}
                    disabled={submitting}
                    onChange={(event) => {
                      setForm((current) => ({ ...current, name: event.target.value }));
                    }}
                    placeholder="media"
                    autoFocus
                    autoComplete="off"
                    maxLength={32}
                  />
                </label>
                <label>
                  <span>{t("workspace.management.storage.fields.raid")}</span>
                  <select
                    value={form.raidLevel}
                    disabled={submitting}
                    onChange={(event) => {
                      setForm((current) => ({ ...current, raidLevel: event.target.value as StorageRaidLevel }));
                    }}
                  >
                    {STORAGE_RAID_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        RAID {level} ({t("workspace.management.storage.raidMinimum", { count: raidMinimum(level) })})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("workspace.management.storage.fields.filesystem")}</span>
                  <select
                    value={form.filesystem}
                    disabled={submitting}
                    onChange={(event) => {
                      setForm((current) => ({ ...current, filesystem: event.target.value as StorageFilesystem }));
                    }}
                  >
                    {STORAGE_FILESYSTEMS.map((filesystem) => (
                      <option key={filesystem} value={filesystem}>
                        {t(`workspace.management.storage.filesystems.${filesystem}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <section
                className="storage-disk-selection"
                role="group"
                aria-labelledby="storage-disk-selection-title"
              >
                <h3 id="storage-disk-selection-title">{t("workspace.management.storage.fields.devices")}</h3>
                <p>{t("workspace.management.storage.diskSelectionDescription")}</p>
                <div className="storage-disk-options">
                  {availableDisks.length ? (
                    availableDisks.map((disk) => {
                      const diskSummary: Pick<StorageSummary, "arrays"> = summary ?? { arrays: [] };
                      const availability = storageDiskAvailability(disk, diskSummary);
                      const selectable = isStorageDiskSelectable(disk, diskSummary);
                      const details = [disk.model, disk.transport, disk.sizeBytes !== null ? formatBytes(disk.sizeBytes, locale) : null]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <label key={disk.id} className="storage-disk-option" data-state={availability}>
                          <input
                            type="checkbox"
                            checked={form.devices.includes(disk.path)}
                            disabled={!selectable || submitting}
                            onChange={(event) => toggleDevice(disk.path, event.target.checked)}
                          />
                          <span>
                            <strong>{disk.path}</strong>
                            <small>{details || t("common.dash")}</small>
                          </span>
                          <em>{storageDiskAvailabilityLabel(availability, t)}</em>
                        </label>
                      );
                    })
                  ) : (
                    <p className="management-empty">{t("workspace.management.storage.noDisks")}</p>
                  )}
                </div>
              </section>

              <p className="storage-pool-risk-note">
                <CircleAlert aria-hidden="true" size={15} />
                <span>
                  {t("workspace.management.storage.eraseWarning", {
                    filesystem: t(`workspace.management.storage.filesystems.${form.filesystem}`)
                  })}
                </span>
              </p>

              <label className="storage-pool-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={submitting}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>{t("workspace.management.storage.directApplyConfirmation")}</span>
              </label>

              {submitting ? (
                <div className="storage-pool-progress" aria-live="polite">
                  <div className="storage-pool-progress-summary">
                    <LoaderCircle className="storage-pool-spinner" aria-hidden="true" size={17} />
                    <div>
                      <strong id="storage-pool-progress-title">{t("workspace.management.storage.creatingTitle")}</strong>
                      <span id="storage-pool-progress-description">
                        {t("workspace.management.storage.creatingDescription")}
                      </span>
                    </div>
                  </div>
                  <div
                    className="storage-pool-progress-track"
                    role="progressbar"
                    aria-labelledby="storage-pool-progress-title"
                    aria-describedby="storage-pool-progress-description"
                  >
                    <span />
                  </div>
                </div>
              ) : null}

              <footer className="storage-pool-form-actions">
                <button type="button" onClick={closeCreateModal} disabled={submitting}>
                  {t("common.actions.cancel")}
                </button>
                <button type="submit" className="is-primary" disabled={submitting || !confirmed} aria-busy={submitting || undefined}>
                  {submitting ? (
                    <LoaderCircle className="storage-pool-spinner" aria-hidden="true" size={15} />
                  ) : (
                    <Plus aria-hidden="true" size={15} />
                  )}
                  <span>{submitting ? t("common.states.loading") : t("workspace.management.storage.createPool")}</span>
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function StoragePoolUsageChart({
  pool,
  locale,
  t
}: {
  pool: StoragePool;
  locale: SupportedLocale;
  t: Translate;
}) {
  const ratio = pool.usedPercent ?? (
    pool.totalBytes !== null && pool.totalBytes > 0 && pool.usedBytes !== null
      ? clampStorageRatio(pool.usedBytes / pool.totalBytes)
      : null
  );
  const value = ratio === null ? 0 : ratio * 100;
  const tone = usageGaugeTone(ratio);
  const chartData = [{ name: t("workspace.management.storage.capacityUsedLabel"), value, fill: storageHealthColor(tone) }];

  return (
    <div className="storage-pool-usage-chart" aria-label={t("workspace.management.storage.capacityChartLabel")}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius="68%"
          outerRadius="92%"
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            background={{ fill: "var(--surface)" }}
            cornerRadius={6}
            isAnimationActive={false}
          />
          <Tooltip
            contentStyle={{ background: "var(--modal-bg)", border: "1px solid var(--line)", borderRadius: 5, color: "var(--text)", fontSize: 11 }}
            formatter={(nextValue) => [`${formatLocaleNumber(Number(nextValue), locale, { maximumFractionDigits: 1 })}%`, t("workspace.management.storage.capacityUsedLabel")]}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="storage-pool-usage-center">
        <strong>{ratio === null ? t("common.dash") : `${formatLocaleNumber(value, locale, { maximumFractionDigits: 1 })}%`}</strong>
        <span>{t("workspace.management.storage.capacityUsedLabel")}</span>
      </div>
    </div>
  );
}

function SmartStatusChart({
  health,
  t,
  detail = false
}: {
  health: StorageDisk["smart"]["health"];
  t: Translate;
  detail?: boolean;
}) {
  const tone = smartGaugeTone(health);
  const StatusIcon = health === "passed" ? CircleCheck : health === "failed" || health === "error" ? CircleAlert : HardDrive;
  const label = smartHealthLabel(health, t);
  const chartData = [{ name: label, value: 100, fill: storageHealthColor(tone) }];

  return (
    <div
      className={`storage-smart-status-chart${detail ? " is-detail" : ""}`}
      data-state={tone}
      role="img"
      aria-label={label}
      title={label}
    >
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius="72%"
          outerRadius="100%"
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar dataKey="value" cornerRadius={8} isAnimationActive={false} />
        </RadialBarChart>
      </ResponsiveContainer>
      <StatusIcon aria-hidden="true" size={detail ? 22 : 16} />
    </div>
  );
}

function StorageDiskDetailsModal({
  disk,
  summary,
  locale,
  t,
  onClose
}: {
  disk: StorageDisk;
  summary: StorageSummary;
  locale: SupportedLocale;
  t: Translate;
  onClose: () => void;
}) {
  const capacity = diskCapacityUsage(disk, summary);
  const smart = disk.smart;
  const deviceFacts = [
    { id: "model", label: t("workspace.management.storage.diskFacts.model"), value: disk.model ?? t("common.dash") },
    { id: "serial", label: t("workspace.management.storage.diskFacts.serial"), value: disk.serial ?? t("common.dash") },
    { id: "protocol", label: t("workspace.management.storage.diskFacts.protocol"), value: smart.protocol ?? disk.transport ?? t("common.dash") },
    { id: "firmware", label: t("workspace.management.storage.diskFacts.firmware"), value: smart.firmwareVersion ?? t("common.dash") },
    { id: "media", label: t("workspace.management.storage.diskFacts.media"), value: storageMediaLabel(disk, t) },
    { id: "capacity", label: t("workspace.management.storage.diskFacts.capacity"), value: formatNullableBytes(disk.sizeBytes, locale, t) }
  ];
  const smartFacts = [
    { id: "available", label: t("workspace.management.storage.smartFacts.available"), value: formatBoolean(smart.available, t) },
    { id: "enabled", label: t("workspace.management.storage.smartFacts.enabled"), value: formatBoolean(smart.enabled, t) },
    { id: "temperature", label: t("workspace.management.storage.smartFacts.temperature"), value: formatTemperature(smart.temperatureCelsius, locale, t) },
    { id: "temperatureMin", label: t("workspace.management.storage.smartFacts.temperatureMin"), value: formatTemperature(smart.temperatureMinCelsius, locale, t) },
    { id: "temperatureMax", label: t("workspace.management.storage.smartFacts.temperatureMax"), value: formatTemperature(smart.temperatureMaxCelsius, locale, t) },
    { id: "powerOn", label: t("workspace.management.storage.smartFacts.powerOn"), value: formatHours(smart.powerOnHours, locale, t) },
    { id: "powerCycles", label: t("workspace.management.storage.smartFacts.powerCycles"), value: formatNullableNumber(smart.powerCycleCount, locale, t) },
    { id: "errors", label: t("workspace.management.storage.smartFacts.errors"), value: formatNullableNumber(smart.errorCount, locale, t) },
    { id: "selfTest", label: t("workspace.management.storage.smartFacts.selfTest"), value: smart.selfTestStatus ?? t("common.dash") }
  ];
  const nvmeFacts = [
    { id: "lifeUsed", label: t("workspace.management.storage.smartFacts.lifeUsed"), value: formatPercentValue(smart.percentageUsed, locale, t) },
    { id: "spare", label: t("workspace.management.storage.smartFacts.spare"), value: formatPercentValue(smart.availableSparePercent, locale, t) },
    { id: "spareThreshold", label: t("workspace.management.storage.smartFacts.spareThreshold"), value: formatPercentValue(smart.availableSpareThresholdPercent, locale, t) },
    { id: "unsafeShutdowns", label: t("workspace.management.storage.smartFacts.unsafeShutdowns"), value: formatNullableNumber(smart.unsafeShutdowns, locale, t) },
    { id: "criticalWarning", label: t("workspace.management.storage.smartFacts.criticalWarning"), value: formatNullableNumber(smart.criticalWarning, locale, t) },
    { id: "dataRead", label: t("workspace.management.storage.smartFacts.dataRead"), value: formatNullableNumber(smart.dataUnitsRead, locale, t) },
    { id: "dataWritten", label: t("workspace.management.storage.smartFacts.dataWritten"), value: formatNullableNumber(smart.dataUnitsWritten, locale, t) },
    { id: "hostReads", label: t("workspace.management.storage.smartFacts.hostReads"), value: formatNullableNumber(smart.hostReadCommands, locale, t) },
    { id: "hostWrites", label: t("workspace.management.storage.smartFacts.hostWrites"), value: formatNullableNumber(smart.hostWriteCommands, locale, t) },
    { id: "busyTime", label: t("workspace.management.storage.smartFacts.busyTime"), value: formatNullableNumber(smart.controllerBusyMinutes, locale, t) },
    { id: "warningTemperatureTime", label: t("workspace.management.storage.smartFacts.warningTemperatureTime"), value: formatNullableNumber(smart.warningTemperatureTimeMinutes, locale, t) },
    { id: "criticalTemperatureTime", label: t("workspace.management.storage.smartFacts.criticalTemperatureTime"), value: formatNullableNumber(smart.criticalTemperatureTimeMinutes, locale, t) },
    { id: "errorLogEntries", label: t("workspace.management.storage.smartFacts.errorLogEntries"), value: formatNullableNumber(smart.errorLogEntries, locale, t) }
  ].filter((fact) => fact.value !== t("common.dash"));

  return (
    <div
      className="management-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.currentTarget === event.target && onClose()}
    >
      <section
        className="management-modal storage-disk-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-disk-details-title"
      >
        <header>
          <div className="storage-disk-details-heading">
            <span className="eyebrow">{t("workspace.management.storage.diskDetailsEyebrow")}</span>
            <h2 id="storage-disk-details-title">{disk.path}</h2>
          </div>
          <button
            type="button"
            className="management-icon-action"
            onClick={onClose}
            title={t("common.actions.cancel")}
            aria-label={t("common.actions.cancel")}
          >
            <X aria-hidden="true" size={15} />
          </button>
        </header>

        <div className="storage-disk-details-body">
          <div className="storage-disk-capacity-overview">
            <DiskCapacityChart usage={capacity} locale={locale} t={t} />
            <div className="storage-disk-capacity-summary">
              <span className="eyebrow">{t("workspace.management.storage.diskCapacityTitle")}</span>
              <strong>{formatNullableBytes(capacity.totalBytes, locale, t)}</strong>
              <p>{diskCapacitySource(capacity, t)}</p>
              <dl>
                <div>
                  <dt>{t("workspace.management.storage.diskCapacityUsed")}</dt>
                  <dd>{formatNullableBytes(capacity.usedBytes, locale, t)}</dd>
                </div>
                <div>
                  <dt>{t("workspace.management.storage.diskCapacityAvailable")}</dt>
                  <dd>{formatNullableBytes(capacity.availableBytes, locale, t)}</dd>
                </div>
              </dl>
            </div>
          </div>

          <section className="storage-disk-detail-section storage-disk-smart-section">
            <header>
              <SmartStatusChart health={smart.health} t={t} detail />
              <div>
                <span className="eyebrow">SMART</span>
                <h3>{smartHealthLabel(smart.health, t)}</h3>
                <p>{t("workspace.management.storage.smartDetailsDescription")}</p>
              </div>
            </header>
            <div className="storage-disk-detail-facts">
              {smartFacts.map((fact) => <StoragePoolDetailFact key={fact.id} label={fact.label} value={fact.value} />)}
            </div>
            {nvmeFacts.length ? (
              <>
                <h4>{t("workspace.management.storage.nvmeDetailsTitle")}</h4>
                <div className="storage-disk-detail-facts">
                  {nvmeFacts.map((fact) => <StoragePoolDetailFact key={fact.id} label={fact.label} value={fact.value} />)}
                </div>
              </>
            ) : null}
            {smart.message ? <p className="storage-disk-smart-message">{smart.message}</p> : null}
          </section>

          <section className="storage-disk-detail-section">
            <header>
              <div>
                <span className="eyebrow">{t("workspace.management.storage.diskDetailsEyebrow")}</span>
                <h3>{t("workspace.management.storage.deviceDetailsTitle")}</h3>
              </div>
            </header>
            <div className="storage-disk-detail-facts">
              {deviceFacts.map((fact) => <StoragePoolDetailFact key={fact.id} label={fact.label} value={fact.value} />)}
            </div>
          </section>

          <SmartAttributesTable disk={disk} locale={locale} t={t} />
          <SmartSelfTestsTable disk={disk} locale={locale} t={t} />
          <DiskPartitionsTable disk={disk} locale={locale} t={t} />
        </div>
      </section>
    </div>
  );
}

function DiskCapacityChart({
  usage,
  locale,
  t
}: {
  usage: DiskCapacityUsage;
  locale: SupportedLocale;
  t: Translate;
}) {
  const value = usage.ratio === null ? 0 : usage.ratio * 100;
  const tone = usageGaugeTone(usage.ratio);
  const chartData = [{ name: t("workspace.management.storage.diskCapacityUsed"), value, fill: storageHealthColor(tone, "var(--accent-soft-text)") }];

  return (
    <div className="storage-disk-capacity-chart" aria-label={t("workspace.management.storage.diskCapacityChartLabel")}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius="68%"
          outerRadius="94%"
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            background={{ fill: "var(--surface)" }}
            cornerRadius={7}
            isAnimationActive={false}
          />
          {usage.ratio !== null ? (
            <Tooltip
              contentStyle={{ background: "var(--modal-bg)", border: "1px solid var(--line)", borderRadius: 5, color: "var(--text)", fontSize: 11 }}
              formatter={(nextValue) => [formatCapacityPercent(Number(nextValue), locale), t("workspace.management.storage.diskCapacityUsed")]}
            />
          ) : null}
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="storage-disk-capacity-center">
        <strong>{usage.ratio === null ? t("common.dash") : formatCapacityPercent(value, locale)}</strong>
        <span>{t("workspace.management.storage.capacityUsedLabel")}</span>
      </div>
    </div>
  );
}

function SmartAttributesTable({ disk, locale, t }: { disk: StorageDisk; locale: SupportedLocale; t: Translate }) {
  const attributes = disk.smart.attributes ?? [];
  if (!attributes.length) {
    return null;
  }
  return (
    <section className="storage-disk-detail-section">
      <header>
        <div>
          <span className="eyebrow">SMART</span>
          <h3>{t("workspace.management.storage.smartAttributesTitle")}</h3>
        </div>
        <strong>{formatLocaleNumber(attributes.length, locale)}</strong>
      </header>
      <div className="storage-disk-table-wrap">
        <table className="storage-disk-details-table">
          <thead>
            <tr>
              <th>{t("workspace.management.storage.smartAttributeColumns.id")}</th>
              <th>{t("workspace.management.storage.smartAttributeColumns.name")}</th>
              <th>{t("workspace.management.storage.smartAttributeColumns.current")}</th>
              <th>{t("workspace.management.storage.smartAttributeColumns.worst")}</th>
              <th>{t("workspace.management.storage.smartAttributeColumns.threshold")}</th>
              <th>{t("workspace.management.storage.smartAttributeColumns.raw")}</th>
              <th>{t("workspace.management.storage.smartAttributeColumns.flags")}</th>
              <th>{t("workspace.management.storage.smartAttributeColumns.failed")}</th>
            </tr>
          </thead>
          <tbody>
            {attributes.map((attribute, index) => (
              <tr key={`${attribute.id ?? "attribute"}-${attribute.name}-${index}`} data-state={attribute.whenFailed ? "danger" : "ready"}>
                <td>{formatNullableNumber(attribute.id, locale, t)}</td>
                <td title={attribute.name}>{attribute.name}</td>
                <td>{formatNullableNumber(attribute.current, locale, t)}</td>
                <td>{formatNullableNumber(attribute.worst, locale, t)}</td>
                <td>{formatNullableNumber(attribute.threshold, locale, t)}</td>
                <td title={attribute.raw ?? t("common.dash")}>{attribute.raw ?? t("common.dash")}</td>
                <td>{attribute.flags ?? t("common.dash")}</td>
                <td>{attribute.whenFailed ?? t("common.dash")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SmartSelfTestsTable({ disk, locale, t }: { disk: StorageDisk; locale: SupportedLocale; t: Translate }) {
  const selfTests = disk.smart.selfTests ?? [];
  if (!selfTests.length) {
    return null;
  }
  return (
    <section className="storage-disk-detail-section">
      <header>
        <div>
          <span className="eyebrow">SMART</span>
          <h3>{t("workspace.management.storage.smartSelfTestsTitle")}</h3>
        </div>
        <strong>{formatLocaleNumber(selfTests.length, locale)}</strong>
      </header>
      <div className="storage-disk-table-wrap">
        <table className="storage-disk-details-table">
          <thead>
            <tr>
              <th>{t("workspace.management.storage.smartSelfTestColumns.number")}</th>
              <th>{t("workspace.management.storage.smartSelfTestColumns.type")}</th>
              <th>{t("workspace.management.storage.smartSelfTestColumns.status")}</th>
              <th>{t("workspace.management.storage.smartSelfTestColumns.remaining")}</th>
              <th>{t("workspace.management.storage.smartSelfTestColumns.lifetime")}</th>
              <th>{t("workspace.management.storage.smartSelfTestColumns.firstError")}</th>
            </tr>
          </thead>
          <tbody>
            {selfTests.map((test, index) => (
              <tr key={`${test.number ?? "test"}-${index}`}>
                <td>{formatNullableNumber(test.number, locale, t)}</td>
                <td>{test.type ?? t("common.dash")}</td>
                <td>{test.status ?? t("common.dash")}</td>
                <td>{formatPercentValue(test.remainingPercent, locale, t)}</td>
                <td>{formatHours(test.lifetimeHours, locale, t)}</td>
                <td>{formatNullableNumber(test.firstErrorLba, locale, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DiskPartitionsTable({ disk, locale, t }: { disk: StorageDisk; locale: SupportedLocale; t: Translate }) {
  return (
    <section className="storage-disk-detail-section">
      <header>
        <div>
          <span className="eyebrow">{t("workspace.management.storage.diskDetailsEyebrow")}</span>
          <h3>{t("workspace.management.storage.partitionsTitle")}</h3>
        </div>
        <strong>{formatLocaleNumber(disk.partitions.length, locale)}</strong>
      </header>
      {disk.partitions.length ? (
        <div className="storage-disk-table-wrap">
          <table className="storage-disk-details-table">
            <thead>
              <tr>
                <th>{t("workspace.management.storage.partitionColumns.path")}</th>
                <th>{t("workspace.management.storage.partitionColumns.filesystem")}</th>
                <th>{t("workspace.management.storage.partitionColumns.size")}</th>
                <th>{t("workspace.management.storage.partitionColumns.mounts")}</th>
              </tr>
            </thead>
            <tbody>
              {disk.partitions.map((partition) => (
                <tr key={partition.id}>
                  <td title={partition.path}>{partition.path}</td>
                  <td>{partition.filesystem ?? t("common.dash")}</td>
                  <td>{formatNullableBytes(partition.sizeBytes, locale, t)}</td>
                  <td title={partition.mountpoints.join(", ")}>{partition.mountpoints.join(", ") || t("common.dash")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="storage-disk-detail-empty">{t("workspace.management.storage.noPartitions")}</p>
      )}
    </section>
  );
}

function StoragePoolDetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function storagePoolConfirmationName(pool: StoragePool): string {
  return pool.mountpoint?.split("/").filter(Boolean).at(-1) ?? pool.name;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="management-section-header">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </header>
  );
}

function MetricCard({ metric }: { metric: Metric }) {
  const Icon = metric.Icon;
  return (
    <article className="management-metric" data-state={metric.state}>
      <Icon aria-hidden="true" size={18} />
      <span>{metric.label}</span>
      <strong>{metric.value}</strong>
      <small>{metric.detail}</small>
    </article>
  );
}

export function NetworkReadinessSummary({
  metrics,
  locale
}: {
  metrics: NetworkSummary["metrics"] | undefined;
  locale: SupportedLocale;
}) {
  const { t } = useTranslation();
  const interfaces = metrics?.interfaces ?? 0;
  const connected = metrics?.connected ?? 0;
  const addresses = metrics?.addresses ?? 0;
  const defaultRoutes = metrics?.defaultRoutes ?? 0;
  const connectedPercent = ratioGauge(connected, interfaces);
  const connectedDisplay = `${formatLocaleNumber(connected, locale)} / ${formatLocaleNumber(interfaces, locale)}`;
  const hasDefaultRoute = defaultRoutes > 0;

  return (
    <dl className="network-readiness-summary" aria-label={t("workspace.management.network.readinessDescription")}>
      <div className="network-readiness-signal" data-kind="ratio" data-state={connected ? "ready" : interfaces ? "warning" : "neutral"}>
        <dt>
          <Activity aria-hidden="true" size={18} />
          <span><strong>{t("workspace.management.network.gauges.connected")}</strong><small>{t("workspace.management.network.gauges.connectedDetail")}</small></span>
        </dt>
        <dd className="network-readiness-ratio">
          <div><strong>{formatLocaleNumber(connected, locale)} <span>/ {formatLocaleNumber(interfaces, locale)}</span></strong><small>{formatLocaleNumber(connectedPercent / 100, locale, { style: "percent", maximumFractionDigits: 0 })}</small></div>
          <div
            className="network-readiness-track"
            role="progressbar"
            aria-label={t("workspace.management.network.gauges.connected")}
            aria-valuemin={0}
            aria-valuemax={Math.max(interfaces, 1)}
            aria-valuenow={connected}
            aria-valuetext={connectedDisplay}
          ><span style={{ width: `${connectedPercent}%` }} /></div>
        </dd>
      </div>

      <div className="network-readiness-signal" data-kind="count" data-state={addresses ? "ready" : interfaces ? "warning" : "neutral"}>
        <dt>
          <Route aria-hidden="true" size={18} />
          <span><strong>{t("workspace.management.network.gauges.addresses")}</strong><small>{t("workspace.management.network.gauges.addressesDetail")}</small></span>
        </dt>
        <dd className="network-readiness-count"><data value={addresses}>{formatLocaleNumber(addresses, locale)}</data></dd>
      </div>

      <div className="network-readiness-signal" data-kind="status" data-state={hasDefaultRoute ? "ready" : "warning"}>
        <dt>
          <Network aria-hidden="true" size={18} />
          <span><strong>{t("workspace.management.network.gauges.defaultRoute")}</strong><small>{t("workspace.management.network.metrics.defaultRoutesDetail")}</small></span>
        </dt>
        <dd className="network-readiness-state">
          {hasDefaultRoute ? <CircleCheck aria-hidden="true" size={20} /> : <CircleAlert aria-hidden="true" size={20} />}
          <span>
            <strong>{t(hasDefaultRoute ? "common.states.ready" : "common.states.missing")}</strong>
            <small>{t(hasDefaultRoute ? "workspace.management.network.gauges.defaultRouteReadyDetail" : "workspace.management.network.gauges.defaultRouteMissingDetail")}</small>
          </span>
        </dd>
      </div>
    </dl>
  );
}

function NetworkTrafficMonitor({
  interfaces,
  locale,
  t
}: {
  interfaces: NetworkInterface[];
  locale: SupportedLocale;
  t: Translate;
}) {
  const [selectedInterfaceId, setSelectedInterfaceId] = useState("all");
  const [history, setHistory] = useState<NetworkTrafficPoint[]>([]);
  const [trafficState, setTrafficState] = useState<"sampling" | "ready" | "error">("sampling");
  const selectableInterfaces = useMemo(
    () => interfaces.filter((networkInterface) => networkInterface.kind !== "loopback"),
    [interfaces]
  );
  const interfaceKey = selectableInterfaces.map((networkInterface) => networkInterface.id).join("\u0000");

  useEffect(() => {
    if (selectedInterfaceId !== "all" && !selectableInterfaces.some((networkInterface) => networkInterface.id === selectedInterfaceId)) {
      setSelectedInterfaceId("all");
    }
  }, [interfaceKey, selectableInterfaces, selectedInterfaceId]);

  useEffect(() => {
    let active = true;
    let requestActive = false;
    let previous: NetworkTrafficSummary | null = null;
    const monitoredIds = new Set(
      selectedInterfaceId === "all"
        ? selectableInterfaces.map((networkInterface) => networkInterface.id)
        : [selectedInterfaceId]
    );

    setHistory([]);
    setTrafficState("sampling");

    async function sample() {
      if (requestActive) {
        return;
      }
      requestActive = true;
      try {
        const current = await getSystemNetworkTraffic();
        if (!active) {
          return;
        }
        if (previous) {
          const rate = calculateNetworkTrafficRate(previous, current, monitoredIds);
          if (rate) {
            setHistory((points) => [
              ...points,
              { timestamp: Date.parse(current.collectedAt), ...rate }
            ].slice(-NETWORK_TRAFFIC_HISTORY_LIMIT));
            setTrafficState("ready");
          }
        }
        previous = current;
      } catch {
        if (active) {
          setTrafficState("error");
        }
      } finally {
        requestActive = false;
      }
    }

    void sample();
    const interval = window.setInterval(() => void sample(), NETWORK_TRAFFIC_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [interfaceKey, selectableInterfaces, selectedInterfaceId]);

  const current = history.at(-1) ?? null;
  const chartData = history.map((point) => ({
    ...point,
    label: new Intl.DateTimeFormat(locale, { minute: "2-digit", second: "2-digit" }).format(point.timestamp)
  }));

  return (
    <section className="management-section network-traffic-section">
      <header className="management-section-header network-traffic-header">
        <div>
          <h3>{t("workspace.management.network.traffic.title")}</h3>
          <p>{t("workspace.management.network.traffic.description")}</p>
        </div>
        <label className="network-traffic-interface-select">
          <span>{t("workspace.management.network.traffic.interface")}</span>
          <select value={selectedInterfaceId} onChange={(event) => setSelectedInterfaceId(event.target.value)}>
            <option value="all">{t("workspace.management.network.traffic.allInterfaces")}</option>
            {selectableInterfaces.map((networkInterface) => (
              <option key={networkInterface.id} value={networkInterface.id}>{networkInterface.name}</option>
            ))}
          </select>
        </label>
      </header>

      <div className="network-traffic-body">
        <div className="network-traffic-stats">
          <div data-tone="rx">
            <Download aria-hidden="true" size={16} />
            <span>{t("workspace.management.network.traffic.received")}</span>
            <strong>{formatNetworkTrafficRate(current?.rxBytesPerSecond ?? null, locale, t)}</strong>
          </div>
          <div data-tone="tx">
            <Upload aria-hidden="true" size={16} />
            <span>{t("workspace.management.network.traffic.transmitted")}</span>
            <strong>{formatNetworkTrafficRate(current?.txBytesPerSecond ?? null, locale, t)}</strong>
          </div>
        </div>

        <div className="network-traffic-chart" aria-label={t("workspace.management.network.traffic.chartLabel")}>
          {chartData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 12, left: 2, bottom: 0 }}>
                <defs>
                  <linearGradient id="networkTrafficRx" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent-soft-text)" stopOpacity={0.38} />
                    <stop offset="100%" stopColor="var(--accent-soft-text)" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="networkTrafficTx" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--success-text)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="var(--success-text)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--line-soft)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "var(--muted-2)", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={28} />
                <YAxis tickFormatter={(value) => formatNetworkTrafficRate(Number(value), locale, t)} tick={{ fill: "var(--muted-2)", fontSize: 10 }} tickLine={false} axisLine={false} width={72} />
                <Tooltip
                  contentStyle={{ background: "var(--modal-bg)", border: "1px solid var(--line)", borderRadius: 5, color: "var(--text)", fontSize: 11 }}
                  labelStyle={{ color: "var(--muted)", marginBottom: 4 }}
                  formatter={(value, name) => [
                    formatNetworkTrafficRate(Number(value), locale, t),
                    name === "rxBytesPerSecond"
                      ? t("workspace.management.network.traffic.received")
                      : t("workspace.management.network.traffic.transmitted")
                  ]}
                />
                <Area type="monotone" dataKey="rxBytesPerSecond" stroke="var(--accent-soft-text)" strokeWidth={2} fill="url(#networkTrafficRx)" isAnimationActive={false} />
                <Area type="monotone" dataKey="txBytesPerSecond" stroke="var(--success-text)" strokeWidth={2} fill="url(#networkTrafficTx)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="network-traffic-empty" data-state={trafficState}>
              {trafficState === "error" ? <CircleAlert aria-hidden="true" size={18} /> : <Activity aria-hidden="true" size={18} />}
              <span>{t(`workspace.management.network.traffic.${trafficState}`)}</span>
            </div>
          )}
        </div>

        <div className="network-traffic-legend" aria-live="polite">
          <span><i data-tone="rx" />{t("workspace.management.network.traffic.received")}</span>
          <span><i data-tone="tx" />{t("workspace.management.network.traffic.transmitted")}</span>
          <small>{t("workspace.management.network.traffic.window", { count: history.length })}</small>
        </div>
      </div>
    </section>
  );
}

function NetworkRouteRow({ route }: { route: NetworkRoute }) {
  const { t } = useTranslation();
  const isDefault = route.destination === "default";
  const tone: StatusTone = isDefault ? "ready" : "neutral";
  const target = route.gateway ?? route.preferredSource ?? route.device ?? t("common.dash");

  return (
    <article className="management-workload">
      {statusIcon(tone)}
      <div>
        <strong>{route.destination}</strong>
        <span title={target}>{target}</span>
      </div>
      <em data-state={tone}>{isDefault ? t("workspace.management.network.defaultRoute") : route.family}</em>
      <small>{route.device ?? t("common.dash")}</small>
    </article>
  );
}

function NetworkInterfaceDetailsModal({
  networkInterface,
  routes,
  locale,
  t,
  onClose
}: {
  networkInterface: NetworkInterface;
  routes: NetworkRoute[];
  locale: SupportedLocale;
  t: Translate;
  onClose: () => void;
}) {
  const stateLabel = networkInterfaceStateLabel(networkInterface, t);
  const kindLabel = t(`workspace.management.network.kinds.${networkInterface.kind}`);
  const facts = [
    { id: "kind", label: t("workspace.management.network.detailFacts.kind"), value: kindLabel },
    { id: "index", label: t("workspace.management.network.detailFacts.index"), value: formatNullableNumber(networkInterface.index, locale, t) },
    { id: "operState", label: t("workspace.management.network.detailFacts.operState"), value: networkInterface.operState ?? t("common.dash") },
    { id: "defaultRoute", label: t("workspace.management.network.detailFacts.defaultRoute"), value: networkInterface.hasDefaultRoute ? t("common.yes") : t("common.no") },
    { id: "mac", label: t("workspace.management.network.detailFacts.mac"), value: networkInterface.mac ?? t("common.dash") },
    { id: "speed", label: t("workspace.management.network.detailFacts.speed"), value: formatSpeed(networkInterface.speedMbps, locale, t) },
    { id: "mtu", label: t("workspace.management.network.detailFacts.mtu"), value: formatNullableNumber(networkInterface.mtu, locale, t) },
    { id: "addresses", label: t("workspace.management.network.detailFacts.addresses"), value: formatLocaleNumber(networkInterface.addresses.length, locale) }
  ];

  useEffect(() => {
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="management-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.currentTarget === event.target && onClose()}
    >
      <section
        className="management-modal network-interface-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="network-interface-details-title"
      >
        <header className="network-interface-details-header">
          <div className="network-interface-details-heading">
            <span className="network-interface-details-icon" aria-hidden="true">
              <Network size={20} />
            </span>
            <div>
              <span className="eyebrow">{t("workspace.management.network.detailsEyebrow")}</span>
              <h2 id="network-interface-details-title">{networkInterface.name}</h2>
            </div>
            <span className="management-row-status" data-state={networkInterfaceTone(networkInterface)}>
              {stateLabel}
            </span>
          </div>
          <button
            type="button"
            className="management-icon-action"
            onClick={onClose}
            autoFocus
            title={t("common.actions.cancel")}
            aria-label={t("common.actions.cancel")}
          >
            <X aria-hidden="true" size={15} />
          </button>
        </header>

        <div className="network-interface-details-body">
          <section className="network-interface-overview">
            <div className="network-interface-overview-status">
              <StatusIcon tone={networkInterfaceTone(networkInterface)} label={stateLabel} />
            </div>
            <div className="network-interface-overview-copy">
              <span className="eyebrow">{kindLabel}</span>
              <strong>{stateLabel}</strong>
              <p>{t("workspace.management.network.detailsDescription", {
                kind: kindLabel,
                count: formatLocaleNumber(networkInterface.addresses.length, locale)
              })}</p>
            </div>
          </section>

          <div className="network-interface-detail-facts">
            {facts.map((fact) => <StoragePoolDetailFact key={fact.id} label={fact.label} value={fact.value} />)}
          </div>

          <div className="network-interface-detail-columns">
            <section className="network-interface-detail-section" aria-labelledby="network-interface-addresses-title">
              <header>
                <div>
                  <span className="eyebrow">IP</span>
                  <h3 id="network-interface-addresses-title">{t("workspace.management.network.addressesTitle")}</h3>
                </div>
                <strong>{formatLocaleNumber(networkInterface.addresses.length, locale)}</strong>
              </header>
              {networkInterface.addresses.length ? (
                <div className="network-interface-address-list">
                  {networkInterface.addresses.map((address, index) => (
                    <article key={`${address.family}-${address.address}-${index}`}>
                      <span className="network-interface-family">{address.family}</span>
                      <div>
                        <strong title={address.cidr ?? address.address}>{address.cidr ?? address.address}</strong>
                        <span>{[address.scope, address.label].filter(Boolean).join(" · ") || t("common.dash")}</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="network-interface-detail-empty">{t("workspace.management.network.noAddresses")}</p>
              )}
            </section>

            <section className="network-interface-detail-section" aria-labelledby="network-interface-routes-title">
              <header>
                <div>
                  <span className="eyebrow">{t("workspace.management.network.routesEyebrow")}</span>
                  <h3 id="network-interface-routes-title">{t("workspace.management.network.interfaceRoutesTitle")}</h3>
                </div>
                <strong>{formatLocaleNumber(routes.length, locale)}</strong>
              </header>
              {routes.length ? (
                <div className="network-interface-route-list">
                  {routes.map((route, index) => (
                    <article key={`${route.destination}-${route.gateway}-${index}`}>
                      <Route aria-hidden="true" size={15} />
                      <div>
                        <strong title={route.destination}>{route.destination}</strong>
                        <span title={route.gateway ?? route.preferredSource ?? t("common.dash")}>
                          {route.gateway ?? route.preferredSource ?? t("common.dash")}
                        </span>
                      </div>
                      <small>{[route.family, route.protocol, route.scope].filter(Boolean).join(" · ")}</small>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="network-interface-detail-empty">{t("workspace.management.network.noInterfaceRoutes")}</p>
              )}
            </section>
          </div>

          <section className="network-interface-flags" aria-labelledby="network-interface-flags-title">
            <header>
              <div>
                <span className="eyebrow">{t("workspace.management.network.linkEyebrow")}</span>
                <h3 id="network-interface-flags-title">{t("workspace.management.network.flagsTitle")}</h3>
              </div>
              <strong>{formatLocaleNumber(networkInterface.flags.length, locale)}</strong>
            </header>
            {networkInterface.flags.length ? (
              <div>{networkInterface.flags.map((flag) => <span key={flag}>{flag}</span>)}</div>
            ) : (
              <p className="network-interface-detail-empty">{t("workspace.management.network.noFlags")}</p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function StorageDiskRow({
  disk,
  locale,
  onOpen
}: {
  disk: StorageDisk;
  locale: SupportedLocale;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const model = [disk.model, disk.transport].filter(Boolean).join(" · ") || t("common.dash");

  return (
    <article className="management-workload system-storage-disk-row">
      <div className="storage-disk-identity">
        <HardDrive aria-hidden="true" size={18} />
        <div>
          <button
            type="button"
            className="storage-disk-name-button"
            onClick={onOpen}
            aria-label={t("workspace.management.storage.openDiskDetails", { name: disk.path })}
          >
            {disk.path}
          </button>
          <span title={model}>{model}</span>
        </div>
      </div>
      <SmartStatusChart health={disk.smart.health} t={translate} />
      <small title={formatNullableBytes(disk.sizeBytes, locale, translate)}>
        {formatNullableBytes(disk.sizeBytes, locale, translate)}
      </small>
    </article>
  );
}

function networkMetrics(
  summary: NetworkSummary | null,
  locale: SupportedLocale,
  t: Translate
): Metric[] {
  const metrics = summary?.metrics;
  return [
    {
      id: "interfaces",
      label: t("workspace.management.network.metrics.interfaces"),
      value: formatLocaleNumber(metrics?.interfaces ?? 0, locale),
      detail: t("workspace.management.network.metrics.interfacesDetail"),
      state: metrics?.interfaces ? "ready" : "neutral",
      Icon: Network
    },
    {
      id: "connected",
      label: t("workspace.management.network.metrics.connected"),
      value: formatLocaleNumber(metrics?.connected ?? 0, locale),
      detail: t("workspace.management.network.metrics.connectedDetail"),
      state: metrics?.connected ? "ready" : "warning",
      Icon: Activity
    },
    {
      id: "addresses",
      label: t("workspace.management.network.metrics.addresses"),
      value: formatLocaleNumber(metrics?.addresses ?? 0, locale),
      detail: t("workspace.management.network.metrics.addressesDetail"),
      state: metrics?.addresses ? "ready" : "neutral",
      Icon: Route
    },
    {
      id: "defaultRoutes",
      label: t("workspace.management.network.metrics.defaultRoutes"),
      value: formatLocaleNumber(metrics?.defaultRoutes ?? 0, locale),
      detail: t("workspace.management.network.metrics.defaultRoutesDetail"),
      state: metrics?.defaultRoutes ? "ready" : "warning",
      Icon: CircleCheck
    }
  ];
}

function storageMetrics(
  summary: StorageSummary | null,
  locale: SupportedLocale,
  t: Translate
): Metric[] {
  const metrics = summary?.metrics;
  return [
    {
      id: "pools",
      label: t("workspace.management.storage.metrics.pools"),
      value: formatLocaleNumber(metrics?.pools ?? 0, locale),
      detail: t("workspace.management.storage.metrics.poolsDetail"),
      state: metrics?.pools ? "ready" : "neutral",
      Icon: Database
    },
    {
      id: "disks",
      label: t("workspace.management.storage.metrics.disks"),
      value: formatLocaleNumber(metrics?.disks ?? 0, locale),
      detail: t("workspace.management.storage.metrics.disksDetail"),
      state: metrics?.disks ? "ready" : "warning",
      Icon: HardDrive
    },
    {
      id: "smart",
      label: t("workspace.management.storage.metrics.smart"),
      value: `${formatLocaleNumber(metrics?.smartPassed ?? 0, locale)} / ${formatLocaleNumber(metrics?.disks ?? 0, locale)}`,
      detail: t("workspace.management.storage.metrics.smartDetail"),
      state: metrics?.smartFailed ? "warning" : metrics?.smartPassed ? "ready" : "neutral",
      Icon: CircleCheck
    },
    {
      id: "capacity",
      label: t("workspace.management.storage.metrics.capacity"),
      value: formatNullableBytes(metrics?.totalBytes ?? null, locale, t),
      detail:
        metrics?.usedBytes === null || metrics?.usedBytes === undefined
          ? t("workspace.management.storage.metrics.capacityDetail")
          : t("workspace.management.storage.metrics.capacityUsed", {
              value: formatBytes(metrics.usedBytes, locale)
            }),
      state: "neutral",
      Icon: Activity
    }
  ];
}

export function StorageHealthCharts({
  summary,
  locale,
  t
}: {
  summary: StorageSummary | null;
  locale: SupportedLocale;
  t: Translate;
}) {
  const metrics = summary?.metrics;
  const total = metrics?.totalBytes ?? null;
  const used = metrics?.usedBytes ?? null;
  const disks = metrics?.disks ?? 0;
  const smartPassed = metrics?.smartPassed ?? 0;
  const smartFailed = metrics?.smartFailed ?? 0;
  const reportedSmartUnknown = metrics?.smartUnknown ?? 0;
  const pools = summary?.pools ?? [];
  const readyPools = pools.filter((pool) => pool.status === "ready").length;
  const capacityRatio = total !== null && total > 0 && used !== null ? clampStorageRatio(used / total) : null;
  const capacityPercent = capacityRatio === null ? 0 : capacityRatio * 100;
  const capacityTone = usageGaugeTone(capacityRatio);
  const capacityData = [{
    name: t("workspace.management.storage.gauges.capacity"),
    value: capacityPercent,
    fill: storageHealthColor(capacityTone, "var(--accent-soft-text)")
  }];
  const smartTotal = Math.max(disks, smartPassed + smartFailed + reportedSmartUnknown);
  const smartUnknown = Math.max(reportedSmartUnknown, smartTotal - smartPassed - smartFailed);
  const smartRatio = smartTotal > 0 ? clampStorageRatio(smartPassed / smartTotal) : null;
  const smartTone: GaugeTone = smartTotal === 0
    ? "neutral"
    : smartFailed > 0
      ? "danger"
      : smartUnknown > 0
        ? "warning"
        : "ready";
  const poolTone: GaugeTone = pools.length === 0
    ? "neutral"
    : pools.some((pool) => pool.status === "offline")
      ? "danger"
      : readyPools === pools.length
        ? "ready"
        : "warning";
  const capacityDisplay = capacityRatio === null || used === null || total === null
    ? t("common.dash")
    : `${formatBytes(used, locale)} / ${formatBytes(total, locale)}`;
  const smartDisplay = `${formatLocaleNumber(smartPassed, locale)} / ${formatLocaleNumber(smartTotal, locale)}`;
  const poolDisplay = `${formatLocaleNumber(readyPools, locale)} / ${formatLocaleNumber(pools.length, locale)}`;

  return (
    <div className="storage-health-chart">
      <div className="storage-health-plot-grid">
        <article className="storage-health-plot storage-health-capacity" data-kind="capacity" data-state={capacityTone}>
          <header>
            <div><Database aria-hidden="true" size={17} /><span><strong>{t("workspace.management.storage.gauges.capacity")}</strong><small>{t("workspace.management.storage.gauges.capacityDetail")}</small></span></div>
            <em>{formatRatioPercent(capacityRatio, locale, t)}</em>
          </header>
          <div
            className="storage-health-capacity-ring"
            role="meter"
            aria-label={t("workspace.management.storage.healthCapacityChartLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={capacityRatio === null ? undefined : capacityPercent}
            aria-valuetext={capacityDisplay}
          >
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                data={capacityData}
                cx="50%"
                cy="50%"
                innerRadius="68%"
                outerRadius="92%"
                startAngle={90}
                endAngle={-270}
              >
                <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                <RadialBar
                  dataKey="value"
                  background={{ fill: "var(--surface)" }}
                  cornerRadius={6}
                  isAnimationActive={false}
                />
              </RadialBarChart>
            </ResponsiveContainer>
            <div className="storage-health-capacity-center">
              <strong>{capacityRatio === null ? t("common.dash") : formatBytes(used ?? 0, locale)}</strong>
              <span>{t("workspace.management.storage.capacityUsedLabel")}</span>
            </div>
          </div>
          <p>{capacityDisplay}</p>
        </article>

        <article className="storage-health-plot storage-health-smart" data-kind="smart" data-state={smartTone}>
          <header>
            <div><CircleCheck aria-hidden="true" size={17} /><span><strong>{t("workspace.management.storage.gauges.smart")}</strong><small>{t("workspace.management.storage.gauges.smartDetail")}</small></span></div>
            <em>{smartRatio === null ? t("common.dash") : formatRatioPercent(smartRatio, locale, t)}</em>
          </header>
          <div className="storage-health-smart-body">
            <div
              className="storage-health-smart-track"
              role="meter"
              aria-label={t("workspace.management.storage.healthSmartChartLabel")}
              aria-valuemin={0}
              aria-valuemax={Math.max(smartTotal, 1)}
              aria-valuenow={smartPassed}
              aria-valuetext={t("workspace.management.storage.healthSmartAria", { passed: smartPassed, failed: smartFailed, unknown: smartUnknown })}
            >
              <span data-state="passed" style={{ width: `${smartTotal ? (smartPassed / smartTotal) * 100 : 0}%` }} />
              <span data-state="failed" style={{ width: `${smartTotal ? (smartFailed / smartTotal) * 100 : 0}%` }} />
              <span data-state="unknown" style={{ width: `${smartTotal ? (smartUnknown / smartTotal) * 100 : 0}%` }} />
            </div>
            <div className="storage-health-smart-value"><strong>{smartDisplay}</strong><span>{t("workspace.management.storage.gauges.smart")}</span></div>
            <ul className="storage-health-legend">
              <li data-state="passed"><i />{t("workspace.management.storage.smart.passed")} <strong>{formatLocaleNumber(smartPassed, locale)}</strong></li>
              <li data-state="failed"><i />{t("workspace.management.storage.smart.failed")} <strong>{formatLocaleNumber(smartFailed, locale)}</strong></li>
              <li data-state="unknown"><i />{t("workspace.management.storage.smart.unknown")} <strong>{formatLocaleNumber(smartUnknown, locale)}</strong></li>
            </ul>
          </div>
        </article>

        <article className="storage-health-plot storage-health-pools" data-kind="pools" data-state={poolTone}>
          <header>
            <div><HardDrive aria-hidden="true" size={17} /><span><strong>{t("workspace.management.storage.gauges.pools")}</strong><small>{t("workspace.management.storage.gauges.poolsDetail")}</small></span></div>
            <em>{poolDisplay}</em>
          </header>
          <div className="storage-health-pools-body">
            <div className="storage-health-pool-value"><strong>{formatLocaleNumber(readyPools, locale)}</strong><span>{t("workspace.management.storage.healthReadyOf", { total: pools.length })}</span></div>
            {pools.length ? (
              <div className="storage-health-pool-track" role="list" aria-label={t("workspace.management.storage.healthPoolsChartLabel")}>
                {pools.map((pool) => {
                  const label = `${pool.name}: ${storagePoolStatusLabel(pool, t)}`;
                  return <span key={pool.id} role="listitem" data-state={storagePoolTone(pool)} aria-label={label} title={label} />;
                })}
              </div>
            ) : <div className="storage-health-pool-empty">{t("workspace.management.storage.noPools")}</div>}
          </div>
        </article>
      </div>
    </div>
  );
}

function clampStorageRatio(value: number): number {
  return Math.max(0, Math.min(value, 1));
}

function storageHealthColor(tone: GaugeTone, readyColor = "var(--success-text)"): string {
  if (tone === "danger") {
    return "var(--danger-text)";
  }
  if (tone === "warning") {
    return "var(--warning-text)";
  }
  if (tone === "ready") {
    return readyColor;
  }
  return "var(--neutral-status-text)";
}

function networkStatusDetail(
  summary: NetworkSummary | null,
  loading: boolean,
  error: string | null,
  t: Translate
): string {
  if (loading) {
    return t("workspace.management.network.loading");
  }
  if (error) {
    return t("workspace.management.network.unavailableDetail");
  }
  if (summary?.status === "partial") {
    return t("workspace.management.network.partialDetail");
  }
  if (summary?.status === "unavailable") {
    return t("workspace.management.network.unavailableDetail");
  }
  return t("workspace.management.network.readyDetail");
}

function storageStatusDetail(
  summary: StorageSummary | null,
  loading: boolean,
  error: string | null,
  t: Translate
): string {
  if (loading) {
    return t("workspace.management.storage.loading");
  }
  if (error) {
    return t("workspace.management.storage.unavailableDetail");
  }
  if (summary?.status === "partial") {
    return t("workspace.management.storage.partialDetail");
  }
  if (summary?.status === "unavailable") {
    return t("workspace.management.storage.unavailableDetail");
  }
  return t("workspace.management.storage.readyDetail");
}

function systemStatusLabel(
  status: NetworkSummary["status"] | StorageSummary["status"],
  loading: boolean,
  error: string | null,
  t: Translate
): string {
  if (loading) {
    return t("common.states.loading");
  }
  if (error || status === "unavailable") {
    return t("common.states.unavailable");
  }
  if (status === "partial") {
    return t("workspace.management.states.attention");
  }
  return t("workspace.management.states.ready");
}

function systemStatusTone(
  status: NetworkSummary["status"] | StorageSummary["status"],
  loading: boolean,
  error: string | null
): StatusTone {
  if (loading) {
    return "neutral";
  }
  if (error || status === "unavailable") {
    return "offline";
  }
  if (status === "partial") {
    return "warning";
  }
  return "ready";
}

function networkInterfaceTone(networkInterface: NetworkInterface): StatusTone {
  if (networkInterface.state === "connected") {
    return "ready";
  }
  if (networkInterface.state === "up") {
    return "warning";
  }
  if (networkInterface.state === "down") {
    return "offline";
  }
  return "neutral";
}

function networkInterfaceStateLabel(
  networkInterface: NetworkInterface,
  t: Translate
): string {
  return t(`workspace.management.network.states.${networkInterface.state}`);
}

function formatAddresses(networkInterface: NetworkInterface): string {
  return networkInterface.addresses.map((address) => address.cidr ?? address.address).join(", ") || "-";
}

function formatSpeed(speedMbps: number | null, locale: SupportedLocale, t: Translate): string {
  if (speedMbps === null) {
    return t("common.dash");
  }
  if (speedMbps >= 1000) {
    return `${formatLocaleNumber(speedMbps / 1000, locale, { maximumFractionDigits: 1 })} Gbps`;
  }
  return `${formatLocaleNumber(speedMbps, locale)} Mbps`;
}

function formatNetworkTrafficRate(value: number | null, locale: SupportedLocale, t: Translate): string {
  return value === null ? t("common.dash") : `${formatBytes(Math.max(0, value), locale)}/s`;
}

function formatNullableNumber(value: number | null | undefined, locale: SupportedLocale, t: Translate): string {
  return typeof value !== "number" ? t("common.dash") : formatLocaleNumber(value, locale);
}

function formatNullableBytes(value: number | null | undefined, locale: SupportedLocale, t: Translate): string {
  return typeof value !== "number" ? t("common.dash") : formatBytes(value, locale);
}

function formatRatioPercent(value: number | null, locale: SupportedLocale, t: Translate): string {
  return value === null ? t("common.dash") : `${formatLocaleNumber(value * 100, locale, { maximumFractionDigits: 1 })}%`;
}

function storagePoolTone(pool: StoragePool): StatusTone {
  if (pool.status === "ready") {
    return "ready";
  }
  if (pool.status === "warning") {
    return "warning";
  }
  if (pool.status === "offline") {
    return "offline";
  }
  return "neutral";
}

function storagePoolStatusLabel(pool: StoragePool, t: Translate): string {
  if (pool.status === "ready") {
    return t("workspace.management.states.ready");
  }
  if (pool.status === "warning") {
    return t("workspace.management.states.attention");
  }
  if (pool.status === "offline") {
    return t("workspace.management.states.offline");
  }
  return t("common.states.unknown");
}

function formatStorageUsage(pool: StoragePool, locale: SupportedLocale, t: Translate): string {
  if (pool.totalBytes === null || pool.usedBytes === null) {
    return t("common.dash");
  }
  return `${formatBytes(pool.usedBytes, locale)} / ${formatBytes(pool.totalBytes, locale)} (${formatRatioPercent(pool.usedPercent, locale, t)})`;
}

function smartGaugeTone(health: StorageDisk["smart"]["health"]): GaugeTone {
  if (health === "passed") {
    return "ready";
  }
  if (health === "failed" || health === "error") {
    return "danger";
  }
  return "neutral";
}

function smartHealthLabel(health: StorageDisk["smart"]["health"], t: Translate): string {
  return t(`workspace.management.storage.smart.${health}`);
}

function diskCapacityUsage(disk: StorageDisk, summary: StorageSummary): DiskCapacityUsage {
  const devicePaths = new Set([disk.path, ...disk.partitions.map((partition) => partition.path)]);
  const pool = summary.pools.find((candidate) => (
    candidate.memberDevices.some((device) => devicePaths.has(device) || diskOwnsDevicePath(disk.path, device))
  )) ?? null;

  if (pool) {
    const ratio = pool.totalBytes !== null && pool.totalBytes > 0 && pool.usedBytes !== null
        ? clampStorageRatio(pool.usedBytes / pool.totalBytes)
        : pool.usedPercent;
    const totalBytes = disk.sizeBytes;
    const usedBytes = totalBytes !== null && ratio !== null ? Math.round(totalBytes * ratio) : null;
    return {
      totalBytes,
      usedBytes,
      availableBytes: totalBytes !== null && usedBytes !== null ? Math.max(totalBytes - usedBytes, 0) : null,
      ratio,
      pool,
      mountTargets: pool.mountpoint ? [pool.mountpoint] : []
    };
  }

  const mountsBySource = new Map(
    summary.mounts
      .filter((mount) => devicePaths.has(mount.source))
      .map((mount) => [mount.source, mount] as const)
  );
  const mounts = [...mountsBySource.values()];
  const measuredUsed = sumPresent(mounts.map((mount) => mount.usedBytes));
  const measuredTotal = sumPresent(mounts.map((mount) => mount.totalBytes));
  const totalBytes = disk.sizeBytes ?? measuredTotal;
  const ratio = totalBytes !== null && totalBytes > 0 && measuredUsed !== null
    ? clampStorageRatio(measuredUsed / totalBytes)
    : null;

  return {
    totalBytes,
    usedBytes: measuredUsed,
    availableBytes: totalBytes !== null && measuredUsed !== null ? Math.max(totalBytes - measuredUsed, 0) : null,
    ratio,
    pool: null,
    mountTargets: mounts.map((mount) => mount.target)
  };
}

function diskOwnsDevicePath(diskPath: string, devicePath: string): boolean {
  if (!devicePath.startsWith(diskPath)) {
    return false;
  }
  const suffix = devicePath.slice(diskPath.length);
  return /^\d+$/u.test(suffix) || /^p\d+$/u.test(suffix);
}

function sumPresent(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}

function diskCapacitySource(usage: DiskCapacityUsage, t: Translate): string {
  if (usage.pool) {
    return t("workspace.management.storage.diskCapacityPoolSource", { name: usage.pool.name });
  }
  if (usage.mountTargets.length) {
    return t("workspace.management.storage.diskCapacityMountSource", { targets: usage.mountTargets.join(", ") });
  }
  return t("workspace.management.storage.diskCapacityUnavailable");
}

function storageMediaLabel(disk: StorageDisk, t: Translate): string {
  if (disk.rotational === true) {
    return t("workspace.management.storage.diskMedia.hdd");
  }
  if (disk.rotational === false) {
    return t("workspace.management.storage.diskMedia.ssd");
  }
  return t("common.states.unknown");
}

function formatBoolean(value: boolean | null | undefined, t: Translate): string {
  if (typeof value !== "boolean") {
    return t("common.dash");
  }
  return value ? t("common.yes") : t("common.no");
}

function formatTemperature(value: number | null | undefined, locale: SupportedLocale, t: Translate): string {
  return typeof value !== "number"
    ? t("common.dash")
    : t("workspace.management.storage.diskMeta.temperature", { value: formatLocaleNumber(value, locale) });
}

function formatHours(value: number | null | undefined, locale: SupportedLocale, t: Translate): string {
  return typeof value !== "number"
    ? t("common.dash")
    : t("workspace.management.storage.diskMeta.powerOn", { value: formatLocaleNumber(value, locale) });
}

function formatPercentValue(value: number | null | undefined, locale: SupportedLocale, t: Translate): string {
  return typeof value !== "number" ? t("common.dash") : `${formatLocaleNumber(value, locale, { maximumFractionDigits: 1 })}%`;
}

function formatCapacityPercent(value: number, locale: SupportedLocale): string {
  if (value > 0 && value < 0.1) {
    return "<0.1%";
  }
  return `${formatLocaleNumber(value, locale, { maximumFractionDigits: 1 })}%`;
}

function usageGaugeTone(value: number | null): GaugeTone {
  if (value === null) {
    return "neutral";
  }
  if (value >= 0.85) {
    return "danger";
  }
  if (value >= 0.65) {
    return "warning";
  }
  return "ready";
}

function ratioGauge(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function storageValidationIssueText(issue: StoragePoolValidationIssue, t: Translate): string {
  if (issue.code === "missingName") {
    return t("workspace.management.storage.validation.missingName");
  }
  if (issue.code === "invalidName") {
    return t("workspace.management.storage.validation.invalidName");
  }
  if (issue.code === "noDevices") {
    return t("workspace.management.storage.validation.noDevices");
  }
  if (issue.code === "tooFewDevices") {
    return t("workspace.management.storage.validation.tooFewDevices", { count: issue.minimum ?? 0 });
  }
  if (issue.code === "oddRaid10") {
    return t("workspace.management.storage.validation.oddRaid10");
  }
  if (issue.code === "unavailableDevice") {
    return t("workspace.management.storage.validation.unavailableDevice");
  }
  return t("workspace.management.storage.validation.inventoryIncomplete");
}

function storageDiskAvailabilityLabel(
  availability: ReturnType<typeof storageDiskAvailability>,
  t: Translate
): string {
  return t(`workspace.management.storage.diskStates.${availability}`);
}

function statusIcon(state: StatusTone) {
  if (state === "ready") {
    return <CircleCheck aria-hidden="true" size={17} data-state={state} />;
  }
  if (state === "warning") {
    return <CircleAlert aria-hidden="true" size={17} data-state={state} />;
  }
  return <HardDrive aria-hidden="true" size={17} data-state={state} />;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifySummaryIssues(
  issues: Array<{ source: string; message: string }>,
  notificationMessage: string,
  onNotifyError: (message: string | null) => void,
  reportedIssueSignature: { current: string | null }
): void {
  const signature = issues.map((issue) => `${issue.source}:${issue.message}`).join("\u0000");
  if (!signature) {
    reportedIssueSignature.current = null;
    return;
  }
  if (reportedIssueSignature.current === signature) {
    return;
  }
  reportedIssueSignature.current = signature;
  onNotifyError(notificationMessage);
}

function systemDiagnosticTitle(
  error: string | null,
  issues: Array<{ source: string; message: string }> | undefined
): string | undefined {
  if (error) {
    return error;
  }

  const detail = issues
    ?.slice(0, 3)
    .map((issue) => `${issue.source}: ${issue.message}`)
    .join(" · ");
  return detail || undefined;
}
