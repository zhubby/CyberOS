import { useTranslation } from "react-i18next";
import type { BluetoothAudioDevice } from "../../api.js";
import { CustomSelect } from "../common/CustomSelect.js";

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
    <CustomSelect
      ariaLabel={t("music.output")}
      value={value ?? ""}
      disabled={disabled}
      onChange={(deviceId) => onChange(deviceId || null)}
      options={[
        { value: "", label: defaultLabel },
        ...(value && !devices.some((device) => device.id === value)
          ? [{ value, label: t("music.unavailableOutput"), disabled: true }]
          : []),
        ...devices.map((device) => ({
          value: device.id,
          label: `${device.name}${device.connected ? "" : ` · ${t("music.disconnected")}`}`,
          disabled: !device.connected,
        })),
      ]}
    />
  );
}
