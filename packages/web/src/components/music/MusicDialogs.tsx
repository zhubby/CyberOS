import { ModalPortal } from "../common/ModalPortal.js";
import { useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useModalDialog } from "../workspace/useModalDialog.js";

export function MusicDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useModalDialog(onClose);
  return (
    <ModalPortal
      className="management-dialog-backdrop music-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={ref}
        className="music-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header>
          <h2>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.actions.close")}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {children}
      </section>
    </ModalPortal>
  );
}

export function MusicNameDialog({
  title,
  initial = "",
  onClose,
  onSubmit,
}: {
  title: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <MusicDialog title={title} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label className="music-field">
          {t("music.name")}
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            required
          />
        </label>
        {error ? (
          <p role="alert" className="music-error">
            {error}
          </p>
        ) : null}
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>
            {t("common.actions.cancel")}
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !name.trim()}
            aria-busy={busy}
          >
            {t("common.actions.save")}
          </button>
        </footer>
      </form>
    </MusicDialog>
  );
}
