import type { NetworkSummary, WifiStatus } from "../../api.js";
import { useTranslation } from "react-i18next";
import { SystemWifiManagement } from "../workspace/SystemWifiManagement.js";

export function SettingsWirelessPage({
  network,
  onStatus,
  onRefresh,
  onNotifySuccess,
  onNotifyError
}: {
  network: NetworkSummary | null;
  onStatus: (status: WifiStatus) => void;
  onRefresh: () => Promise<void>;
  onNotifySuccess: (message: string) => void;
  onNotifyError: (message: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-content-body settings-device-page">
      {network ? (
        <SystemWifiManagement
          wifi={network.wifi}
          canManageWifi={network.capabilities.canManageWifi}
          canManageHotspot={network.capabilities.canManageHotspot}
          onStatus={onStatus}
          onRefresh={onRefresh}
          onNotifySuccess={onNotifySuccess}
          onNotifyError={onNotifyError}
        />
      ) : (
        <p className="management-empty">{t("settings.wireless.statusUnavailable")}</p>
      )}
    </div>
  );
}
