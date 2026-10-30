import { useEffect, useRef, useState } from "react";

export function PlaybackSlider({
  value,
  max,
  min = 0,
  className,
  step = 1,
  disabled,
  label,
  onCommit,
}: {
  value: number;
  max: number;
  min?: number;
  className?: string;
  step?: number;
  disabled: boolean;
  label: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const latest = useRef(value);
  useEffect(() => {
    if (!dirty.current) {
      setDraft(value);
      latest.current = value;
    }
  }, [value]);
  const commit = () => {
    if (dirty.current) {
      dirty.current = false;
      onCommit(latest.current);
    }
  };
  return (
    <input
      type="range"
      className={className}
      min={min}
      max={max}
      step={step}
      value={Math.max(min, Math.min(draft, max))}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => {
        latest.current = Number(event.target.value);
        dirty.current = true;
        setDraft(latest.current);
      }}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
  );
}
