import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import { usePopoverBack } from "./ModalPortal.js";
import { isBackKey } from "../../lib/remote-keys.js";

export interface CustomSelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface CustomSelectProps<T extends string = string> {
  id?: string;
  value: T;
  selectedValues?: T[];
  options: CustomSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  required?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  ariaBusy?: boolean;
}

function firstEnabledIndex<T extends string>(options: CustomSelectOption<T>[]) {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabledIndex<T extends string>(options: CustomSelectOption<T>[]) {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) {
      return index;
    }
  }

  return -1;
}

function nextEnabledIndex<T extends string>(
  options: CustomSelectOption<T>[],
  currentIndex: number,
  direction: 1 | -1
) {
  if (options.length === 0) {
    return -1;
  }

  const startIndex = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : options.length;

  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (startIndex + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) {
      return index;
    }
  }

  return -1;
}

export function CustomSelect<T extends string = string>({
  id,
  value,
  selectedValues,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = "",
  className,
  required = false,
  triggerRef: externalTriggerRef,
  ariaBusy
}: CustomSelectProps<T>) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const listboxId = `${triggerId}-listbox`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [validationError, setValidationError] = useState("");
  const errorId = `${triggerId}-error`;
  usePopoverBack(open, () => { setOpen(false); triggerRef.current?.focus(); }, 7);
  const [menuLayout, setMenuLayout] = useState({ above: false, maxHeight: 240, left: 0, width: 0, edge: 0 });
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const selectedValueSet = selectedValues ? new Set(selectedValues) : new Set([value]);
  const fallbackActiveIndex =
    selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : firstEnabledIndex(options);
  const [activeIndex, setActiveIndex] = useState(fallbackActiveIndex);
  const activeOptionId = open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;
  const rootClassName = [
    "custom-select",
    open ? "is-open" : "",
    disabled ? "is-disabled" : "",
    validationError ? "is-invalid" : "",
    className ?? ""
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    setActiveIndex(fallbackActiveIndex);
  }, [fallbackActiveIndex]);

  useEffect(() => { setValidationError(""); }, [value]);

  useLayoutEffect(() => {
    if (!open) return;

    function updateLayout() {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const below = Math.max(0, window.innerHeight - rect.bottom - 18);
      const above = Math.max(0, rect.top - 18);
      const required = Math.min(240, menu.scrollHeight + menu.offsetHeight - menu.clientHeight);
      const placeAbove = below < required && above > below;
      const maxHeight = Math.min(240, placeAbove ? above : below);
      const width = Math.min(rect.width, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const edge = placeAbove ? window.innerHeight - rect.top + 6 : rect.bottom + 6;
      setMenuLayout((current) => current.above === placeAbove && current.maxHeight === maxHeight
        && current.left === left && current.width === width && current.edge === edge
        ? current : { above: placeAbove, maxHeight, left, width, edge });
    }

    function handleScroll(event: Event) {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      updateLayout();
    }

    updateLayout();
    window.addEventListener("resize", updateLayout);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, options]);

  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const option = menu?.children[activeIndex];
    if (!menu || !(option instanceof HTMLElement)) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
    }
  }, [activeIndex, open, menuLayout]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function selectIndex(index: number) {
    if (triggerRef.current?.matches(":disabled")) return;
    const option = options[index];
    if (!option || option.disabled) {
      return;
    }

    if (option.value !== value) {
      onChange(option.value);
    }

    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((currentIndex) => nextEnabledIndex(options, open ? currentIndex : selectedIndex, 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((currentIndex) => nextEnabledIndex(options, open ? currentIndex : selectedIndex, -1));
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(firstEnabledIndex(options));
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(lastEnabledIndex(options));
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        selectIndex(activeIndex);
      } else {
        setActiveIndex(fallbackActiveIndex);
        setOpen(true);
      }
      return;
    }

    if (isBackKey(event) && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className={rootClassName}
      onBlur={(event) => {
        const nextFocus = event.relatedTarget;
        if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
          setOpen(false);
        }
      }}
    >
      <button
        id={triggerId}
        ref={(element) => {
          triggerRef.current = element;
          if (typeof externalTriggerRef === "function") externalTriggerRef(element);
          else if (externalTriggerRef) externalTriggerRef.current = element;
        }}
        type="button"
        className="custom-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        aria-busy={ariaBusy || undefined}
        aria-invalid={validationError ? true : undefined}
        aria-describedby={validationError ? errorId : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => {
          setActiveIndex(fallbackActiveIndex);
          setOpen((currentOpen) => !currentOpen);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="custom-select-value">{selectedOption?.label ?? placeholder}</span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {required ? <input
        className="custom-select-validation"
        type="text"
        tabIndex={-1}
        aria-hidden="true"
        value={selectedOption?.value ?? ""}
        required
        disabled={disabled}
        onChange={() => undefined}
        onInvalid={(event) => {
          event.preventDefault();
          setValidationError(event.currentTarget.validationMessage);
          triggerRef.current?.focus();
        }}
      /> : null}
      {validationError ? <span id={errorId} className="field-error" role="alert">{validationError}</span> : null}

      {open ? createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className="custom-select-menu"
          role="listbox"
          aria-labelledby={triggerId}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          style={{
            position: "fixed",
            left: menuLayout.left,
            right: "auto",
            width: menuLayout.width,
            top: menuLayout.above ? "auto" : menuLayout.edge,
            bottom: menuLayout.above ? menuLayout.edge : "auto",
            maxHeight: menuLayout.maxHeight
          }}
        >
          {options.map((option, index) => {
            const selected = selectedValueSet.has(option.value);
            const active = index === activeIndex;
            const optionClassName = [
              "custom-select-option",
              selected ? "is-selected" : "",
              active ? "is-active" : "",
              option.disabled ? "is-disabled" : ""
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <div
                id={`${listboxId}-option-${index}`}
                key={option.value}
                className={optionClassName}
                role="option"
                aria-selected={selected}
                aria-disabled={option.disabled}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => {
                  if (!option.disabled) {
                    setActiveIndex(index);
                  }
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  selectIndex(index);
                }}
              >
                <span>{option.label}</span>
                {selected ? <Check aria-hidden="true" size={14} /> : null}
              </div>
            );
          })}
        </div>,
        containerRef.current?.closest("[data-modal-layer]")
          ?? document.fullscreenElement
          ?? document.querySelector(".app-shell, .tv-library-shell")
          ?? document.body
      ) : null}
    </div>
  );
}
