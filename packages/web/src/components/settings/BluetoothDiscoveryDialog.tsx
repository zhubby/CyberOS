import { useId, type ReactNode } from "react";
import { Bluetooth, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ModalPortal } from "../common/ModalPortal.js";
import { useModalDialog } from "../workspace/useModalDialog.js";
import { BluetoothDeviceList, type BluetoothDevice, type BluetoothDeviceAction } from "./BluetoothDeviceList.js";

export function BluetoothDiscoveryDialog({ devices, busyKey, scanning, disabled, challenge, error, onScan, onClose, onAction }: {
  devices: BluetoothDevice[];
  busyKey: string | null;
  scanning: boolean;
  disabled: boolean;
  challenge: ReactNode;
  error: string | null;
  onScan: () => void;
  onClose: () => void;
  onAction: (action: BluetoothDeviceAction, device: BluetoothDevice) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useModalDialog(onClose);
  return <ModalPortal className="management-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="management-modal bluetooth-discovery-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><div><h2 id={titleId}>{t("settings.bluetooth.discoveryTitle")}</h2><p>{t("settings.bluetooth.discoveryDescription")}</p></div><button type="button" className="management-icon-action bluetooth-device-action" aria-label={t("common.actions.close")} title={t("common.actions.close")} onClick={onClose}><X aria-hidden="true" size={17} /></button></header>
      <div className="bluetooth-discovery-body">
        {error ? <div className="settings-device-unavailable" role="alert"><Bluetooth aria-hidden="true" size={18} /><p>{error}</p></div> : null}
        {challenge}
        <div className="bluetooth-discovery-toolbar"><span role="status">{scanning ? t("settings.bluetooth.scanning") : t("settings.bluetooth.scanFinished")}</span><button type="button" aria-busy={busyKey?.startsWith("scan") || undefined} disabled={disabled || busyKey !== null} onClick={onScan}>{busyKey?.startsWith("scan") ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : scanning ? <X aria-hidden="true" size={15} /> : <RefreshCw aria-hidden="true" size={15} />}<span>{scanning ? t("settings.bluetooth.stopScan") : t("settings.bluetooth.scanDuration")}</span></button></div>
        {devices.length ? <BluetoothDeviceList devices={devices} busyKey={busyKey} disabled={disabled} onAction={onAction} /> : <p className="management-empty">{scanning ? t("settings.bluetooth.scanning") : t("settings.bluetooth.noDevices")}</p>}
      </div>
    </section>
  </ModalPortal>;
}
