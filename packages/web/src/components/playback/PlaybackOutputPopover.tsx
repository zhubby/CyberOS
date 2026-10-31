import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export function PlaybackOutputPopover({ children, busy }: { children: ReactNode; busy: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<{ maxHeight: number; maxWidth: number }>();

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePress(event: PointerEvent) {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.defaultPrevented || (!["Escape", "BrowserBack", "GoBack"].includes(event.key) && event.keyCode !== 461)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    const focused = lastFocusedRef.current;
    if (open && !busy && document.activeElement === document.body && focused && containerRef.current?.contains(focused)) {
      focused.focus();
    }
  }, [busy, open]);

  useLayoutEffect(() => {
    if (!open) return;
    function updateLayout() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setLayout({ maxHeight: Math.max(0, rect.top - 24), maxWidth: Math.max(0, Math.min(320, rect.right - 16)) });
    }
    updateLayout();
    menuRef.current?.querySelector<HTMLElement>("input, button")?.focus();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="playback-output"
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onFocusCapture={(event) => { lastFocusedRef.current = event.target; }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        data-tv-focusable
        aria-label={t("music.output")}
        title={t("music.output")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Volume2 size={18} aria-hidden="true" />
      </button>
      {open ? (
        <div ref={menuRef} id={id} className="playback-output-menu" role="dialog" aria-label={t("music.output")} style={layout}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
