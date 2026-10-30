import { ModalPortal } from "../common/ModalPortal.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileMeta, TextPreview } from "../../api.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { PreviewContent, previewIcon } from "../preview/PreviewContent.js";
import { useModalDialog } from "./useModalDialog.js";

const CLOSE_DURATION_MS = 140;

export function FilePreviewDialog({
  title,
  meta,
  loading,
  error,
  textPreview,
  blobUrl,
  videoUrl,
  storagePoolId,
  previewFileSizeLimitBytes,
  locale,
  actions,
  footer,
  onOpenWorkspacePath,
  onClose
}: {
  title: string;
  meta: FileMeta | null;
  loading: boolean;
  error: string | null;
  textPreview: TextPreview | null;
  blobUrl: string;
  videoUrl: string;
  storagePoolId: string;
  previewFileSizeLimitBytes: number;
  locale: SupportedLocale;
  actions?: ReactNode;
  footer?: ReactNode;
  onOpenWorkspacePath: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function requestClose() {
    if (closing) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = setTimeout(onClose, CLOSE_DURATION_MS);
  }

  const dialogRef = useModalDialog(requestClose, closing);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  return (
    <ModalPortal
      className="file-preview-backdrop"
      data-state={closing ? "closing" : "open"}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="file-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-preview-title"
        aria-busy={loading || undefined}
        tabIndex={-1}
      >
        <header className="file-preview-header">
          <div className="file-preview-title">
            <span className="eyebrow">{t("workspace.preview")}</span>
            <h2 id="file-preview-title" title={title}>{title || t("workspace.selectFile")}</h2>
          </div>
          <div className="file-preview-actions">
            {meta ? (
              <span className="preview-kind">
                {previewIcon(meta.previewKind)}
                {t(`preview.kind.${meta.previewKind}`)}
              </span>
            ) : null}
            {actions}
            <button
              type="button"
              className="preview-tool-button"
              onClick={requestClose}
              disabled={closing}
              title={t("common.actions.close")}
              aria-label={t("common.actions.close")}
            >
              <X aria-hidden="true" size={15} />
            </button>
          </div>
        </header>
        <div className="file-preview-content">
          <PreviewContent
            blobUrl={blobUrl}
            videoUrl={videoUrl}
            storagePoolId={storagePoolId}
            loading={loading}
            meta={meta}
            error={error}
            textPreview={textPreview}
            previewFileSizeLimitBytes={previewFileSizeLimitBytes}
            locale={locale}
            onOpenWorkspacePath={onOpenWorkspacePath}
          />
          {footer}
        </div>
      </section>
    </ModalPortal>
  );
}
