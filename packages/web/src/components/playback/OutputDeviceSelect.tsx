import { useTranslation } from "react-i18next";
import type { BluetoothAudioDevice } from "../../api.js";

export function OutputDeviceSelect({
  value,
  devices,
  defaultLabel,
  disabled = false,
  onChange,
}: {
  value: string | null;
  devices: BluetoothAudioDevice[];
  defaultLabel: string;
  disabled?: boolean;
  onChange: (deviceId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      aria-label={t("music.output")}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{defaultLabel}</option>
      {value && !devices.some((device) => device.id === value) ? (
        <option value={value} disabled>
          {t("music.unavailableOutput")}
        </option>
      ) : null}
      {devices.map((device) => (
        <option key={device.id} value={device.id} disabled={!device.connected}>
          {device.name}
          {device.connected ? "" : ` · ${t("music.disconnected")}`}
        </option>
      ))}
    </select>
  );
}
