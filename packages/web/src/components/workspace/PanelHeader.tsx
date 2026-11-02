import { Children, isValidElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MobileAppControls, useAppHeadingFocus } from "../../mobile/MobileHome.js";
import { useMobileBack, useMobileNavigation } from "../../mobile/MobileNavigation.js";

export interface PanelHeaderProps {
  icon: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  actions: ReactNode;
  meta?: ReactNode;
  className?: string;
}

export function PanelHeader({
  icon,
  title,
  subtitle,
  actions,
  meta,
  className
}: PanelHeaderProps) {
  const navigation = useMobileNavigation();
  const headingRef = useAppHeadingFocus();
  return (
    <header className={["management-header", "app-titlebar", className].filter(Boolean).join(" ")}>
      <MobileAppControls control="back" />
      <span className="management-title-icon">{icon}</span>
      <div className="management-title-copy">
        <h2 ref={headingRef} tabIndex={navigation?.compact ? -1 : undefined}>{title}</h2>
        <p>{subtitle}</p>
        {navigation?.compact && meta ? <div className="mobile-header-meta">{meta}</div> : null}
      </div>
      {!navigation?.compact && meta ? <div className="panel-header-meta">{meta}</div> : null}
      {actions}
      <MobileAppControls control="home" />
    </header>
  );
}

export function PanelHeaderActions({
  label,
  className,
  children
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const navigation = useMobileNavigation();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const items = Children.toArray(children);
  const primary = items.filter((child) => isValidElement<{ mobilePrimary?: boolean }>(child) && child.props.mobilePrimary);
  const secondary = items.filter((child) => !isValidElement<{ mobilePrimary?: boolean }>(child) || !child.props.mobilePrimary);
  const close = () => { setOpen(false); window.requestAnimationFrame(() => triggerRef.current?.focus()); };
  useMobileBack(() => { if (!open) return false; close(); return true; }, 40);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    const frame = window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>(".mobile-action-menu button:not(:disabled)")?.focus());
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.cancelAnimationFrame(frame); };
  }, [open]);
  if (navigation?.compact) return <div ref={rootRef} className={["management-actions panel-header-actions mobile-header-actions", className].filter(Boolean).join(" ")} role="group" aria-label={label}>
    {primary}
    {secondary.length ? <button ref={triggerRef} type="button" className="mobile-more-button" aria-label={t("mobile.more")} title={t("mobile.more")} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}><Ellipsis size={21} aria-hidden="true" /></button> : null}
    {open ? <div id={id} className="mobile-action-menu" data-focus-return={id} onClick={(event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (button && button.getAttribute("aria-haspopup") !== "menu" && button.getAttribute("aria-haspopup") !== "dialog") setOpen(false);
    }}>{secondary}</div> : null}
  </div>;
  return (
    <div
      className={["management-actions", "panel-header-actions", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}

export function PanelHeaderAction({
  label,
  tooltip = label,
  className,
  mobilePrimary: _mobilePrimary,
  children,
  ...buttonProps
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  label: string;
  tooltip?: string;
  mobilePrimary?: boolean;
}) {
  const compact = useMobileNavigation()?.compact ?? false;
  return (
    <button
      {...buttonProps}
      className={["panel-header-action", className].filter(Boolean).join(" ")}
      title={tooltip}
      aria-label={label}
    >
      {children}
      {compact ? <span className="mobile-action-label">{label}</span> : null}
    </button>
  );
}
