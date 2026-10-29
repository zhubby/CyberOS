import { useId, type ReactNode } from "react";

interface SwitchBaseProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  description?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  compact?: boolean;
  className?: string;
  id?: string;
}

export type SwitchProps = SwitchBaseProps & (
  | { label: ReactNode; ariaLabel?: string }
  | { label?: undefined; ariaLabel: string }
);

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  ariaLabel,
  disabled = false,
  busy = false,
  compact = false,
  className,
  id: providedId
}: SwitchProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const classes = [
    "hud-switch",
    compact ? "is-compact" : "",
    disabled ? "is-disabled" : "",
    busy ? "is-busy" : "",
    className ?? ""
  ].filter(Boolean).join(" ");

  return (
    <label className={classes} data-state={checked ? "on" : "off"} htmlFor={id}>
      <input
        id={id}
        className="hud-switch-input"
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        aria-label={label === undefined ? ariaLabel : undefined}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span className="hud-switch-track" aria-hidden="true">
        <span className="hud-switch-thumb" />
      </span>
      {label !== undefined || description !== undefined ? (
        <span className="hud-switch-copy">
          {label !== undefined ? <span className="hud-switch-label">{label}</span> : null}
          {description !== undefined ? <small>{description}</small> : null}
        </span>
      ) : null}
    </label>
  );
}
