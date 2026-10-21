import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  AlertTriangle,
  File,
  FileText,
  FileSpreadsheet,
  Folder,
  Image as ImageIcon,
  Music,
  PanelRight,
  Presentation,
  Play,
  RefreshCw,
  Video
} from "lucide-react";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { FileMeta, FilePreviewKind, TextPreview } from "../../api.js";
import { formatBytes, formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { isPreviewOverFileSizeLimit } from "../../lib/preview-settings.js";
import {
  clearVideoProgress,
  readVideoProgress,
  writeVideoProgress,
  type VideoProgressIdentity
} from "../../lib/video-progress.js";
import {
  describeTextPreview,
  highlightSource,
  parseDelimitedTablePreview,
  resolveMarkdownLink,
  type DelimitedTablePreview,
  type TextPreviewDescriptor
} from "../../preview-utils.js";
import { isOfficePreviewKind, OfficePreview } from "./OfficePreview.js";

export function PreviewContent({
  blobUrl,
  videoUrl,
  rootId,
  loading,
  meta,
  error,
  textPreview,
  previewFileSizeLimitBytes,
  locale,
  onOpenWorkspacePath
}: {
  blobUrl: string;
  videoUrl: string;
  rootId: string;
  loading: boolean;
  meta: FileMeta | null;
  error: string | null;
  textPreview: TextPreview | null;
  previewFileSizeLimitBytes: number;
  locale: SupportedLocale;
  onOpenWorkspacePath: (path: string) => void;
}) {
  const { t } = useTranslation();

  if (loading) {
    return <div className="preview-empty">{t("preview.loading")}</div>;
  }
  if (error) {
    return (
      <div className="preview-empty preview-error">
        <AlertTriangle aria-hidden="true" size={20} />
        <span>{error}</span>
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="preview-empty">
        <PanelRight aria-hidden="true" size={24} />
        <span>{t("preview.chooseFile")}</span>
      </div>
    );
  }
  if (isPreviewOverFileSizeLimit(meta, previewFileSizeLimitBytes)) {
    return (
      <div className="preview-empty">
        <AlertTriangle aria-hidden="true" size={24} />
        <strong>{meta.mimeType}</strong>
        <span>
          {t("preview.tooLarge", {
            size: formatBytes(meta.sizeBytes, locale),
            limit: formatBytes(previewFileSizeLimitBytes, locale)
          })}
        </span>
      </div>
    );
  }
  if (meta.previewKind === "text") {
    return <TextPreviewPanel meta={meta} textPreview={textPreview} locale={locale} onOpenWorkspacePath={onOpenWorkspacePath} />;
  }
  if (meta.previewKind === "image") {
    return (
      <div className="media-preview">
        <img src={blobUrl} alt={meta.name} />
      </div>
    );
  }
  if (meta.previewKind === "audio") {
    return (
      <div className="media-preview media-preview-centered">
        <Music aria-hidden="true" size={42} />
        <audio src={blobUrl} controls />
      </div>
    );
  }
  if (meta.previewKind === "video") {
    return <VideoPreview src={videoUrl} identity={{ rootId, path: meta.path, sizeBytes: meta.sizeBytes, modifiedAt: meta.modifiedAt }} />;
  }
  if (meta.previewKind === "pdf") {
    return <iframe className="pdf-preview" title={meta.name} src={blobUrl} />;
  }
  if (isOfficePreviewKind(meta.previewKind)) {
    return <OfficePreview blobUrl={blobUrl} meta={meta} />;
  }
  return (
    <div className="preview-empty">
      <File aria-hidden="true" size={24} />
      <strong>{meta.mimeType}</strong>
      <span>{t("preview.cannotPreview", { size: formatBytes(meta.sizeBytes, locale) })}</span>
    </div>
  );
}

function VideoPreview({ src, identity }: { src: string; identity: VideoProgressIdentity }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSavedAtRef = useRef(0);
  const lastSavedPositionRef = useRef(0);
  const lastKnownPositionRef = useRef(0);
  const hasKnownPositionRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sourceRevision, setSourceRevision] = useState(0);

  const saveProgress = useCallback(
    (force: boolean) => {
      const video = videoRef.current;
      if (video?.ended) {
        return;
      }

      const hasLivePosition = video && Number.isFinite(video.currentTime);
      const shouldUseLivePosition = hasLivePosition && (video.currentTime > 0 || video.isConnected || !hasKnownPositionRef.current);
      const currentTime = shouldUseLivePosition
        ? video.currentTime
        : hasKnownPositionRef.current
          ? lastKnownPositionRef.current
          : null;
      if (currentTime === null) {
        return;
      }
      lastKnownPositionRef.current = currentTime;

      if (currentTime <= 0) {
        return;
      }

      const now = Date.now();
      if (!force && now - lastSavedAtRef.current < 5000) {
        return;
      }
      writeVideoProgress(identity, currentTime);
      lastSavedAtRef.current = now;
      lastSavedPositionRef.current = currentTime;
    },
    [identity]
  );

  useEffect(() => {
    lastSavedAtRef.current = 0;
    lastSavedPositionRef.current = 0;
    lastKnownPositionRef.current = 0;
    hasKnownPositionRef.current = false;
    setStatus("loading");
  }, [identity.modifiedAt, identity.path, identity.rootId, identity.sizeBytes, src, sourceRevision]);

  useEffect(() => {
    const handlePageHide = () => saveProgress(true);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        saveProgress(true);
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      saveProgress(true);
    };
  }, [saveProgress]);

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const saved = readVideoProgress(identity);
    if (saved && Number.isFinite(video.duration) && video.duration > 0) {
      if (saved.positionSeconds > 0 && saved.positionSeconds < video.duration - 1) {
        video.currentTime = saved.positionSeconds;
      } else if (saved.positionSeconds >= video.duration - 1) {
        clearVideoProgress(identity);
        video.currentTime = 0;
      }
    }
    lastKnownPositionRef.current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    hasKnownPositionRef.current = true;
    lastSavedPositionRef.current = lastKnownPositionRef.current;
    setStatus("ready");
  }

  if (status === "error") {
    return (
      <div className="preview-empty preview-error">
        <AlertTriangle aria-hidden="true" size={20} />
        <span>{t("preview.videoPlaybackError")}</span>
        <button
          type="button"
          className="preview-tool-button"
          onClick={() => {
            setStatus("loading");
            setSourceRevision((current) => current + 1);
          }}
          title={t("preview.retry")}
          aria-label={t("preview.retry")}
        >
          <RefreshCw aria-hidden="true" size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="media-preview video-preview" aria-busy={status === "loading"}>
      {status === "loading" ? <span className="video-preview-status">{t("preview.videoLoading")}</span> : null}
      <video
        key={`${src}-${sourceRevision}`}
        ref={videoRef}
        src={src}
        controls
        playsInline
        preload="metadata"
        onLoadStart={() => setStatus("loading")}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={() => saveProgress(false)}
        onPause={() => saveProgress(true)}
        onSeeked={() => {
          const video = videoRef.current;
          if (video && video.currentTime <= 0) {
            clearVideoProgress(identity);
            lastSavedAtRef.current = 0;
            lastSavedPositionRef.current = 0;
            lastKnownPositionRef.current = 0;
            hasKnownPositionRef.current = true;
            return;
          }
          saveProgress(true);
        }}
        onEnded={() => {
          clearVideoProgress(identity);
          lastSavedAtRef.current = 0;
          lastSavedPositionRef.current = 0;
        }}
        onError={() => setStatus("error")}
      />
    </div>
  );
}

