import type { ButtonHTMLAttributes, ReactNode } from "react";

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
  return (
    <header className={["management-header", "app-titlebar", className].filter(Boolean).join(" ")}>
      <span className="management-title-icon">{icon}</span>
      <div className="management-title-copy">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {meta ? <div className="panel-header-meta">{meta}</div> : null}
      {actions}
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
  children,
  ...buttonProps
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  label: string;
  tooltip?: string;
}) {
  return (
    <button
      {...buttonProps}
      className={["panel-header-action", className].filter(Boolean).join(" ")}
      title={tooltip}
      aria-label={label}
    >
      {children}
    </button>
  );
}
