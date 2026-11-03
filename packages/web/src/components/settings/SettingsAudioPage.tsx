import { useEffect, useRef, useState, type FormEvent } from "react";
import { AudioLines, Check, LoaderCircle, Mic, RefreshCw, RotateCcw, Square, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { normalizeCyberAudioBaseUrl, type AudioSettingsPatch } from "@cyberos/shared";
import {
  getAudioSettings, updateAudioSettings, getAudioDevices, getAudioStatus, testAudioService,
  testAudioRecording, testAudioSpeech, stopAudioSpeech, resetAudioContext,
  type AudioSettings, type AudioStatus, type AudioDevice, type AudioServiceStatus
} from "../../api.js";
import { HelpLabel } from "../common/HelpTip.js";
import { PanelContentSkeleton } from "../workspace/ManagementSkeleton.js";
import { Switch } from "../common/Switch.js";
import { CustomSelect } from "../common/CustomSelect.js";

export function audioSettingsPatch(settings: AudioSettings, token: string, clear: boolean): AudioSettingsPatch {
  const { tokenConfigured: _configured, updatedAt: _updated, ...fields } = settings;
  return { ...fields, ...(token.trim() ? { cyberAudioToken: token.trim() } : clear ? { cyberAudioToken: null } : {}) };
}

export function AudioDiagnostics({ service }: { service: AudioServiceStatus | null }) {
  const { t } = useTranslation();
  const state = (ready: boolean | undefined) => t(`settings.audio.${ready === undefined ? "untested" : ready ? "ready" : "notReady"}`);
  return <>
    <dl className="settings-summary-list" aria-live="polite">
      <div><dt>{t("settings.audio.reachable")}</dt><dd>{state(service?.reachable)}</dd></div>
      <div><dt>{t("settings.audio.authenticated")}</dt><dd>{state(service?.authenticated)}</dd></div>
      <div><dt>STT</dt><dd>{state(service?.sttReady)}</dd></div>
      <div><dt>TTS</dt><dd>{state(service?.ttsReady)}</dd></div>
    </dl>
    {service?.error ? <p className="settings-inline-error" role="alert">{service.error}</p> : null}
  </>;
}

export function SettingsAudioPage({ onNotifySuccess, onOpenVoiceSession }: {
  onNotifySuccess: (message: string) => void;
  onOpenVoiceSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AudioSettings | null>(null);
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>({ inputs: [], outputs: [] });
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [service, setService] = useState<AudioServiceStatus | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const operation = useRef(false);
  const mounted = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void getAudioSettings().then((next) => {
      if (active) { setSettings(next); setDirty(false); setError(null); }
    }).catch(() => { if (active) setError(t("settings.audio.loadFailed")); })
      .finally(() => { if (active) setLoading(false); });
    void getAudioDevices().then((next) => { if (active) setDevices(next); }).catch(() => {});
    return () => { active = false; };
  }, [loadAttempt, t]);
  useEffect(() => {
    let active = true;
    let polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try { const next = await getAudioStatus(); if (active) setStatus(next); }
      catch { if (active) setStatus(null); }
      finally { polling = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  function change(patch: Partial<AudioSettings>) {
    setSettings((current) => current ? { ...current, ...patch } : current);
    setDirty(true); setError(null);
  }
  async function action(name: string, execute: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(name); setError(null);
    try { await execute(); }
    catch { if (mounted.current) setError(t(name === "save" ? "settings.audio.saveFailed" : "settings.audio.testFailed")); }
    finally { operation.current = false; if (mounted.current) setBusy(null); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    let address: string | null;
    try { address = normalizeCyberAudioBaseUrl(settings.cyberAudioBaseUrl); }
    catch { setError(t("settings.audio.invalidAddress")); return; }
    await action("save", async () => {
      const next = await updateAudioSettings(audioSettingsPatch({ ...settings, cyberAudioBaseUrl: address }, token, clearToken));
      if (!mounted.current) return;
      setSettings(next); setToken(""); setClearToken(false); setDirty(false);
      onNotifySuccess(t("settings.audio.saved"));
    });
  }
  const deviceOptions = (list: AudioDevice[], selected: string | null) => [
    { value: "", label: t("settings.audio.selectDevice") },
    ...list.map((device) => ({ value: device.id, label: `${device.name}${device.connected ? "" : ` · ${t("settings.audio.offline")}`}` })),
    ...(selected && !list.some((device) => device.id === selected) ? [{ value: selected, label: `${selected} · ${t("settings.audio.offline")}`, disabled: true }] : [])
  ];
  const languages = [{ value: "auto" as const, label: t("settings.audio.autoLanguage") }, { value: "zh" as const, label: "中文" }, { value: "en" as const, label: "English" }];
  const testDisabled = Boolean(busy) || dirty;
  if (loading) return <div className="settings-content-body" aria-busy="true"><PanelContentSkeleton /></div>;
  if (!settings) return <div className="settings-content-body"><p className="settings-inline-error" role="alert">{error}</p><button type="button" className="secondary-button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{t("common.actions.refresh")}</button></div>;

  return <form className="settings-content-body audio-settings" onSubmit={save}>
    {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
    <div className="settings-page-grid">
      <section className="settings-section-card settings-field-wide">
        <header><h3>CyberAudio</h3><AudioLines size={18} aria-hidden="true" /></header>
        <div className="settings-field-grid">
          <div className="settings-field-wide"><HelpLabel htmlFor="cyberaudio-base-url" label={t("settings.audio.serviceAddress")} content={t("settings.audio.addressHint")} />
            <input id="cyberaudio-base-url" type="url" value={settings.cyberAudioBaseUrl ?? ""} maxLength={2048} placeholder="https://audio.example.com:8443" autoComplete="off" spellCheck={false} disabled={Boolean(busy)} onChange={(event) => change({ cyberAudioBaseUrl: event.target.value })} />
          </div>
          <div><label htmlFor="cyberaudio-token">{t("settings.audio.token")}</label><input id="cyberaudio-token" type="password" value={token} maxLength={4096} autoComplete="new-password" placeholder={t(settings.tokenConfigured ? "settings.audio.tokenConfigured" : "settings.audio.tokenMissing")} disabled={Boolean(busy)} onChange={(event) => { setToken(event.target.value); setClearToken(false); setDirty(true); }} /></div>
          <div className="settings-card-actions"><button type="button" className="secondary-button" disabled={Boolean(busy) || !settings.tokenConfigured} onClick={() => { setClearToken(true); setToken(""); setDirty(true); }}>{t(clearToken ? "settings.audio.tokenWillClear" : "settings.audio.clearToken")}</button></div>
        </div>
        <AudioDiagnostics service={service} />
        <div className="settings-card-actions"><button type="button" className="secondary-button" disabled={testDisabled} aria-busy={busy === "service" || undefined} onClick={() => void action("service", async () => { const result = await testAudioService(); if (mounted.current) setService(result); })}>{busy === "service" ? <LoaderCircle size={15} className="is-spinning" /> : <RefreshCw size={15} />}{t("settings.audio.testService")}</button></div>
      </section>
      <section className="settings-section-card settings-field-wide">
        <header><h3>{t("settings.audio.voiceInput")}</h3><Mic size={18} aria-hidden="true" /></header>
        <Switch checked={settings.enabled} disabled={Boolean(busy)} onCheckedChange={(enabled) => change({ enabled })} label={t("settings.audio.enabled")} description={t("settings.audio.inputHint")} />
        <div className="settings-field-grid">
          <div><label htmlFor="audio-input">{t("settings.audio.inputDevice")}</label><CustomSelect id="audio-input" value={settings.inputDeviceId ?? ""} options={deviceOptions(devices.inputs, settings.inputDeviceId)} onChange={(value) => change({ inputDeviceId: value || null })} disabled={Boolean(busy)} /></div>
          <div><label htmlFor="audio-max-seconds">{t("settings.audio.maxSeconds")}</label><input id="audio-max-seconds" type="number" min={1} max={30} value={settings.maxRecordingSeconds} disabled={Boolean(busy)} onChange={(event) => change({ maxRecordingSeconds: Number(event.target.value) })} /></div>
        </div>
        <dl className="settings-summary-list"><div><dt>{t("settings.audio.deviceState")}</dt><dd>{t(status?.daemon.connected ? "settings.audio.ready" : "settings.audio.offline")}</dd></div><div><dt>{t("settings.audio.protocol")}</dt><dd>{status?.daemon.protocol ?? t("settings.audio.untested")}</dd></div></dl>
        <div className="settings-card-actions">
          <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void action("devices", async () => { const result = await getAudioDevices(); if (mounted.current) setDevices(result); })}>{t("settings.audio.refreshDevices")}</button>
          <button type="button" className="secondary-button" disabled={testDisabled || status?.test.armed} onClick={() => void action("recording", async () => { await testAudioRecording(); })}>{t(status?.test.armed ? "settings.audio.waitingRecording" : "settings.audio.testRecording")}</button>
        </div>
        <p className="settings-help">{t("settings.audio.recordingHint")}</p>
        {status?.test.transcript ? <output className="audio-test-result" aria-live="polite">{status.test.transcript}</output> : null}
        {status?.test.error ? <p className="settings-inline-error" role="alert">{status.test.error}</p> : null}
      </section>
      <section className="settings-section-card settings-field-wide">
        <header><h3>STT / TTS</h3></header>
        <div className="settings-field-grid">
          <div><label htmlFor="audio-stt-language">{t("settings.audio.sttLanguage")}</label><CustomSelect id="audio-stt-language" value={settings.sttLanguage} options={languages} onChange={(value) => change({ sttLanguage: value })} disabled={Boolean(busy)} /></div>
          <div><label htmlFor="audio-tts-language">{t("settings.audio.ttsLanguage")}</label><CustomSelect id="audio-tts-language" value={settings.ttsLanguage} options={languages} onChange={(value) => change({ ttsLanguage: value })} disabled={Boolean(busy)} /></div>
          <div><label htmlFor="audio-voice">{t("settings.audio.voice")}</label><CustomSelect id="audio-voice" value={settings.ttsVoice} options={[...new Set([settings.ttsVoice, ...(service?.voices ?? [])])].map((voice) => ({ value: voice, label: voice }))} onChange={(value) => change({ ttsVoice: value })} disabled={Boolean(busy)} /></div>
          <div><label htmlFor="audio-instructions">{t("settings.audio.instructions")}</label><input id="audio-instructions" value={settings.ttsInstructions} maxLength={200} disabled={Boolean(busy)} onChange={(event) => change({ ttsInstructions: event.target.value })} /></div>
        </div>
        <Switch checked={settings.speechEnabled} disabled={Boolean(busy)} onCheckedChange={(speechEnabled) => change({ speechEnabled })} label={t("settings.audio.speechEnabled")} />
      </section>
      <section className="settings-section-card settings-field-wide">
        <header><h3>{t("settings.audio.output")}</h3><Volume2 size={18} aria-hidden="true" /></header>
        <div className="settings-field-grid">
          <div><label htmlFor="audio-output">{t("settings.audio.outputDevice")}</label><CustomSelect id="audio-output" value={settings.outputDeviceId ?? ""} options={deviceOptions(devices.outputs, settings.outputDeviceId)} onChange={(value) => change({ outputDeviceId: value || null })} disabled={Boolean(busy)} /></div>
          <div><label htmlFor="audio-volume">{t("settings.audio.volume")} · {settings.volume}%</label><input id="audio-volume" type="range" min={0} max={100} value={settings.volume} disabled={Boolean(busy)} onChange={(event) => change({ volume: Number(event.target.value) })} /></div>
        </div>
        <p className="settings-help">{t("settings.audio.outputHint")}</p>
        <div className="settings-card-actions"><button type="button" className="secondary-button" disabled={testDisabled} aria-busy={busy === "speech" || undefined} onClick={() => void action("speech", async () => { await testAudioSpeech(); if (mounted.current) onNotifySuccess(t("settings.audio.speechTestDone")); })}>{busy === "speech" ? <LoaderCircle size={15} className="is-spinning" /> : <Volume2 size={15} />}{t("settings.audio.testSpeech")}</button><button type="button" className="secondary-button" onClick={() => void stopAudioSpeech().catch(() => { if (mounted.current) setError(t("settings.audio.testFailed")); })}><Square size={15} />{t("settings.audio.stopSpeech")}</button></div>
      </section>
      <section className="settings-section-card settings-field-wide">
        <header><h3>{t("settings.audio.voiceSession")}</h3></header>
        <p className="settings-help">{t(status?.awaitingApproval ? "settings.audio.approvalHint" : "settings.audio.sessionHint")}</p>
        <div className="settings-card-actions"><button type="button" className="secondary-button" disabled={!status?.sessionId || !onOpenVoiceSession} onClick={() => { if (status?.sessionId) onOpenVoiceSession?.(status.sessionId); }}>{t("settings.audio.openHistory")}</button><button type="button" className="secondary-button" disabled={Boolean(busy) || !status?.sessionId} onClick={() => setConfirmReset(true)}><RotateCcw size={15} />{t("settings.audio.resetContext")}</button></div>
        {confirmReset ? <div><p>{t("settings.audio.resetHint")}</p><div className="settings-card-actions"><button type="button" className="danger-button" disabled={Boolean(busy)} onClick={() => void action("reset", async () => { await resetAudioContext(); if (mounted.current) { setConfirmReset(false); onNotifySuccess(t("settings.audio.contextReset")); } })}>{t("settings.audio.confirmReset")}</button><button type="button" className="secondary-button" onClick={() => setConfirmReset(false)}>{t("common.actions.cancel")}</button></div></div> : null}
        <dl className="settings-summary-list" aria-live="polite">{status?.turns.slice(0, 4).map((turn) => <div key={turn.recordingId}><dt>{turn.recordingId.slice(-8)}</dt><dd>{t(`settings.audio.stages.${turn.status}`)}<small>{Object.entries(turn.timings).map(([stage, milliseconds]) => `${stage} ${milliseconds} ms`).join(" · ")}</small>{turn.error ? <span className="settings-inline-error">{turn.error}</span> : null}</dd></div>)}</dl>
        {status?.error || status?.daemon.error ? <p className="settings-inline-error" role="status">{status.error ?? status.daemon.error}</p> : null}
      </section>
    </div>
    {dirty ? <p className="settings-help">{t("settings.audio.saveBeforeTest")}</p> : null}
    <div className="settings-card-actions"><button type="submit" className="primary-button" disabled={Boolean(busy) || !dirty} aria-busy={busy === "save" || undefined}>{busy === "save" ? <LoaderCircle size={15} className="is-spinning" /> : <Check size={15} />}{t("common.actions.save")}</button></div>
  </form>;
}
