import {
  Bluetooth, BluetoothConnected, BluetoothOff, Gamepad2, Headphones, Laptop, Link,
  LoaderCircle, Send, Shield, ShieldOff, Smartphone, Speaker, Unplug, type LucideIcon
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BluetoothStatus } from "../../api.js";

export type BluetoothDevice = BluetoothStatus["devices"][number];
export type BluetoothDeviceAction = "pair" | "trust" | "connect" | "disconnect" | "send" | "forget";

export function BluetoothDeviceList({ devices, busyKey, disabled, onAction }: {
  devices: BluetoothDevice[];
  busyKey: string | null;
  disabled: boolean;
  onAction: (action: BluetoothDeviceAction, device: BluetoothDevice) => void;
}) {
  const { t } = useTranslation();
  return <div className="bluetooth-device-list">{devices.map((device) => {
    const connecting = busyKey === `connect-${device.address}`;
    const actions: { action: BluetoothDeviceAction; label: string; icon: LucideIcon; danger?: boolean }[] = [];
    if (!device.paired) actions.push({ action: "pair", label: t("settings.bluetooth.pair"), icon: Link });
    if (device.paired || device.trusted) actions.push({ action: "trust", label: device.trusted ? t("settings.bluetooth.untrust") : t("settings.bluetooth.trust"), icon: device.trusted ? ShieldOff : Shield });
    if (device.paired || device.connected) actions.push({ action: device.connected ? "disconnect" : "connect", label: device.connected ? t("settings.bluetooth.disconnect") : t("settings.bluetooth.connect"), icon: device.connected ? BluetoothOff : BluetoothConnected });
    if (device.paired) actions.push({ action: "send", label: t("settings.bluetooth.transfers.sendFiles"), icon: Send });
    if (device.paired || device.trusted) actions.push({ action: "forget", label: t("settings.bluetooth.forget"), icon: Unplug, danger: true });
    return <article key={`${device.adapterId}:${device.address}`} className="bluetooth-device-row" aria-busy={busyKey?.endsWith(device.address) || undefined}>
      <div className="bluetooth-device-icon">{deviceIcon(device.type)}</div>
      <div className="bluetooth-device-copy">
        <strong>{device.alias ?? device.name ?? device.address}</strong>
        <small>{device.address}{device.rssi === null ? "" : ` · ${device.rssi} dBm`}</small>
        <div className="bluetooth-device-badges">
          {device.paired ? <span>{t("settings.bluetooth.paired")}</span> : null}
          {device.trusted ? <span>{t("settings.bluetooth.trusted")}</span> : null}
          {connecting ? <span role="status">{t("settings.bluetooth.connecting")}</span> : device.connected ? <span className="is-ready">{t("settings.bluetooth.connected")}</span> : null}
        </div>
      </div>
      <div className="bluetooth-device-actions">{actions.map(({ action, label, icon: Icon, danger }) => <button
        key={action}
        type="button"
        className={`management-icon-action bluetooth-device-action${danger ? " is-danger" : ""}`}
        data-tooltip={label}
        aria-label={label}
        disabled={disabled || busyKey !== null}
        onClick={() => onAction(action, device)}
      >{busyKey === `${action}-${device.address}` ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <Icon aria-hidden="true" size={16} />}</button>)}</div>
    </article>;
  })}</div>;
}

function deviceIcon(type: BluetoothDevice["type"]) {
  if (type === "phone") return <Smartphone aria-hidden="true" size={19} />;
  if (type === "computer") return <Laptop aria-hidden="true" size={19} />;
  if (type === "speaker") return <Speaker aria-hidden="true" size={19} />;
  if (type === "headset") return <Headphones aria-hidden="true" size={19} />;
  if (type === "gamepad") return <Gamepad2 aria-hidden="true" size={19} />;
  return <Bluetooth aria-hidden="true" size={19} />;
}
