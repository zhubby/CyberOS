import { useEffect, useRef, useState, type FormEvent } from "react";
import { AudioLines, Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { normalizeCyberAudioBaseUrl } from "@cyberos/shared";
import { getAudioSettings, updateAudioSettings } from "../../api.js";
import { HelpLabel } from "../common/HelpTip.js";
import { PanelContentSkeleton } from "../workspace/ManagementSkeleton.js";

export function SettingsAudioPage({ onNotifySuccess }: { onNotifySuccess: (message: string) => void }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"loadFailed" | "saveFailed" | "invalidAddress" | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getAudioSettings().then((settings) => {
      if (!active) return;
      setAddress(settings.cyberAudioBaseUrl ?? "");
      setLoaded(true);
    }).catch(() => {
      if (active) setError("loadFailed");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadAttempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loaded || savingRef.current) return;
    let cyberAudioBaseUrl: string | null;
    try {
      cyberAudioBaseUrl = normalizeCyberAudioBaseUrl(address);
    } catch {
      setError("invalidAddress");
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const settings = await updateAudioSettings({ cyberAudioBaseUrl });
      if (!mountedRef.current) return;
      setAddress(settings.cyberAudioBaseUrl ?? "");
      onNotifySuccess(t("settings.audio.saved"));
    } catch {
      if (mountedRef.current) setError("saveFailed");
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  if (loading) return <div className="settings-content-body" aria-busy="true"><PanelContentSkeleton /></div>;

  return (
    <form className="settings-content-body" onSubmit={save}>
      {error ? <p id="audio-settings-error" className="settings-inline-error" role="alert">{t(`settings.audio.${error}`)}</p> : null}
      {!loaded ? (
        <button type="button" className="secondary-button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
          {t("common.actions.refresh")}
        </button>
      ) : (
        <div className="settings-page-grid">
          <section className="settings-section-card settings-field-wide">
            <header><div><h3>CyberAudio</h3></div><AudioLines size={18} aria-hidden="true" /></header>
            <div className="settings-field-grid">
              <div className="settings-field-wide">
                <HelpLabel htmlFor="cyberaudio-base-url" label={t("settings.audio.serviceAddress")} content={t("settings.audio.addressHint")} />
                <input
                  id="cyberaudio-base-url"
                  type="url"
                  value={address}
                  maxLength={2048}
                  placeholder="https://audio.example.com:8443"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  aria-invalid={error === "invalidAddress" || undefined}
                  aria-describedby={error === "invalidAddress" ? "audio-settings-error" : undefined}
                  onChange={(event) => { setAddress(event.target.value); setError(null); }}
                />
              </div>
            </div>
            <div className="settings-card-actions">
              <button type="submit" className="primary-button" disabled={busy} aria-busy={busy || undefined}>
                {busy ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
                {t(busy ? "common.actions.saving" : "common.actions.saveChanges")}
              </button>
            </div>
          </section>
        </div>
      )}
    </form>
  );
}
