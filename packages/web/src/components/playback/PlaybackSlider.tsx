import { useEffect, useRef, useState, type CSSProperties } from "react";

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
  const clamped = Math.max(min, Math.min(draft, max));
  const fill = max > min ? (clamped - min) / (max - min) * 100 : 0;
  return (
    <input
      type="range"
      className={className}
      min={min}
      max={max}
      step={step}
      value={clamped}
      style={{ "--playback-slider-fill": `${fill}%` } as CSSProperties}
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
