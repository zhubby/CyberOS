import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { AlertTriangle, CheckCircle2, FilePenLine, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getEditableText,
  saveEditableText,
  type FileMeta,
  type SaveEditableTextResult
} from "../../api.js";
import { formatBytes, formatTime } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { toErrorMessage } from "../../lib/format.js";
import { describeTextPreview, highlightSource } from "../../preview-utils.js";

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";
type Translate = (key: string, options?: Record<string, unknown>) => string;

export function FileEditorModal({
  rootId,
  storagePoolId,
  meta,
  locale,
  onClose,
  onSaved,
  onNotifyError
}: {
  rootId: string;
  storagePoolId: string;
  meta: FileMeta;
  locale: SupportedLocale;
  onClose: () => void;
  onSaved: (result: SaveEditableTextResult) => void;
  onNotifyError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [modifiedAt, setModifiedAt] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const onSavedRef = useRef(onSaved);
  const highlightRef = useRef<HTMLPreElement>(null);

  const dirty = content !== savedContent;
  const blocked = saveStatus === "conflict";
  const contentBytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const descriptor = useMemo(() => describeTextPreview(meta.name, meta.mimeType), [meta.mimeType, meta.name]);
  const highlighted = useMemo(
    () => highlightSource(editorHighlightContent(content), descriptor.language),
    [content, descriptor.language]
  );
  const status = useMemo(
    () => editorStatusLabel({ dirty, error, loading, saveStatus, t: translate }),
    [dirty, error, loading, saveStatus, translate]
  );

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const loadEditor = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaveStatus("idle");
    setLastSavedAt(null);

    try {
      const editable = await getEditableText(rootId, meta.path, storagePoolId);
      setContent(editable.content);
      setSavedContent(editable.content);
      setModifiedAt(editable.modifiedAt);
      setLastSavedAt(editable.modifiedAt);
      setSaveStatus("saved");
    } catch (nextError) {
      const message = toErrorMessage(nextError);
      setError(message);
      onNotifyError(message);
      setSaveStatus("error");
    } finally {
      setLoading(false);
    }
  }, [meta.path, onNotifyError, rootId, storagePoolId]);

  useEffect(() => {
    void loadEditor();
  }, [loadEditor]);

  const saveNow = useCallback(
    async (nextContent: string) => {
      if (loading) {
        return false;
      }

      setSaveStatus("saving");
      setError(null);
      try {
        const result = await saveEditableText({
          rootId,
          storagePoolId,
          currentPath: meta.path,
          content: nextContent,
          expectedModifiedAt: modifiedAt
        });
        setSavedContent(nextContent);
        setModifiedAt(result.meta.modifiedAt);
        setLastSavedAt(result.meta.modifiedAt);
        setSaveStatus("saved");
        onSavedRef.current(result);
        return true;
      } catch (nextError) {
        const message = toErrorMessage(nextError);
        setError(message);
        onNotifyError(message);
        setSaveStatus(message.includes("changed since") ? "conflict" : "error");
        return false;
      }
    },
    [loading, meta.path, modifiedAt, onNotifyError, rootId, storagePoolId]
  );

  useEffect(() => {
    if (loading || blocked || !dirty || saveStatus === "saving" || saveStatus === "error") {
      return;
    }

    setSaveStatus("dirty");
    const timer = window.setTimeout(() => {
      void saveNow(content);
    }, 700);

    return () => window.clearTimeout(timer);
  }, [blocked, content, dirty, loading, saveNow, saveStatus]);

  async function closeEditor() {
    if (saveStatus === "saving") {
      return;
    }
    if (dirty && !blocked) {
      const saved = await saveNow(content);
      if (!saved) {
        return;
      }
    }
    onClose();
  }

  function changeContent(nextContent: string) {
    setContent(nextContent);
    if (saveStatus !== "conflict") {
      setError(null);
      setSaveStatus("dirty");
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveNow(content);
    }
  }

  function syncHighlightScroll(source: HTMLTextAreaElement) {
    if (!highlightRef.current) {
      return;
    }
    highlightRef.current.scrollTop = source.scrollTop;
    highlightRef.current.scrollLeft = source.scrollLeft;
  }

  return (
    <div className="editor-backdrop">
      <section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="file-editor-title">
        <header className="editor-header">
          <div>
            <span className="eyebrow">{t("editor.eyebrow")}</span>
            <h2 id="file-editor-title">{meta.name}</h2>
            <small>{meta.path}</small>
          </div>
          <span className="editor-status" data-state={status.state}>
            {status.icon}
            {status.label}
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={() => void closeEditor()}
            disabled={saveStatus === "saving"}
            title={t("editor.close")}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div className={`editor-code-surface${loading ? " is-loading" : ""}`}>
          <pre ref={highlightRef} className={`editor-highlight language-${highlighted.language}`} aria-hidden="true">
            <code dangerouslySetInnerHTML={{ __html: highlighted.html }} />
          </pre>
          <textarea
            className="editor-textarea"
            value={content}
            onChange={(event) => changeContent(event.target.value)}
            onKeyDown={handleKeyDown}
            onScroll={(event) => syncHighlightScroll(event.currentTarget)}
            aria-label={t("editor.textarea")}
            disabled={loading}
            spellCheck={false}
            wrap="off"
          />
        </div>

        <footer className="editor-footer">
          <span>{descriptor.languageLabel}</span>
          <span>{formatBytes(contentBytes, locale)}</span>
          <span>{lastSavedAt ? t("editor.savedAt", { time: formatTime(lastSavedAt, locale) }) : t("editor.notSaved")}</span>
          {blocked ? (
            <button type="button" className="editor-footer-action" onClick={() => void loadEditor()}>
              <RotateCcw aria-hidden="true" size={14} />
              {t("editor.reload")}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function editorStatusLabel({
  dirty,
  error,
  loading,
  saveStatus,
  t
  }: {
  dirty: boolean;
  error: string | null;
  loading: boolean;
  saveStatus: SaveStatus;
  t: Translate;
}): { icon: ReactElement; label: string; state: string } {
  if (loading) {
    return { icon: <LoaderCircle aria-hidden="true" size={14} />, label: t("editor.states.loading"), state: "loading" };
  }
  if (saveStatus === "conflict") {
    return { icon: <AlertTriangle aria-hidden="true" size={14} />, label: t("editor.states.conflict"), state: "error" };
  }
  if (error) {
    return { icon: <AlertTriangle aria-hidden="true" size={14} />, label: t("editor.states.error"), state: "error" };
  }
  if (saveStatus === "saving") {
    return { icon: <LoaderCircle aria-hidden="true" size={14} />, label: t("editor.states.saving"), state: "saving" };
  }
  if (dirty) {
    return { icon: <FilePenLine aria-hidden="true" size={14} />, label: t("editor.states.unsaved"), state: "dirty" };
  }
  return { icon: <CheckCircle2 aria-hidden="true" size={14} />, label: t("editor.states.saved"), state: "saved" };
}

function editorHighlightContent(content: string): string {
  if (content.length === 0) {
    return " ";
  }
  return content.endsWith("\n") ? `${content} ` : content;
}
