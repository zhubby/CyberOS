import { useRef } from "react";
import { Undo2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export function SettingsSecretField({
  id,
  label,
  value,
  configured,
  clearSaved,
  placeholder,
  clearLabel,
  onChange
}: {
  id: string;
  label: string;
  value: string;
  configured: boolean;
  clearSaved: boolean;
  placeholder: string;
  clearLabel: string;
  onChange: (value: string, clearSaved: boolean) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const actionLabel = clearSaved
    ? t("settings.secretInput.undoClear")
    : configured ? clearLabel : t("common.actions.clear");

  return (
    <div className="settings-field-wide settings-secret-field">
      <label htmlFor={id}><span>{label}</span></label>
      <div className="settings-secret-input" data-clear-pending={clearSaved || undefined}>
        <input
          ref={inputRef}
          id={id}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          placeholder={clearSaved ? t("settings.secretInput.clearOnSave") : placeholder}
          onChange={(event) => onChange(event.target.value, false)}
        />
        <button
          className="settings-icon-button settings-secret-action"
          type="button"
          aria-label={actionLabel}
          title={actionLabel}
          aria-pressed={clearSaved}
          disabled={!configured && !value && !clearSaved}
          onClick={() => {
            onChange("", !clearSaved && configured);
            inputRef.current?.focus();
          }}
        >
          {clearSaved ? <Undo2 aria-hidden="true" size={16} /> : <X aria-hidden="true" size={16} />}
        </button>
      </div>
    </div>
  );
}
