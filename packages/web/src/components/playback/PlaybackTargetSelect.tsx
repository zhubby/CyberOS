import { useTranslation } from "react-i18next";
import { CustomSelect } from "../common/CustomSelect.js";
import { usePlayback } from "./PlaybackProvider.js";

export function PlaybackTargetSelect({ onChange }: { onChange?: () => void }) {
  const p = usePlayback();
  const { t } = useTranslation();
  return <CustomSelect<"browser" | "nas">
    value={p.target === "browser" && p.browser ? "browser" : "nas"}
    ariaLabel={t("playback.controlTarget")}
    options={[
      ...(p.browser ? [{ value: "browser" as const, label: t("playback.browser") }] : []),
      { value: "nas", label: `NAS · ${t(p.nas?.owner === "video" ? "video.title" : "workspace.panels.music")}` },
    ]}
    onChange={(target) => { p.setTarget(target); onChange?.(); }}
  />;
}
