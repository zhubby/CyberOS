import { useEffect, useState, type FormEvent } from "react";
import { Check, LoaderCircle, Network } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getSystemProxySettings, updateSystemProxySettings, type SystemProxyProtocol } from "../../api.js";
import { PanelContentSkeleton } from "../workspace/ManagementSkeleton.js";
import { CustomSelect } from "../common/CustomSelect.js";

export function SettingsProxyPage({ onNotifySuccess }: { onNotifySuccess: (message: string) => void }) {
  const { t } = useTranslation();
  const [protocol, setProtocol] = useState<SystemProxyProtocol>("http");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getSystemProxySettings().then((settings) => {
      if (!active) return;
      setProtocol(settings.protocol);
      setHost(settings.host ?? "");
      setPort(settings.port === null ? "" : String(settings.port));
    }).catch((nextError: unknown) => {
      if (active) setError(nextError instanceof Error ? nextError.message : String(nextError));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const settings = await updateSystemProxySettings({ protocol, host: host.trim(), port: Number(port) });
      setProtocol(settings.protocol);
      setHost(settings.host ?? "");
      setPort(settings.port === null ? "" : String(settings.port));
      setError(null);
      onNotifySuccess(t("settings.proxy.saved"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="settings-content-body"><PanelContentSkeleton /></div>;
  return (
    <form className="settings-content-body" onSubmit={save}>
      {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
      <div className="settings-page-grid">
        <section className="settings-section-card settings-field-wide">
          <header><div><h3>{t("settings.proxy.title")}</h3><p>{t("settings.proxy.description")}</p></div><Network size={18} aria-hidden="true" /></header>
          <fieldset className="settings-field-grid" disabled={busy}>
            <label><span>{t("settings.proxy.protocol")}</span><CustomSelect<SystemProxyProtocol> value={protocol} disabled={busy} ariaLabel={t("settings.proxy.protocol")} options={[{ value: "http", label: "HTTP" }, { value: "https", label: "HTTPS" }, { value: "socks5", label: "SOCKS5" }]} onChange={setProtocol} /></label>
            <label><span>{t("settings.proxy.host")}</span><input required maxLength={253} value={host} placeholder="192.168.1.2" autoComplete="off" spellCheck={false} onChange={(event) => setHost(event.target.value)} /></label>
            <label><span>{t("settings.proxy.port")}</span><input required type="number" inputMode="numeric" min={1} max={65535} step={1} value={port} onChange={(event) => setPort(event.target.value)} /></label>
          </fieldset>
          <p className="settings-field-help">{t("settings.proxy.addressHint")}</p>
          <div className="settings-card-actions"><button type="submit" className="primary-button" disabled={busy} aria-busy={busy || undefined}>{busy ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{t(busy ? "common.actions.saving" : "common.actions.saveChanges")}</button></div>
        </section>
      </div>
    </form>
  );
}