export function previewIcon(kind: FilePreviewKind) {
  if (kind === "text") {
    return <FileText aria-hidden="true" size={15} />;
  }
  if (kind === "image") {
    return <ImageIcon aria-hidden="true" size={15} />;
  }
  if (kind === "audio") {
    return <Music aria-hidden="true" size={15} />;
  }
  if (kind === "video") {
    return <Video aria-hidden="true" size={15} />;
  }
  if (kind === "pdf") {
    return <FileText aria-hidden="true" size={15} />;
  }
  if (kind === "document") {
    return <FileText aria-hidden="true" size={15} />;
  }
  if (kind === "spreadsheet") {
    return <FileSpreadsheet aria-hidden="true" size={15} />;
  }
  if (kind === "presentation") {
    return <Presentation aria-hidden="true" size={15} />;
  }
  if (kind === "directory") {
    return <Folder aria-hidden="true" size={15} />;
  }
  return <Play aria-hidden="true" size={15} />;
}

type TextPreviewMode = "rendered" | "table" | "source";
type Translate = TFunction<"translation">;

function TextPreviewPanel({
  meta,
  textPreview,
  locale,
  onOpenWorkspacePath
}: {
  meta: FileMeta;
  textPreview: TextPreview | null;
  locale: SupportedLocale;
  onOpenWorkspacePath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const content = textPreview?.content ?? "";
  const descriptor = useMemo(() => describeTextPreview(meta.name, meta.mimeType), [meta.name, meta.mimeType]);
  const defaultMode = getDefaultTextPreviewMode(descriptor);
  const [mode, setMode] = useState<TextPreviewMode>(defaultMode);
  const tablePreview = useMemo(
    () =>
      descriptor.structuredKind === "table" && descriptor.delimiter
        ? parseDelimitedTablePreview(content, descriptor.delimiter, undefined, undefined, (index) =>
            t("preview.column", { index: formatLocaleNumber(index, locale) })
          )
        : null,
    [content, descriptor.delimiter, descriptor.structuredKind, locale, t]
  );
  const highlighted = useMemo(() => highlightSource(content, descriptor.language), [content, descriptor.language]);
  const availableModes = getTextPreviewModes(descriptor, tablePreview);
  const fallbackMode = availableModes[0] ?? "source";
  const resetMode = availableModes.includes(defaultMode) ? defaultMode : fallbackMode;
  const activeMode = availableModes.includes(mode) ? mode : fallbackMode;

  useEffect(() => {
    setMode(resetMode);
  }, [meta.path, resetMode]);

  return (
    <div className="text-preview-shell">
      <div className="text-preview-toolbar">
        <div className="preview-source-meta">
          <span>{descriptor.languageLabel}</span>
          {textPreview?.truncated ? <em>{t("preview.truncated")}</em> : null}
        </div>
        {availableModes.length > 1 ? (
          <div className="preview-mode-switch" aria-label={t("preview.modeAria")}>
            {availableModes.map((nextMode) => (
              <button
                key={nextMode}
                type="button"
                className={nextMode === activeMode ? "is-active" : ""}
                aria-pressed={nextMode === activeMode}
                onClick={() => setMode(nextMode)}
              >
                {textPreviewModeLabel(nextMode, t)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {activeMode === "rendered" ? (
        <MarkdownPreview source={content} currentFilePath={meta.path} onOpenWorkspacePath={onOpenWorkspacePath} />
      ) : activeMode === "table" && tablePreview ? (
        <DelimitedTable preview={tablePreview} locale={locale} />
      ) : (
        <SourcePreview html={highlighted.html} language={highlighted.language} />
      )}
    </div>
  );
}

function MarkdownPreview({
  source,
  currentFilePath,
  onOpenWorkspacePath
}: {
  source: string;
  currentFilePath: string;
  onOpenWorkspacePath: (path: string) => void;
}) {
  return (
    <div className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, ...props }) => {
            const target = resolveMarkdownLink(currentFilePath, href);
            if (target.kind === "workspace") {
              return (
                <a
                  {...props}
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenWorkspacePath(target.path);
                  }}
                />
              );
            }
            if (target.kind === "external") {
              return <a {...props} href={href} target="_blank" rel="noreferrer" />;
            }
            if (target.kind === "invalid") {
              return <a {...props} aria-disabled="true" onClick={(event) => event.preventDefault()} />;
            }
            return <a {...props} href={href} />;
          },
          code: ({ className, children, node: _node }) => {
            const language = markdownCodeLanguage(className);
            if (!language) {
              return <code className={className}>{children}</code>;
            }

            const highlighted = highlightSource(String(children).replace(/\n$/, ""), language);
            return <code className={`hljs language-${highlighted.language}`} dangerouslySetInnerHTML={{ __html: highlighted.html }} />;
          },
          pre: ({ children, node: _node }) => <pre className="markdown-code-block">{children}</pre>
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function DelimitedTable({ preview, locale }: { preview: DelimitedTablePreview; locale: SupportedLocale }) {
  const { t } = useTranslation();

  return (
    <div className="table-preview">
      <table>
        <thead>
          <tr>
            {preview.headers.map((header, index) => (
              <th key={`${header}-${index}`} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {preview.truncatedRows || preview.truncatedColumns ? (
        <div className="table-preview-note">
          {t("preview.tableTruncated", {
            rows: formatLocaleNumber(preview.rows.length, locale),
            totalRows: formatLocaleNumber(preview.totalRows, locale),
            columns: formatLocaleNumber(preview.headers.length, locale),
            totalColumns: formatLocaleNumber(preview.totalColumns, locale)
          })}
        </div>
      ) : null}
    </div>
  );
}

function SourcePreview({ html, language }: { html: string; language: string }) {
  return (
    <pre className={`text-preview language-${language}`}>
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

function getDefaultTextPreviewMode(descriptor: TextPreviewDescriptor): TextPreviewMode {
  if (descriptor.structuredKind === "markdown") {
    return "rendered";
  }
  if (descriptor.structuredKind === "table") {
    return "table";
  }
  return "source";
}

function getTextPreviewModes(descriptor: TextPreviewDescriptor, tablePreview: DelimitedTablePreview | null): TextPreviewMode[] {
  if (descriptor.structuredKind === "markdown") {
    return ["rendered", "source"];
  }
  if (descriptor.structuredKind === "table" && tablePreview) {
    return ["table", "source"];
  }
  return ["source"];
}

function textPreviewModeLabel(mode: TextPreviewMode, t: Translate): string {
  if (mode === "rendered") {
    return t("preview.modes.rendered");
  }
  if (mode === "table") {
    return t("preview.modes.table");
  }
  return t("preview.modes.source");
}

function markdownCodeLanguage(className: string | undefined): string | null {
  const match = /language-([\w-]+)/.exec(className ?? "");
  return match?.[1] ?? null;
}
