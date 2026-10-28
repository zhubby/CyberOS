import { Plus, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PhotoMediaKind } from "@cyberos/shared/photos-config";
import type {
  PhotoMetadataCondition,
  PhotoQueryFacets,
  PhotoQueryFilters
} from "@cyberos/shared";
import type { PhotoMetadataField } from "../../api.js";
import { CustomSelect } from "../common/CustomSelect.js";

export function PhotoSearchFilterMenu({
  filters,
  facets,
  metadataFields,
  disabled = false,
  onApply
}: {
  filters: PhotoQueryFilters;
  facets: PhotoQueryFacets | null;
  metadataFields: PhotoMetadataField[];
  disabled?: boolean;
  onApply: (filters: PhotoQueryFilters) => void;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PhotoQueryFilters>(filters);
  const active = photoFilterMenuIsActive(filters);

  useEffect(() => {
    if (!open) return undefined;

    function closeOnOutsidePress(event: PointerEvent) {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
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

  function updateFilter<K extends keyof PhotoQueryFilters>(key: K, value: PhotoQueryFilters[K]) {
    setDraft((current) => cleanPhotoFilterValue({ ...current, [key]: value }, key, value));
  }

  function updateAdvancedCondition(index: number, patch: Partial<PhotoMetadataCondition>) {
    const advanced = draft.advanced ?? { mode: "all" as const, conditions: [] };
    updateFilter("advanced", {
      ...advanced,
      conditions: advanced.conditions.map((condition, conditionIndex) => conditionIndex === index
        ? { ...condition, ...patch }
        : condition)
    });
  }

  function addAdvancedCondition() {
    const advanced = draft.advanced ?? { mode: "all" as const, conditions: [] };
    const firstField = metadataFields[0]?.key ?? "exif.ISO";
    updateFilter("advanced", {
      ...advanced,
      conditions: [...advanced.conditions, { key: firstField, operator: "eq", value: "" }]
    });
  }

  function closeAndRestoreFocus() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <div ref={containerRef} className="photo-filter-popover">
      <button
        ref={triggerRef}
        type="button"
        className={`photo-filter-trigger${active ? " is-active" : ""}`}
        aria-label={active ? t("workspace.photos.filtersActive") : t("workspace.photos.filters")}
        title={t("workspace.photos.filters")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!open) setDraft(filters);
          setOpen((current) => !current);
        }}
      >
        <SlidersHorizontal aria-hidden="true" size={15} />
      </button>

      {open ? (
        <div className="photo-filter-menu" role="dialog" aria-label={t("workspace.photos.filters")}>
          <div className="photo-common-filters">
            <PhotoFacetSelect
              label={t("workspace.photos.mediaType")}
              options={facets?.mediaKinds ?? []}
              selected={draft.mediaKinds ?? []}
              allLabel={t("workspace.photos.allValues")}
              selectedLabel={(count) => t("workspace.photos.selectedValues", { count })}
              onChange={(value) => updateFilter("mediaKinds", value as PhotoMediaKind[] | undefined)}
            />
            <PhotoFacetSelect
              label={t("workspace.photos.camera")}
              options={facets?.cameraModels ?? []}
              selected={draft.cameraModels ?? []}
              allLabel={t("workspace.photos.allValues")}
              selectedLabel={(count) => t("workspace.photos.selectedValues", { count })}
              onChange={(value) => updateFilter("cameraModels", value)}
            />
            <PhotoFacetSelect
              label={t("workspace.photos.lens")}
              options={facets?.lensModels ?? []}
              selected={draft.lensModels ?? []}
              allLabel={t("workspace.photos.allValues")}
              selectedLabel={(count) => t("workspace.photos.selectedValues", { count })}
              onChange={(value) => updateFilter("lensModels", value)}
            />
            <label>
              <span>{t("workspace.photos.takenAt")}</span>
              <div className="photo-range-inputs">
                <input type="date" value={draft.capturedAt?.from?.slice(0, 10) ?? ""} aria-label={t("workspace.photos.min")} onChange={(event) => updateFilter("capturedAt", dateRange(event.target.value, draft.capturedAt?.to))} />
                <input type="date" value={draft.capturedAt?.to?.slice(0, 10) ?? ""} aria-label={t("workspace.photos.max")} onChange={(event) => updateFilter("capturedAt", dateRange(draft.capturedAt?.from, event.target.value))} />
              </div>
            </label>
            <NumberRangeFilter label="ISO" min={draft.iso?.min} max={draft.iso?.max} onChange={(value) => updateFilter("iso", value)} />
            <NumberRangeFilter label={t("workspace.photos.aperture")} min={draft.aperture?.min} max={draft.aperture?.max} step="0.1" onChange={(value) => updateFilter("aperture", value)} />
            <NumberRangeFilter label={t("workspace.photos.shutter")} min={draft.exposureTimeSeconds?.min} max={draft.exposureTimeSeconds?.max} step="any" onChange={(value) => updateFilter("exposureTimeSeconds", value)} />
            <NumberRangeFilter label={t("workspace.photos.focalLength")} min={draft.focalLengthMm?.min} max={draft.focalLengthMm?.max} onChange={(value) => updateFilter("focalLengthMm", value)} />
            <label>
              <span>{t("workspace.photos.rating")}</span>
              <CustomSelect
                value={draft.rating?.min?.toString() ?? ""}
                options={[
                  { value: "", label: t("workspace.photos.allValues") },
                  ...[1, 2, 3, 4, 5].map((rating) => ({
                    value: String(rating),
                    label: `${rating}+ (${facets?.ratings.find((item) => Number(item.value) === rating)?.count ?? 0})`
                  }))
                ]}
                onChange={(value) => updateFilter("rating", value ? { min: Number(value) } : undefined)}
                ariaLabel={t("workspace.photos.rating")}
                className="photo-filter-select"
              />
            </label>
            <label className="photo-location-filter">
              <input type="checkbox" checked={draft.hasLocation === true} onChange={(event) => updateFilter("hasLocation", event.target.checked ? true : undefined)} />
              <span>{t("workspace.photos.hasLocation")}</span>
            </label>
          </div>

          {facets?.keywords.length ? (
            <div className="photo-keyword-facets" aria-label={t("workspace.photos.keywords")}>
              {facets.keywords.slice(0, 12).map((item) => {
                const selected = draft.keywords?.includes(item.value) ?? false;
                return (
                  <button key={item.value} type="button" aria-pressed={selected} onClick={() => updateFilter("keywords", selected ? draft.keywords?.filter((value) => value !== item.value) : [...(draft.keywords ?? []), item.value])}>
                    {item.value}<span>{item.count}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="photo-advanced-builder">
            <div className="photo-advanced-heading">
              <div className="photo-condition-mode" role="group" aria-label={t("workspace.photos.conditionMode")}>
                <button type="button" aria-pressed={(draft.advanced?.mode ?? "all") === "all"} onClick={() => updateFilter("advanced", { mode: "all", conditions: draft.advanced?.conditions ?? [] })}>{t("workspace.photos.matchAll")}</button>
                <button type="button" aria-pressed={draft.advanced?.mode === "any"} onClick={() => updateFilter("advanced", { mode: "any", conditions: draft.advanced?.conditions ?? [] })}>{t("workspace.photos.matchAny")}</button>
              </div>
              <button type="button" onClick={addAdvancedCondition} disabled={!metadataFields.length || (draft.advanced?.conditions.length ?? 0) >= 25}>
                <Plus aria-hidden="true" size={14} />{t("workspace.photos.addCondition")}
              </button>
            </div>
            {(draft.advanced?.conditions ?? []).map((condition, index) => (
              <div className="photo-condition-row" key={`${index}:${condition.key}`}>
                <CustomSelect
                  className="photo-condition-field"
                  value={condition.key}
                  options={metadataFields.map((field) => ({ value: field.key, label: `${field.key} (${field.count})` }))}
                  onChange={(value) => updateAdvancedCondition(index, { key: value })}
                  ariaLabel={t("workspace.photos.metadataField")}
                />
                <CustomSelect
                  className="photo-condition-operator"
                  value={condition.operator}
                  options={metadataOperatorOptions(t)}
                  onChange={(value) => updateAdvancedCondition(index, { operator: value })}
                  ariaLabel={t("workspace.photos.operator")}
                />
                {condition.operator !== "exists" && condition.operator !== "not_exists" ? <input className="photo-condition-value" value={String(Array.isArray(condition.value) ? condition.value.join(",") : condition.value ?? "")} onChange={(event) => updateAdvancedCondition(index, { value: condition.operator === "in" ? event.target.value.split(",").map((value) => value.trim()).filter(Boolean) : event.target.value })} aria-label={t("workspace.photos.value")} /> : <span className="photo-condition-value" />}
                {condition.operator === "between" ? <input className="photo-condition-value-to" value={String(condition.valueTo ?? "")} onChange={(event) => updateAdvancedCondition(index, { valueTo: event.target.value })} aria-label={t("workspace.photos.max")} /> : <span className="photo-condition-value-to" />}
                <button type="button" onClick={() => {
                  const remaining = draft.advanced?.conditions.filter((_, conditionIndex) => conditionIndex !== index) ?? [];
                  updateFilter("advanced", remaining.length ? { mode: draft.advanced?.mode ?? "all", conditions: remaining } : undefined);
                }} title={t("workspace.photos.removeCondition")} aria-label={t("workspace.photos.removeCondition")}>
                  <X aria-hidden="true" size={14} />
                </button>
              </div>
            ))}
          </div>

          <div className="photo-filter-actions">
            <button type="button" className="secondary-button" onClick={() => {
              const reset = photoFiltersWithTextOnly(filters);
              setDraft(reset);
              onApply(reset);
              closeAndRestoreFocus();
            }}>{t("workspace.photos.resetFilters")}</button>
            <button type="button" className="primary-button" onClick={() => {
              const next = mergePhotoFilterDraft(draft, filters);
              onApply(next);
              closeAndRestoreFocus();
            }}>{t("workspace.photos.applyFilters")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PhotoFacetSelect({
  label,
  options,
  selected,
  allLabel,
  selectedLabel,
  onChange
}: {
  label: string;
  options: Array<{ value: string; count: number }>;
  selected: string[];
  allLabel: string;
  selectedLabel: (count: number) => string;
  onChange: (value: string[] | undefined) => void;
}) {
  const summary = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? selected[0]!
      : selectedLabel(selected.length);
  return (
    <label className="photo-facet-filter">
      <span>{label}</span>
      <CustomSelect
        value=""
        selectedValues={selected}
        placeholder={summary}
        ariaLabel={`${label}: ${summary}`}
        className="photo-filter-select"
        options={[
          ...(selected.length ? [{ value: "__clear__", label: allLabel }] : []),
          ...options.map((item) => ({ value: item.value, label: `${item.value} (${item.count})` }))
        ]}
        onChange={(value) => {
          if (value === "__clear__") onChange(undefined);
          else if (value) onChange(togglePhotoFacetValue(selected, value));
        }}
      />
    </label>
  );
}

function NumberRangeFilter({
  label,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  min: number | undefined;
  max: number | undefined;
  step?: string;
  onChange: (value: { min?: number; max?: number } | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <label>
      <span>{label}</span>
      <div className="photo-range-inputs">
        <input type="number" min="0" step={step} value={min ?? ""} placeholder={t("workspace.photos.min")} onChange={(event) => onChange(numberRange(event.target.value, max))} />
        <input type="number" min="0" step={step} value={max ?? ""} placeholder={t("workspace.photos.max")} onChange={(event) => onChange(numberRange(min, event.target.value))} />
      </div>
    </label>
  );
}

export function photoFilterMenuIsActive(filters: PhotoQueryFilters): boolean {
  return Object.entries(filters).some(([key, value]) => {
    if (key === "text" || value === undefined || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (key === "advanced") return (value as NonNullable<PhotoQueryFilters["advanced"]>).conditions.length > 0;
    return true;
  });
}

export function photoFiltersWithTextOnly(filters: PhotoQueryFilters): PhotoQueryFilters {
  return filters.text ? { text: filters.text } : {};
}

export function mergePhotoFilterDraft(
  draft: PhotoQueryFilters,
  current: PhotoQueryFilters
): PhotoQueryFilters {
  const { text: _draftText, ...draftFilters } = draft;
  return { ...draftFilters, ...photoFiltersWithTextOnly(current) };
}

export function togglePhotoFacetValue<T extends string>(selected: T[] | undefined, value: T): T[] | undefined {
  const current = selected ?? [];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  return next.length ? next : undefined;
}

function cleanPhotoFilterValue<K extends keyof PhotoQueryFilters>(
  filters: PhotoQueryFilters,
  key: K,
  value: PhotoQueryFilters[K]
): PhotoQueryFilters {
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete filters[key];
  return filters;
}

function numberRange(
  min: string | number | undefined,
  max: string | number | undefined
): { min?: number; max?: number } | undefined {
  const minValue = min === "" || min === undefined ? undefined : Number(min);
  const maxValue = max === "" || max === undefined ? undefined : Number(max);
  if (minValue === undefined && maxValue === undefined) return undefined;
  return {
    ...(minValue !== undefined && Number.isFinite(minValue) ? { min: minValue } : {}),
    ...(maxValue !== undefined && Number.isFinite(maxValue) ? { max: maxValue } : {})
  };
}

function dateRange(
  from: string | undefined,
  to: string | undefined
): { from?: string; to?: string } | undefined {
  const fromDate = from?.slice(0, 10) || undefined;
  const toDate = to?.slice(0, 10) || undefined;
  if (!fromDate && !toDate) return undefined;
  return {
    ...(fromDate ? { from: `${fromDate}T00:00:00` } : {}),
    ...(toDate ? { to: `${toDate}T23:59:59.999` } : {})
  };
}

function metadataOperatorOptions(translate: (key: string) => string): Array<{
  value: PhotoMetadataCondition["operator"];
  label: string;
}> {
  return [
    ["eq", "equals"], ["contains", "contains"], ["prefix", "prefix"], ["in", "oneOf"],
    ["exists", "exists"], ["not_exists", "notExists"], ["lt", "lessThan"],
    ["lte", "lessOrEqual"], ["gt", "greaterThan"], ["gte", "greaterOrEqual"], ["between", "between"]
  ].map(([value, label]) => ({
    value: value as PhotoMetadataCondition["operator"],
    label: translate(`workspace.photos.operators.${label}`)
  }));
}
