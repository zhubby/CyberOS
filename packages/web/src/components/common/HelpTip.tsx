import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { measureTooltipPosition } from "../../lib/tooltip-position.js";

export function HelpTip({ label, content, id: providedId }: { label: string; content: string; id?: string }) {
  const { t } = useTranslation();
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovered = useRef(false);
  const touchOpen = useRef(false);
  const pointerType = useRef("");
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState({ left: 0, top: 0, maxHeight: 240 });

  function show() {
    clearTimeout(closeTimer.current);
    setOpen(true);
  }

  function leave() {
    hovered.current = false;
    closeTimer.current = setTimeout(() => {
      if (!hovered.current && document.activeElement !== triggerRef.current) setOpen(false);
    }, 120);
  }

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!open) return;
    function otherTooltip(event: Event) {
      if (event instanceof CustomEvent && event.detail !== id) setOpen(false);
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !tipRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    function dismiss(event: KeyboardEvent) {
      if (event.defaultPrevented || (!["Escape", "BrowserBack", "GoBack"].includes(event.key) && event.keyCode !== 461)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    // Close this layer before the settings dialog handles Escape.
    document.addEventListener("keydown", dismiss, true);
    document.addEventListener("cyberos:tooltip-open", otherTooltip);
    document.dispatchEvent(new CustomEvent("cyberos:tooltip-open", { detail: id }));
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", dismiss, true);
      document.removeEventListener("cyberos:tooltip-open", otherTooltip);
    };
  }, [open, id]);

  useLayoutEffect(() => {
    if (!open) return;
    function position() {
      const trigger = triggerRef.current;
      const tip = tipRef.current;
      if (!trigger || !tip) return;
      const next = measureTooltipPosition(trigger, tip);
      if (next) {
        const { left, top, maxHeight } = next;
        setLayout({ left, top, maxHeight });
      } else setOpen(false);
    }
    position();
    const observer = new ResizeObserver(position);
    if (triggerRef.current) observer.observe(triggerRef.current);
    if (tipRef.current) observer.observe(tipRef.current);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, content]);

  const tip = (
    <span
      ref={tipRef}
      id={id}
      role="tooltip"
      className="hud-tooltip help-tip-content"
      hidden={!open}
      style={layout}
      onPointerEnter={() => { hovered.current = true; show(); }}
      onPointerLeave={leave}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >{content}</span>
  );
  const portalRoot = open ? triggerRef.current?.closest("[data-modal-layer]") ?? document.fullscreenElement ?? document.body : null;

  return (
    <span className="help-tip">
      <button
        ref={triggerRef}
        type="button"
        className="help-tip-trigger"
        aria-label={t("common.helpFor", { label })}
        aria-describedby={id}
        aria-expanded={open}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") { hovered.current = true; show(); }
        }}
        onPointerLeave={leave}
        onPointerDown={(event) => { pointerType.current = event.pointerType; touchOpen.current = open; }}
        onFocus={show}
        onBlur={() => { if (!hovered.current) setOpen(false); }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (event.detail !== 0 && pointerType.current === "touch") {
            setOpen(!touchOpen.current);
          } else show();
        }}
      ><Info aria-hidden="true" size={14} /></button>
      {portalRoot ? createPortal(tip, portalRoot) : tip}
    </span>
  );
}

export function HelpLabel({ label, content, htmlFor, helpId }: { label: string; content: string; htmlFor?: string; helpId?: string }) {
  return (
    <span className="help-label">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      <HelpTip label={label} content={content} {...(helpId ? { id: helpId } : {})} />
    </span>
  );
}
