import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileMeta } from "../../api.js";
import "@js-preview/excel/lib/index.css";

type OfficePreviewKind = "document" | "spreadsheet" | "presentation";
type PreviewStatus = "loading" | "ready" | "error";

export function OfficePreview({ blobUrl, meta }: { blobUrl: string; meta: FileMeta }) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<PreviewStatus>("loading");

  useEffect(() => {
    if (!hostRef.current || !isOfficePreviewKind(meta.previewKind)) {
      return;
    }
    const host: HTMLDivElement = hostRef.current;

    const controller = new AbortController();
    let disposed = false;
    let disposeRenderer: (() => void) | undefined;
    host.replaceChildren();
    setStatus("loading");

    async function renderOfficeFile() {
      const response = await fetch(blobUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Office preview request failed: ${response.status}`);
      }
      const data = await response.arrayBuffer();
      if (disposed) {
        return;
      }

      if (meta.previewKind === "document") {
        const { renderAsync } = await import("docx-preview");
        if (disposed) return;
        await renderAsync(data, host, host, {
          className: "zos-docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderAltChunks: false,
          useBase64URL: true
        });
      } else if (meta.previewKind === "spreadsheet") {
        const { default: excelPreview } = await import("@js-preview/excel");
        if (disposed) return;
        const renderer = excelPreview.init(host, { showContextmenu: false });
        disposeRenderer = () => renderer.destroy();
        await renderer.preview(data);
      } else {
        const { init } = await import("pptx-preview");
        if (disposed) return;
        const width = Math.max(240, Math.min(960, host.clientWidth - 24));
        const renderer = init(host, { width, height: Math.round(width * 0.5625), mode: "slide" });
        disposeRenderer = () => renderer.destroy();
        await renderer.preview(data);
      }

      if (!disposed) {
        secureRenderedLinks(host);
        setStatus("ready");
      }
    }

    void renderOfficeFile().catch((error: unknown) => {
      if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) {
        setStatus("error");
      }
    });

    return () => {
      disposed = true;
      controller.abort();
      disposeRenderer?.();
      host.replaceChildren();
    };
  }, [blobUrl, meta.path, meta.previewKind, meta.modifiedAt, revision]);

  return (
    <div className={`office-preview office-${meta.previewKind}-preview`} aria-busy={status === "loading"}>
      {status === "loading" ? <div className="office-preview-status">{t("preview.officeLoading")}</div> : null}
      {status === "error" ? (
        <div className="preview-empty preview-error">
          <AlertTriangle aria-hidden="true" size={20} />
          <span>{t("preview.officeRenderError")}</span>
          <button
            type="button"
            className="preview-tool-button"
            onClick={() => setRevision((current) => current + 1)}
            title={t("preview.retry")}
            aria-label={t("preview.retry")}
          >
            <RefreshCw aria-hidden="true" size={14} />
          </button>
        </div>
      ) : null}
      <div ref={hostRef} className="office-preview-host" hidden={status === "error"} />
    </div>
  );
}

export function isOfficePreviewKind(kind: FileMeta["previewKind"]): kind is OfficePreviewKind {
  return kind === "document" || kind === "spreadsheet" || kind === "presentation";
}

function secureRenderedLinks(host: HTMLElement): void {
  for (const link of host.querySelectorAll("a")) {
    const href = link.getAttribute("href");
    if (!href || href.startsWith("#")) {
      continue;
    }
    try {
      const url = new URL(href, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
        link.removeAttribute("href");
        continue;
      }
      link.target = "_blank";
      link.rel = "noreferrer";
    } catch {
      link.removeAttribute("href");
    }
  }
}
