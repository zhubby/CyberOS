import { useEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore, Check, Clock3, FolderInput, FolderPlus, FolderUp, LoaderCircle, RotateCcw, Square, Trash2, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileBatch, FileOperation } from "../../api.js";
import { formatBytes } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { isUploadBatchActive, type UploadBatchState } from "../../lib/uploads.js";

export function ActivityMenu({
  operations,
  fileBatches,
  operationsReady,
  uploadBatches,
  locale,
  onCancelUploadBatch,
  onCancelFileBatch,
  onRollback
}: {
  operations: FileOperation[];
  fileBatches: FileBatch[];
  operationsReady: boolean;
  uploadBatches: UploadBatchState[];
  locale: SupportedLocale;
  onCancelUploadBatch: (batchId: string) => void;
  onCancelFileBatch: (jobId: string) => void;
  onRollback: (operation: FileOperation) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [lastSeenOperationId, setLastSeenOperationId] = useState<string | null>(null);
  const hasBaseline = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const visibleOperations = useMemo(() => operations.slice(0, 8), [operations]);
  const visibleFileBatches = useMemo(
    () => [...fileBatches]
      .sort((left, right) => {
        const leftActive = left.status === "queued" || left.status === "running" ? 0 : 1;
        const rightActive = right.status === "queued" || right.status === "running" ? 0 : 1;
        return leftActive - rightActive || right.createdAt.localeCompare(left.createdAt);
      })
      .slice(0, 8),
    [fileBatches]
  );
  const visibleUploadBatches = useMemo(
    () =>
      [...uploadBatches].sort((left, right) => {
        const leftActive = isUploadBatchActive(left) ? 0 : 1;
        const rightActive = isUploadBatchActive(right) ? 0 : 1;
        if (leftActive !== rightActive) {
          return leftActive - rightActive;
        }
        return right.createdAt.localeCompare(left.createdAt);
      }),
    [uploadBatches]
  );
  const latestOperationId = operations[0]?.id ?? null;
  const hasNewActivity = Boolean(
    operationsReady && latestOperationId && hasBaseline.current && latestOperationId !== lastSeenOperationId && !open
  );
  const hasUploadActivity = visibleUploadBatches.some((batch) => isUploadBatchActive(batch));
  const hasFileBatchActivity = visibleFileBatches.some((batch) => batch.status === "queued" || batch.status === "running");

  useEffect(() => {
    if (!operationsReady) {
      return;
    }
    if (!hasBaseline.current) {
      hasBaseline.current = true;
      setLastSeenOperationId(latestOperationId);
      return;
    }
    if (open) {
      setLastSeenOperationId(latestOperationId);
    }
  }, [latestOperationId, open, operationsReady]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function toggleOpen() {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen && latestOperationId) {
      hasBaseline.current = true;
      setLastSeenOperationId(latestOperationId);
    }
  }

  return (
    <div ref={menuRef} className="activity-menu">
      <button
        type="button"
        className={
          hasNewActivity || hasUploadActivity || hasFileBatchActivity
            ? "icon-button activity-menu-button has-new-activity has-upload-activity"
            : "icon-button activity-menu-button"
        }
        onClick={toggleOpen}
        title={t("workspace.recentOperations")}
        aria-label={t("workspace.recentOperations")}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Clock3 aria-hidden="true" size={16} />
        {hasNewActivity || hasUploadActivity || hasFileBatchActivity ? (
          <span
            className="activity-unread-dot"
            data-tone={hasNewActivity ? "alert" : "warning"}
            aria-hidden="true"
          />
        ) : null}
      </button>

      {open ? (
        <section className="activity-popover" role="dialog" aria-label={t("workspace.recentOperations")}>
          <header>
            <span className="eyebrow">{t("workspace.activity")}</span>
            <strong>{t("workspace.recentOperations")}</strong>
          </header>
          {visibleUploadBatches.length ? (
            <section className="activity-upload-section" aria-label={t("workspace.uploads")}>
              <header className="activity-upload-section-header">
                <span className="eyebrow">{t("workspace.uploads")}</span>
                <strong>{t("workspace.uploadActivity")}</strong>
              </header>
              <ol className="activity-upload-list">
                {visibleUploadBatches.map((batch) => {
                  const totalBytes = batch.items.reduce((sum, item) => sum + item.sizeBytes, 0);
                  const uploadedBytes = batch.items.reduce((sum, item) => sum + item.uploadedBytes, 0);
                  const progress =
                    totalBytes > 0 ? Math.min((uploadedBytes / totalBytes) * 100, 100) : batch.status === "completed" ? 100 : 0;
                  const currentItem =
                    batch.items.find((item) => item.id === batch.currentItemId) ??
                    batch.items.find((item) => item.status === "uploading") ??
                    batch.items.find((item) => item.status === "failed" || item.status === "cancelled") ??
                    batch.items.find((item) => item.status !== "queued") ??
                    batch.items[0];
                  const targetLabel = batch.targetPath === "." ? t("common.root") : batch.targetPath;
                  const fileCountLabel =
                    batch.items.length === 1
                      ? batch.items[0]?.name ?? t("common.dash")
                      : t("workspace.uploadFilesCount", { count: batch.items.length });
                  const statusLabel =
                    batch.status === "uploading"
                      ? t("workspace.uploading")
                      : batch.status === "queued"
                        ? t("workspace.uploadQueued")
                        : batch.status === "failed"
                          ? t("workspace.uploadFailed")
                          : batch.status === "cancelled"
                            ? t("workspace.uploadCancelled")
                            : t("workspace.uploadCompleted");
                  const statusTone =
                    batch.status === "uploading"
                      ? "warning"
                      : batch.status === "failed" || batch.status === "cancelled"
                        ? "offline"
                        : batch.status === "completed"
                          ? "ready"
                          : "neutral";
                  const ItemIcon = batch.status === "completed" ? Check : batch.items.length > 1 ? FolderUp : Upload;
                  const isActive = isUploadBatchActive(batch);
                  const progressWidth =
                    batch.status === "uploading"
                      ? Math.max(progress, 6)
                      : batch.status === "queued"
                        ? Math.max(progress, 4)
                        : progress;

                  return (
                    <li key={batch.id} className="activity-upload-item" data-state={statusTone}>
                      <div className="activity-upload-icon" aria-hidden="true">
                        {isActive ? <LoaderCircle size={16} /> : <ItemIcon size={16} />}
                      </div>
                      <div className="activity-upload-body">
                        <div className="activity-upload-head">
                          <strong title={fileCountLabel}>{fileCountLabel}</strong>
                          <span className="management-status-pill activity-upload-status" data-state={statusTone}>
                            {statusLabel}
                          </span>
                        </div>
                        <small>
                          {t("workspace.uploadTo", { path: targetLabel })}
                          {" · "}
                          {formatBytes(uploadedBytes, locale)} / {formatBytes(totalBytes, locale)}
                        </small>
                        {currentItem ? <small className="activity-upload-current">{currentItem.relativePath}</small> : null}
                        {batch.error ? <small className="activity-upload-error">{batch.error}</small> : null}
                        <div
                          className="activity-upload-track"
                          role="progressbar"
                          aria-label={t("workspace.uploadProgressAria", {
                            count: batch.items.length
                          })}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(progress)}
                        >
                          <span style={{ width: `${progressWidth}%` }} />
                        </div>
                      </div>
                      {isActive ? (
                        <button
                          type="button"
                          className="activity-upload-cancel"
                          onClick={() => onCancelUploadBatch(batch.id)}
                          title={t("workspace.cancelUpload")}
                          aria-label={t("workspace.cancelUpload")}
                        >
                          <X aria-hidden="true" size={14} />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
          {visibleFileBatches.length ? (
            <section className="activity-upload-section" aria-label={t("workspace.batch.activity")}>
              <header className="activity-upload-section-header">
                <span className="eyebrow">{t("workspace.batch.eyebrow")}</span>
                <strong>{t("workspace.batch.activity")}</strong>
              </header>
              <ol className="activity-upload-list">
                {visibleFileBatches.map((batch) => {
                  const active = batch.status === "queued" || batch.status === "running";
                  const progress = batch.totalCount > 0 ? Math.min(100, (batch.completedCount / batch.totalCount) * 100) : 0;
                  const statusTone = batch.status === "completed"
                    ? "ready"
                    : batch.status === "failed" || batch.status === "cancelled"
                      ? "offline"
                      : "warning";
                  const BatchIcon = batch.operation === "move" ? FolderInput : Trash2;
                  return (
                    <li key={batch.id} className="activity-upload-item activity-file-batch-item" data-state={statusTone}>
                      <div className="activity-upload-icon" aria-hidden="true">
                        {active ? <LoaderCircle size={16} /> : batch.status === "completed" ? <Check size={16} /> : <BatchIcon size={16} />}
                      </div>
                      <div className="activity-upload-body">
                        <div className="activity-upload-head">
                          <strong>{batch.operation === "move" ? t("workspace.batch.move") : t("workspace.batch.delete")}</strong>
                          <span className="activity-file-batch-status" data-state={statusTone}>
                            {t(`workspace.batch.status.${batch.status}`)}
                          </span>
                        </div>
                        <small>
                          {t("workspace.batch.progress", {
                            completed: batch.completedCount,
                            total: batch.totalCount,
                            success: batch.successCount,
                            failed: batch.failedCount
                          })}
                        </small>
                        {batch.currentSourcePath ? <small className="activity-upload-current">{batch.currentSourcePath}</small> : null}
                        {batch.failures[0] ? (
                          <small className="activity-upload-error" title={batch.failures[0].error}>
                            {batch.failures[0].sourcePath}: {batch.failures[0].error}
                          </small>
                        ) : batch.error ? <small className="activity-upload-error">{batch.error}</small> : null}
                        <div
                          className="activity-upload-track"
                          role="progressbar"
                          aria-label={t("workspace.batch.progressAria", { count: batch.totalCount })}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(progress)}
                        >
                          <span style={{ width: `${active ? Math.max(progress, 4) : progress}%` }} />
                        </div>
                      </div>
                      {active ? (
                        <button
                          type="button"
                          className="activity-upload-cancel"
                          onClick={() => onCancelFileBatch(batch.jobId)}
                          title={t("workspace.batch.cancel")}
                          aria-label={t("workspace.batch.cancel")}
                        >
                          <X aria-hidden="true" size={14} />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
          {visibleOperations.length ? (
            <ol className="activity-operation-list">
              {visibleOperations.map((operation) => {
                const canRollback =
                  operation.status === "applied" &&
                  operation.metadata.reversible !== false &&
                  operation.metadata.rollbackAction !== true;
                const OperationIcon =
                  operation.operation === "upload"
                    ? Upload
                    : operation.operation === "mkdir"
                      ? FolderPlus
                      : operation.operation === "extract"
                        ? ArchiveRestore
                        : Square;
                const title =
                  operation.operation === "upload"
                    ? t("workspace.uploadCompleted")
                    : operation.operation === "mkdir"
                      ? `${t("workspace.actions.newFolder")} ${operation.status}`
                      : operation.operation === "extract"
                        ? `${t("workspace.actions.extract")} ${operation.status}`
                        : `${operation.operation} ${operation.status}`;
                const pathDetail = operation.sourcePath ?? operation.targetPath ?? t("common.dash");
                return (
                  <li key={operation.id}>
                    <OperationIcon aria-hidden="true" size={operation.operation === "upload" || operation.operation === "mkdir" || operation.operation === "extract" ? 14 : 8} />
                    <span>
                      <strong>
                        {title}
                      </strong>
                      <small>
                        {pathDetail}
                        {operation.sourcePath && operation.targetPath ? ` -> ${operation.targetPath}` : ""}
                      </small>
                    </span>
                    {canRollback ? (
                      <button type="button" onClick={() => onRollback(operation)} title={t("common.actions.rollback")}>
                        <RotateCcw aria-hidden="true" size={14} />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : visibleUploadBatches.length || visibleFileBatches.length ? null : (
            <p>{t("workspace.noActivity")}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
