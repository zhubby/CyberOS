import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

export function SearchFilterPopover({
  label,
  active,
  onOpen,
  onApply,
  onReset,
  children,
}: {
  label: string;
  active: boolean;
  onOpen: () => void;
  onApply: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<{ maxHeight: number; maxWidth: number }>();

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePress(event: PointerEvent) {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function updateLayout() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      let bottom = window.innerHeight;
      let left = 16;
      for (let parent = containerRef.current?.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
          bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
        }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
          left = Math.max(left, rect.left + parent.clientLeft + 14);
        }
      }
      const rect = trigger.getBoundingClientRect();
      const maxHeight = Math.max(0, Math.min(640, bottom - rect.bottom - 14));
      const maxWidth = Math.max(0, Math.min(480, rect.right - left));
      setLayout((current) => current?.maxHeight === maxHeight && current.maxWidth === maxWidth
        ? current : { maxHeight, maxWidth });
    }
    updateLayout();
    menuRef.current?.querySelector<HTMLElement>("button, input")?.focus();
    window.addEventListener("resize", updateLayout);
    document.addEventListener("scroll", updateLayout, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      document.removeEventListener("scroll", updateLayout, true);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="workspace-search-filter"
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (!open || event.defaultPrevented || !["Escape", "BrowserBack", "GoBack"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        closeAndRestoreFocus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`workspace-search-filter-trigger${active ? " is-active" : ""}`}
        aria-label={active ? `${label}: ${t("workspace.search.filtersActive")}` : label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (!open) onOpen();
          setOpen((current) => !current);
        }}
      >
        <SlidersHorizontal aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={id}
          className="workspace-search-filter-menu"
          role="dialog"
          aria-label={label}
          style={layout}
        >
          {children}
          <div className="workspace-search-filter-actions">
            <button type="button" className="secondary-button" onClick={() => {
              onReset();
              closeAndRestoreFocus();
            }}>{t("workspace.search.reset")}</button>
            <button type="button" className="primary-button" onClick={() => {
              onApply();
              closeAndRestoreFocus();
            }}>{t("workspace.search.apply")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
