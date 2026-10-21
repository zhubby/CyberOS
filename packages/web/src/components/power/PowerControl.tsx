import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, LoaderCircle, Power, RotateCw, X } from "lucide-react";
import type { SystemPowerAction } from "../../api.js";

export function PowerControl({
  onRequest
}: {
  onRequest: (action: SystemPowerAction) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<SystemPowerAction | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        const frame = window.requestAnimationFrame(() => triggerRef.current?.focus());
        wasOpenRef.current = false;
        return () => window.cancelAnimationFrame(frame);
      }
      return;
    }

    wasOpenRef.current = true;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (busy) return;
        event.preventDefault();
        if (action) setAction(null);
        else close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      ) ?? [])].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [action, busy, open]);

  function close() {
    if (busy) return;
    setOpen(false);
    setAction(null);
  }

  async function confirm() {
    if (!action || busy) return;
    setBusy(true);
    try {
      const accepted = await onRequest(action);
      if (accepted) {
        setOpen(false);
        setAction(null);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="agent-power-button"
        type="button"
        onClick={() => setOpen(true)}
        title={t("power.open")}
        aria-label={t("power.open")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Power aria-hidden="true" size={18} />
      </button>
      {open ? (
        <PowerDialog
          dialogRef={dialogRef}
          action={action}
          busy={busy}
          onSelect={setAction}
          onBack={() => setAction(null)}
          onClose={close}
          onConfirm={() => void confirm()}
        />
      ) : null}
    </>
  );
}

export function PowerDialog({
  dialogRef,
  action,
  busy,
  onSelect,
  onBack,
  onClose,
  onConfirm
}: {
  dialogRef: RefObject<HTMLElement | null>;
  action: SystemPowerAction | null;
  busy: boolean;
  onSelect: (action: SystemPowerAction) => void;
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const titleId = action ? `power-confirm-${action}-title` : "power-menu-title";
  const descriptionId = action ? `power-confirm-${action}-description` : "power-menu-description";

  return (
    <div
      className="power-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !action && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="power-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <header className="power-dialog-header">
          <div>
            <span className="eyebrow">{t(action ? "power.confirmEyebrow" : "power.menuEyebrow")}</span>
            <h2 id={titleId}>
              {action ? t(`power.confirm.${action}.title`) : t("power.menuTitle")}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            title={t("common.actions.close")}
            aria-label={t("common.actions.close")}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        {action ? (
          <>
            <div className="power-dialog-warning" role="alert">
              <AlertTriangle aria-hidden="true" size={19} />
              <div>
                <p id={descriptionId}>{t(`power.confirm.${action}.body`)}</p>
                <span>{t("power.confirm.safetyNote")}</span>
              </div>
            </div>
            <footer>
              <button type="button" className="secondary-button" onClick={onBack} disabled={busy}>
                {t("power.back")}
              </button>
              <button
                type="button"
                className="danger-button power-confirm-button"
                onClick={onConfirm}
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {busy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : action === "reboot" ? (
                  <RotateCw aria-hidden="true" size={16} />
                ) : (
                  <Power aria-hidden="true" size={16} />
                )}
                <span>{t(busy ? `power.requesting.${action}` : `power.confirm.${action}.action`)}</span>
              </button>
            </footer>
          </>
        ) : (
          <>
            <p id={descriptionId} className="power-dialog-copy">{t("power.menuBody")}</p>
            <div className="power-action-list">
              <button type="button" className="power-action-option" data-action="reboot" onClick={() => onSelect("reboot")}>
                <RotateCw aria-hidden="true" size={20} />
                <span>
                  <strong>{t("power.reboot")}</strong>
                  <small>{t("power.rebootDescription")}</small>
                </span>
              </button>
              <button type="button" className="power-action-option" data-action="shutdown" onClick={() => onSelect("shutdown")}>
                <Power aria-hidden="true" size={20} />
                <span>
                  <strong>{t("power.shutdown")}</strong>
                  <small>{t("power.shutdownDescription")}</small>
                </span>
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
