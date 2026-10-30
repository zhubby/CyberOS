import { ModalPortal } from "../common/ModalPortal.js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { IscsiAction, IscsiImage, IscsiSummary, IscsiTarget } from "@cyberos/shared";
import { CircleAlert, Database, HardDrive, LoaderCircle, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import { applyIscsiAction, getIscsiSummary } from "../../api.js";
import { ISCSI_REFRESH_EVENT, iscsiGiBToBytes, parseIscsiInitiators, validateIscsiTarget, type IscsiTargetForm } from "../../config/iscsi.js";
import { formatBytes } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { Switch } from "../common/Switch.js";
import { useModalDialog } from "./useModalDialog.js";

const KEY = "workspace.management.storage.iscsi";
type Mutation = IscsiAction extends infer Action ? Action extends IscsiAction ? Omit<Action, "confirmed" | "expectedRevision"> : never : never;
type Apply = (action: Mutation) => Promise<boolean>;
type Modal = { kind: "create" } | { kind: "target"; id: string } | { kind: "image"; id: string };

function useIscsiText() {
  const { t } = useTranslation();
  const translate = t as (key: string, options?: Record<string, unknown>) => string;
  return (key: string, options?: Record<string, unknown>) => translate(`${KEY}.${key}`, options);
}

export function IscsiManagementCard({ locale, onNotifySuccess, onWorkQueuesChanged }: {
  locale: SupportedLocale;
  onNotifySuccess: (message: string | null) => void;
  onWorkQueuesChanged: () => void | Promise<void>;
}) {
  const text = useIscsiText();
  const [summary, setSummary] = useState<IscsiSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const modalRef = useRef<Modal | null>(null);
  const busyRef = useRef(false);
  const modalRevision = useRef("");
  modalRef.current = modal;

  const refresh = useCallback(async (background = false) => {
    if (busyRef.current || modalRef.current) return;
    const current = ++sequence.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    if (!background) setLoading(true);
    try {
      const next = await getIscsiSummary(request.signal);
      if (!mounted.current || current !== sequence.current) return;
      setSummary(next);
      setError(null);
    } catch (nextError) {
      if (!mounted.current || request.signal.aborted || current !== sequence.current) return;
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const update = () => { if (document.visibilityState === "visible") void refresh(true); };
    const timer = window.setInterval(update, 10_000);
    window.addEventListener(ISCSI_REFRESH_EVENT, update);
    document.addEventListener("visibilitychange", update);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      controller.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener(ISCSI_REFRESH_EVENT, update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);

  function open(next: Modal) {
    if (!summary || busyRef.current) return;
    ++sequence.current;
    controller.current?.abort();
    setLoading(false);
    modalRevision.current = summary.revision;
    modalRef.current = next;
    setModalError(null);
    setModal(next);
  }

  function close() {
    if (busyRef.current) return;
    modalRef.current = null;
    setModal(null);
    setModalError(null);
    void refresh(true);
  }

  async function refreshDetails() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const current = ++sequence.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    try {
      const next = await getIscsiSummary(request.signal);
      if (mounted.current && current === sequence.current) {
        setSummary(next);
        modalRevision.current = next.revision;
        setModalError(null);
      }
    } catch (nextError) {
      if (mounted.current && !request.signal.aborted) setModalError(nextError instanceof Error ? nextError.message : text("loadError"));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const apply: Apply = async (action) => {
    if (busyRef.current || !summary?.available) return false;
    busyRef.current = true;
    setBusy(true);
    setModalError(null);
    ++sequence.current;
    controller.current?.abort();
    try {
      const next = await applyIscsiAction({ ...action, confirmed: true, expectedRevision: modalRevision.current });
      if (!mounted.current) return false;
      setSummary(next);
      modalRevision.current = next.revision;
      onNotifySuccess(text("operationComplete"));
      void Promise.resolve().then(onWorkQueuesChanged).catch(() => undefined);
      return true;
    } catch (nextError) {
      if (mounted.current) setModalError(nextError instanceof Error ? nextError.message : text("staleError"));
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const target = modal?.kind === "target" ? summary?.targets.find((item) => item.id === modal.id) : undefined;
  const image = modal?.kind === "image" ? summary?.images.find((item) => item.id === modal.id) : undefined;
  return <section className="management-section iscsi-card" aria-label={text("title")} aria-busy={busy || loading || undefined}>
    <header className="management-section-header">
      <div><h3><Server aria-hidden="true" size={16} /> {text("title")}</h3><p>{text("description")}</p></div>
      <div className="iscsi-actions">
        <button type="button" className="icon-button" title={text("refresh")} aria-label={text("refresh")} disabled={loading || busy} onClick={() => void refresh()}>{loading ? <LoaderCircle className="is-spinning" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}</button>
        <button type="button" className="primary-button" disabled={!summary?.available || loading || busy} onClick={() => open({ kind: "create" })}><Plus size={15} aria-hidden="true" />{text("createTarget")}</button>
      </div>
    </header>
    <div className="iscsi-card-body">
      {loading && !summary ? <p className="management-empty" role="status">{text("loading")}</p> : null}
      {error ? <p className="iscsi-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{text("loadError")} {error}</p> : null}
      {summary ? <>
        <div className="iscsi-summary"><span className="management-status-pill" data-state={summary.available ? "ready" : "warning"}>{text(summary.available ? "ready" : "unavailable")}</span><span>{summary.targets.length} {text("targets")}</span><span>{summary.targets.reduce((count, item) => count + item.luns.length, 0)} {text("luns")}</span><span>{text("sessionCount", { count: summary.targets.reduce((count, item) => count + item.sessions.length, 0) })}</span></div>
        {summary.error ? <p className="iscsi-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{summary.error}</p> : null}
        <IscsiInventory summary={summary} busy={busy} locale={locale} onSelectTarget={(id) => open({ kind: "target", id })} onSelectImage={(id) => open({ kind: "image", id })} />
      </> : null}
    </div>
    {modal && summary ? <IscsiDialog title={modal.kind === "create" ? text("createTarget") : target?.name ?? image?.name ?? text("title")} busy={busy} error={modalError} onClose={close}>
      {modal.kind === "create" ? <TargetForm summary={summary} busy={busy} onCancel={close} onSave={async (input) => { if (await apply(input)) close(); }} /> : null}
      {target ? <TargetDetails key={target.id} target={target} summary={summary} busy={busy} locale={locale} apply={apply} onClose={close} onRefresh={() => void refreshDetails()} /> : null}
      {image ? <RetainedImageDetails key={image.id} image={image} summary={summary} busy={busy} locale={locale} apply={apply} onClose={close} /> : null}
    </IscsiDialog> : null}
  </section>;
}

export function IscsiInventory({ summary, busy, locale, onSelectTarget, onSelectImage }: {
  summary: IscsiSummary; busy: boolean; locale: SupportedLocale;
  onSelectTarget: (id: string) => void; onSelectImage: (id: string) => void;
}) {
  const text = useIscsiText();
  const retained = summary.images.filter((image) => image.attachedTargetId === null);
  return <>
    <div className="iscsi-target-list">{summary.targets.length ? summary.targets.map((target) => <article className="iscsi-target-row" key={target.id}>
      <Server size={18} aria-hidden="true" />
      <div className="iscsi-target-identity"><button type="button" className="storage-pool-name-button" onClick={() => onSelectTarget(target.id)} disabled={busy} aria-label={text("details", { name: target.name })}>{target.name}</button><code>{target.iqn}</code><small>{target.address.includes(":") ? `[${target.address}]:${target.port}` : `${target.address}:${target.port}`}</small></div>
      <div className="iscsi-target-state"><span className="management-status-pill" data-state={target.status === "running" ? "ready" : target.status === "degraded" ? "warning" : "neutral"}>{text(target.status)}</span><small>{target.luns.length} {text("luns")} · {text("sessionCount", { count: target.sessions.length })}</small></div>
    </article>) : <p className="management-empty">{text("noTargets")}</p>}</div>
    <div className="iscsi-retained"><h4><HardDrive size={15} aria-hidden="true" />{text("retained")}</h4>{retained.length ? retained.map((image) => <article className="iscsi-image-row" key={image.id}><div><strong>{image.name}</strong><small>{image.storagePoolId} · {formatBytes(image.sizeBytes, locale)}</small></div><button type="button" className="secondary-button" onClick={() => onSelectImage(image.id)} disabled={busy || !summary.available}>{text("attach")} / {text("destroyImage")}</button></article>) : <p className="management-empty">{text("noRetained")}</p>}</div>
  </>;
}

function IscsiDialog({ title, busy, error, onClose, children }: { title: string; busy: boolean; error: string | null; onClose: () => void; children: ReactNode }) {
  const text = useIscsiText();
  const ref = useModalDialog(onClose, busy);
  return <ModalPortal className="management-modal-backdrop iscsi-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={ref} tabIndex={-1} className="management-modal iscsi-dialog" role="dialog" aria-modal="true" aria-labelledby="iscsi-dialog-title" aria-busy={busy || undefined}>
      <header><div><span className="eyebrow">iSCSI</span><h3 id="iscsi-dialog-title">{title}</h3></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label={text("close")}><X size={18} aria-hidden="true" /></button></header>
      {error ? <div className="iscsi-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{text("retry")}</button></div> : null}
      <div className="iscsi-dialog-body">{children}</div>
    </section>
  </ModalPortal>;
}

function TargetForm({ target, summary, busy, onSave, onCancel }: { target?: IscsiTarget; summary: IscsiSummary; busy: boolean; onSave: (input: Mutation) => void | Promise<void>; onCancel: () => void }) {
  const text = useIscsiText();
  const [form, setForm] = useState<IscsiTargetForm>(() => ({ name: target?.name ?? "", address: target?.address ?? "", port: String(target?.port ?? 3260), initiators: target?.initiators.join("\n") ?? "", chapEnabled: target?.chapEnabled ?? true, username: target?.chapUsername ?? "", password: "" }));
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<IscsiTargetForm>) => setForm((current) => ({ ...current, ...patch }));
  const addresses = summary.listenAddresses;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const issue = validateIscsiTarget(form, addresses, Boolean(target?.credentialConfigured));
    if (issue) { setError(text(`validation.${issue}`)); return; }
    const input = { name: form.name.trim(), address: form.address, port: Number(form.port), initiators: parseIscsiInitiators(form.initiators), chap: { enabled: form.chapEnabled, username: form.username, ...(form.password ? { password: form.password } : {}) } };
    await onSave(target ? { action: "update_target", targetId: target.id, ...input } : { action: "create_target", ...input, enabled: true });
  }
  return <form className="iscsi-form" onSubmit={(event) => void submit(event)}>
    <fieldset disabled={busy || !summary.available}>
      <div className="iscsi-form-grid">
        <Field label={text("name")}><input value={form.name} maxLength={64} onChange={(event) => update({ name: event.target.value })} required /></Field>
        <Field label={text("address")}><select value={form.address} onChange={(event) => update({ address: event.target.value })} required><option value="">{text("selectAddress")}</option>{addresses.map((address) => <option key={address} value={address}>{address}</option>)}{form.address && !addresses.includes(form.address) ? <option value={form.address} disabled>{form.address}</option> : null}</select></Field>
        <Field label={text("port")}><input inputMode="numeric" value={form.port} onChange={(event) => update({ port: event.target.value })} required /></Field>
        <Field label={text("initiators")} wide><textarea value={form.initiators} onChange={(event) => update({ initiators: event.target.value })} rows={3} required /><small>{text("initiatorsHint")}</small></Field>
      </div>
      <Switch label={text("chap")} checked={form.chapEnabled} onCheckedChange={(chapEnabled) => update({ chapEnabled })} />
      {form.chapEnabled ? <div className="iscsi-form-grid"><Field label={text("username")}><input autoComplete="off" value={form.username} maxLength={128} onChange={(event) => update({ username: event.target.value })} required /></Field><Field label={text("password")}><input type="password" autoComplete="new-password" value={form.password} maxLength={16} minLength={12} onChange={(event) => update({ password: event.target.value })} required={!target?.credentialConfigured} /><small>{text(target?.credentialConfigured ? "keepPassword" : "passwordHint")}</small></Field></div> : null}
    </fieldset>
    {error ? <p className="iscsi-error" role="alert">{error}</p> : null}
    <footer className="iscsi-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{text("cancel")}</button><button type="submit" className="primary-button" disabled={busy || !summary.available}>{busy ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : null}{text("save")}</button></footer>
  </form>;
}

function TargetDetails({ target, summary, busy, locale, apply, onClose, onRefresh }: { target: IscsiTarget; summary: IscsiSummary; busy: boolean; locale: SupportedLocale; apply: Apply; onClose: () => void; onRefresh: () => void }) {
  const text = useIscsiText();
  const [view, setView] = useState<"details" | "edit" | "create" | "attach" | "delete">("details");
  const [removeImage, setRemoveImage] = useState<IscsiImage | null>(null);
  const locked = busy || !summary.available || target.sessions.length > 0;
  if (removeImage) return <RemovalForm name={removeImage.name} title={text("removeLun")} busy={busy} available={!locked} onCancel={() => setRemoveImage(null)} onConfirm={async (destroy, confirmation) => { if (await apply({ action: "detach_lun", targetId: target.id, imageId: removeImage.id, destroyImage: destroy, confirmation })) setRemoveImage(null); }} />;
  if (view === "edit") return <TargetForm target={target} summary={summary} busy={busy} onCancel={() => setView("details")} onSave={async (action) => { if (await apply(action)) setView("details"); }} />;
  if (view === "create") return <CreateLunForm targetId={target.id} summary={summary} busy={busy} locale={locale} onCancel={() => setView("details")} apply={async (action) => { const ok = await apply(action); if (ok) setView("details"); return ok; }} />;
  if (view === "attach") return <AttachForm targetId={target.id} summary={summary} busy={busy} onCancel={() => setView("details")} apply={async (action) => { const ok = await apply(action); if (ok) setView("details"); return ok; }} />;
  if (view === "delete") return <RemovalForm name={target.name} title={text("deleteTarget")} target busy={busy} available={!locked} onCancel={() => setView("details")} onConfirm={async (destroy, confirmation) => { if (await apply({ action: "delete_target", targetId: target.id, destroyImages: destroy, confirmation })) onClose(); }} />;
  return <div className="iscsi-detail">
    <dl className="iscsi-connection"><div><dt>{text("iqn")}</dt><dd><code>{target.iqn}</code></dd></div><div><dt>{text("address")}</dt><dd><code>{target.address.includes(":") ? `[${target.address}]:${target.port}` : `${target.address}:${target.port}`}</code></dd></div><div><dt>{text("chap")}</dt><dd>{text(target.chapEnabled ? "enabled" : "disabled")}</dd></div></dl>
    <div className="iscsi-actions"><Switch label={text("enabled")} checked={target.enabled} disabled={locked} onCheckedChange={(enabled) => void apply({ action: "set_target_enabled", targetId: target.id, enabled })} /><button type="button" className="secondary-button" disabled={locked} onClick={() => setView("edit")}>{text("editTarget")}</button><button type="button" className="danger-button" disabled={locked} onClick={() => setView("delete")}><Trash2 size={14} aria-hidden="true" />{text("deleteTarget")}</button><button type="button" className="icon-button" disabled={busy} onClick={onRefresh} aria-label={text("refresh")} title={text("refresh")}><RefreshCw size={15} aria-hidden="true" /></button></div>
    {target.sessions.length ? <p className="iscsi-warning"><CircleAlert size={16} aria-hidden="true" />{text("connectedWarning")}</p> : null}
    {target.error ? <p className="iscsi-error" role="alert">{target.error}</p> : null}
    <section><header className="iscsi-subheading"><h4>{text("luns")}</h4><div className="iscsi-actions"><button type="button" className="secondary-button" disabled={locked} onClick={() => setView("create")}><Plus size={14} aria-hidden="true" />{text("addLun")}</button><button type="button" className="secondary-button" disabled={locked || !summary.images.some((image) => image.attachedTargetId === null)} onClick={() => setView("attach")}>{text("attach")}</button></div></header>
      {target.luns.length ? target.luns.map((lun) => { const image = summary.images.find((item) => item.id === lun.imageId); return <article className="iscsi-image-row" key={lun.imageId}><Database size={15} aria-hidden="true" /><div><strong>{image?.name ?? lun.imageId}</strong><small>LUN {lun.lun} · {image?.storagePoolId} · {image ? formatBytes(image.sizeBytes, locale) : "—"}</small></div><button type="button" className="secondary-button" disabled={locked || !image} onClick={() => image && setRemoveImage(image)}>{text("removeLun")}</button></article>; }) : <p className="management-empty">{text("noLuns")}</p>}
    </section>
    <section><h4>{text("sessions")}</h4>{target.sessions.length ? <ul className="iscsi-session-list">{target.sessions.map((session, index) => <li key={`${session.initiator}-${index}`}><code>{session.initiator}</code><span>{session.address ?? "—"}</span></li>)}</ul> : <p className="management-empty">{text("noSessions")}</p>}</section>
    <section><h4>{text("initiators")}</h4><ul className="iscsi-session-list">{target.initiators.map((iqn) => <li key={iqn}><code>{iqn}</code></li>)}</ul></section>
  </div>;
}

function CreateLunForm({ targetId, summary, busy, locale, apply, onCancel }: { targetId: string; summary: IscsiSummary; busy: boolean; locale: SupportedLocale; apply: Apply; onCancel: () => void }) {
  const text = useIscsiText();
  const [name, setName] = useState("");
  const [poolId, setPoolId] = useState("");
  const [size, setSize] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const pool = summary.pools.find((item) => item.id === poolId && item.ready);
    const sizeBytes = iscsiGiBToBytes(size);
    if (!name.trim() || name.trim().length > 64 || [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) { setError(text("validation.name")); return; }
    if (!pool) { setError(text("validation.pool")); return; }
    if (sizeBytes === null || pool.availableBytes === null || sizeBytes > pool.availableBytes) { setError(text("validation.capacity")); return; }
    await apply({ action: "create_lun", targetId, name: name.trim(), storagePoolId: poolId, sizeBytes });
  }
  return <form className="iscsi-form" onSubmit={(event) => void submit(event)}><h4>{text("addLun")}</h4><fieldset disabled={busy}><div className="iscsi-form-grid"><Field label={text("name")}><input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} required /></Field><Field label={text("storagePool")}><select value={poolId} onChange={(event) => setPoolId(event.target.value)} required><option value="">{text("selectPool")}</option>{summary.pools.filter((pool) => pool.ready && pool.availableBytes !== null).map((pool) => <option key={pool.id} value={pool.id}>{pool.name} · {text("free", { size: formatBytes(pool.availableBytes ?? 0, locale) })}</option>)}</select></Field><Field label={text("size")}><input inputMode="numeric" pattern="[1-9][0-9]*" value={size} onChange={(event) => setSize(event.target.value)} required /><small>{text("capacityHint")}</small></Field></div></fieldset><p className="iscsi-warning">{text("backupHint")}</p>{error ? <p className="iscsi-error" role="alert">{error}</p> : null}<footer className="iscsi-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{text("back")}</button><button type="submit" className="primary-button" disabled={busy || !summary.available}>{busy ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : null}{text("addLun")}</button></footer></form>;
}

function AttachForm({ targetId, imageId, summary, busy, apply, onCancel }: { targetId?: string; imageId?: string; summary: IscsiSummary; busy: boolean; apply: Apply; onCancel: () => void }) {
  const text = useIscsiText();
  const [selectedTarget, setTarget] = useState(targetId ?? "");
  const [selectedImage, setImage] = useState(imageId ?? "");
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const target = summary.targets.find((item) => item.id === selectedTarget);
    if (!target || target.sessions.length) { setError(text("validation.target")); return; }
    if (!summary.images.some((item) => item.id === selectedImage && item.attachedTargetId === null)) { setError(text("validation.image")); return; }
    await apply({ action: "attach_lun", targetId: selectedTarget, imageId: selectedImage });
  }
  return <form className="iscsi-form" onSubmit={(event) => void submit(event)}><h4>{text("attach")}</h4><fieldset disabled={busy}><div className="iscsi-form-grid">{!targetId ? <Field label={text("targets")}><select value={selectedTarget} onChange={(event) => setTarget(event.target.value)} required><option value="">{text("selectTarget")}</option>{summary.targets.filter((item) => item.sessions.length === 0).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field> : null}{!imageId ? <Field label={text("retained")}><select value={selectedImage} onChange={(event) => setImage(event.target.value)} required><option value="">{text("selectImage")}</option>{summary.images.filter((item) => item.attachedTargetId === null).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.storagePoolId}</option>)}</select></Field> : null}</div></fieldset>{error ? <p className="iscsi-error" role="alert">{error}</p> : null}<footer className="iscsi-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{text("back")}</button><button type="submit" className="primary-button" disabled={busy || !summary.available}>{text("attach")}</button></footer></form>;
}

function RemovalForm({ name, title, target = false, destroyOnly = false, busy, available, onConfirm, onCancel }: { name: string; title: string; target?: boolean; destroyOnly?: boolean; busy: boolean; available: boolean; onConfirm: (destroy: boolean, confirmation: string) => void | Promise<void>; onCancel: () => void }) {
  const text = useIscsiText();
  const [destroy, setDestroy] = useState(destroyOnly);
  const [confirmation, setConfirmation] = useState("");
  return <form className="iscsi-form" onSubmit={(event) => { event.preventDefault(); if (confirmation.trim() === name) void onConfirm(destroy, confirmation.trim()); }}><h4>{title}</h4><p>{text(destroy ? "destroyWarning" : "keepImages")}</p><fieldset disabled={busy || !available}>{!destroyOnly ? <label className="iscsi-confirmation"><input type="checkbox" checked={destroy} onChange={(event) => setDestroy(event.target.checked)} />{text(target ? "destroyAll" : "destroyAlso")}</label> : null}<Field label={text("confirmName", { name })}><input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></Field></fieldset><footer className="iscsi-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{text("back")}</button><button type="submit" className="danger-button" disabled={busy || !available || confirmation.trim() !== name}>{busy ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}{text("confirm")}</button></footer></form>;
}

function RetainedImageDetails({ image, summary, busy, locale, apply, onClose }: { image: IscsiImage; summary: IscsiSummary; busy: boolean; locale: SupportedLocale; apply: Apply; onClose: () => void }) {
  const text = useIscsiText();
  const [destroy, setDestroy] = useState(false);
  if (destroy) return <RemovalForm name={image.name} title={text("destroyImage")} destroyOnly busy={busy} available={summary.available} onCancel={() => setDestroy(false)} onConfirm={async (_destroy, confirmation) => { if (await apply({ action: "destroy_image", imageId: image.id, confirmation })) onClose(); }} />;
  return <><dl className="iscsi-connection"><div><dt>{text("storagePool")}</dt><dd>{image.storagePoolId}</dd></div><div><dt>{text("size")}</dt><dd>{formatBytes(image.sizeBytes, locale)}</dd></div></dl><AttachForm imageId={image.id} summary={summary} busy={busy} onCancel={onClose} apply={async (action) => { const ok = await apply(action); if (ok) onClose(); return ok; }} /><div className="iscsi-actions"><button type="button" className="danger-button" disabled={busy || !summary.available} onClick={() => setDestroy(true)}><Trash2 size={15} aria-hidden="true" />{text("destroyImage")}</button></div></>;
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={`iscsi-field${wide ? " is-wide" : ""}`}><span>{label}</span>{children}</label>;
}
